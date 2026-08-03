import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { UrlElicitationRequiredError, type CallToolResult } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import {
  createUiModelContextUpdate,
  extractUiPromptText,
  UI_STREAM_HOST_CONTEXT_KEY,
  UI_STREAM_REQUEST_META_KEY,
  UI_STREAM_STRUCTURED_CONTENT_KEY,
  type UiHostContext,
  type UiMessageParams,
  type UiModelContextParams,
  type UiStreamMode,
} from "./types.ts";
import { logger } from "./logger.ts";
import { startUiServer, type UiServerHandle } from "./ui-server.ts";
import { isGlimpseAvailable, openGlimpseWindow } from "./glimpse-ui.ts";
import type { SessionRecoveryDeps } from "./session-recovery.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { throwIfAborted } from "./abort.ts";

let activeGlimpseWindow: { close(): void } | null = null;

export interface UiSessionRequest {
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  uiResourceUri: string;
  streamMode?: UiStreamMode;
  signal?: AbortSignal;
  onNeedsAuth?: SessionRecoveryDeps["onNeedsAuth"];
}

export type UiSessionViewer = "browser" | "glimpse" | "suppressed";

export interface UiSessionRuntime {
  serverName: string;
  toolName: string;
  reused: boolean;
  streamId?: string;
  streamToken?: string;
  streamMode?: UiStreamMode;
  requestMeta?: Record<string, unknown>;
  url: string;
  viewer: UiSessionViewer;
  windowOpen: boolean;
  isActive: () => boolean;
  sendToolResult: (result: CallToolResult) => void;
  sendResultPatch: (result: CallToolResult) => void;
  sendToolCancelled: (reason: string) => void;
  close: (reason?: string) => void;
}

export interface UiSessionResultSummary {
  message: string;
  uiOpen: boolean;
  uiViewer?: UiSessionViewer;
  uiUrl?: string;
}

export function summarizeUiSessionResult(uiSession: UiSessionRuntime | null): UiSessionResultSummary {
  if (!uiSession) {
    return {
      message: "Interactive UI was unavailable; returning the tool result inline.",
      uiOpen: false,
    };
  }

  if (!uiSession.windowOpen) {
    const action = uiSession.reused ? "Updated the suppressed MCP UI session." : "MCP UI window was suppressed.";
    return {
      message: `${action} Open manually: ${uiSession.url}`,
      uiOpen: false,
      uiViewer: uiSession.viewer,
      uiUrl: uiSession.url,
    };
  }

  return {
    message: uiSession.reused
      ? "Updated the open UI."
      : "Interactive UI is open. I'll respond to your prompts and intents as you interact with it.",
    uiOpen: true,
    uiViewer: uiSession.viewer,
    uiUrl: uiSession.url,
  };
}

const MAX_COMPLETED_SESSIONS = 10;

function withStreamEnvelope(
  result: CallToolResult,
  streamId: string | undefined,
  sequence: number,
): CallToolResult {
  if (!streamId) {
    return result;
  }

  const structuredContent: Record<string, unknown> = result.structuredContent
    && typeof result.structuredContent === "object"
    && !Array.isArray(result.structuredContent)
    ? { ...(result.structuredContent as Record<string, unknown>) }
    : {};

  const rawEnvelope = structuredContent[UI_STREAM_STRUCTURED_CONTENT_KEY];
  const envelope = rawEnvelope && typeof rawEnvelope === "object" && !Array.isArray(rawEnvelope)
    ? { ...rawEnvelope as Record<string, unknown> }
    : {
        frameType: "final",
        phase: "settled",
        status: result.isError ? "error" : "ok",
      };

  structuredContent[UI_STREAM_STRUCTURED_CONTENT_KEY] = {
    ...envelope,
    streamId,
    sequence,
  };

  return {
    ...result,
    structuredContent,
  };
}

async function openInBrowser(state: McpExtensionState, url: string, signal: AbortSignal): Promise<string | null> {
  throwIfAborted(signal);
  try {
    await state.openBrowser(url);
    throwIfAborted(signal);
    return null;
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (state.owner?.isActive() === false) return null;
    state.ui?.notify(`MCP UI browser open failed: ${message}`, "warning");
    return message;
  }
}

function isRemoteSession(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
}

function hasActiveRemoteLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("who", { encoding: "utf8", timeout: 2000 }, (error, out) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(/\(.+\)\s*$/m.test(out));
    });
  });
}

function probeMoshiGateway(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 24543 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function remoteAccessHint(opts: { url: string; port: number; moshi: boolean; openError: string | null; openedOnHost?: boolean }): string {
  const lines = [
    opts.openError !== null
      ? "Couldn't open MCP UI here. Open it from your own device:"
      : opts.openedOnHost
        ? "MCP UI opened on this host. If you're controlling this session remotely, open it from your own device:"
        : "This looks like a remote session - if no MCP UI appeared, open it from your own device:",
    `  ${opts.url}`,
  ];
  if (opts.openError !== null) {
    lines.push(`Browser launch failed: ${opts.openError}`);
  }
  if (opts.moshi) {
    lines.push("Moshi: tap the preview button in the terminal title bar and pick this MCP UI server.");
  }
  lines.push(
    `SSH: run \`ssh -L ${opts.port}:127.0.0.1:${opts.port} <this-host>\` on your local machine, then open the URL above.`,
    "mosh can't forward ports - run that ssh command in a separate terminal.",
  );
  return lines.join("\n");
}

export async function maybeStartUiSession(
  state: McpExtensionState,
  request: UiSessionRequest,
): Promise<UiSessionRuntime | null> {
  const log = logger.child({
    component: "UiSession",
    server: request.serverName,
    tool: request.toolName,
  });
  const runtimeSignal = combineAbortSignals(state.owner?.signal, request.signal) ?? new AbortController().signal;

  try {
    throwIfAborted(runtimeSignal);
    if (
      state.uiServer &&
      state.uiServer.serverName === request.serverName &&
      state.uiServer.toolName === request.toolName
    ) {
      const existingHandle = state.uiServer;
      const streamMode = request.streamMode;
      const streamId = streamMode ? randomUUID() : undefined;
      const streamToken = streamMode ? randomUUID() : undefined;
      let active = true;
      let nextStreamSequence = 0;

      const cleanupStreamListener = () => {
        if (streamToken) {
          state.manager.removeUiStreamListener(streamToken);
        }
      };

      existingHandle.sendToolInput(request.toolArgs);

      if (streamToken) {
        state.manager.registerUiStreamListener(streamToken, (serverName, notification) => {
          if (!active || state.uiServer !== existingHandle) return;
          if (serverName !== request.serverName) return;
          nextStreamSequence += 1;
          existingHandle.sendResultPatch(
            withStreamEnvelope(notification.result as CallToolResult, streamId, nextStreamSequence),
          );
        });
      }

      return {
        serverName: request.serverName,
        toolName: request.toolName,
        reused: true,
        ...(streamId !== undefined ? { streamId } : {}),
        ...(streamToken !== undefined ? { streamToken } : {}),
        ...(streamMode !== undefined ? { streamMode } : {}),
        ...(streamToken ? { requestMeta: { [UI_STREAM_REQUEST_META_KEY]: streamToken } } : {}),
        url: existingHandle.url,
        viewer: existingHandle.viewer ?? "browser",
        windowOpen: existingHandle.windowOpen ?? true,
        isActive: () => active && state.uiServer === existingHandle,
        sendToolResult: (result: CallToolResult) => {
          if (!active || state.uiServer !== existingHandle) return;
          nextStreamSequence += 1;
          existingHandle.sendToolResult(withStreamEnvelope(result, streamId, nextStreamSequence));
        },
        sendResultPatch: (result: CallToolResult) => {
          if (!active || state.uiServer !== existingHandle) return;
          nextStreamSequence += 1;
          existingHandle.sendResultPatch(withStreamEnvelope(result, streamId, nextStreamSequence));
        },
        sendToolCancelled: (reason: string) => {
          if (!active || state.uiServer !== existingHandle) return;
          nextStreamSequence += 1;
          existingHandle.sendToolResult(
            withStreamEnvelope(
              {
                isError: true,
                content: [{ type: "text", text: reason }],
              },
              streamId,
              nextStreamSequence,
            ),
          );
        },
        close: () => {
          active = false;
          cleanupStreamListener();
        },
      };
    }

    const resource = await state.uiResourceHandler.readUiResource(request.serverName, request.uiResourceUri, {
      config: state.config,
      signal: runtimeSignal,
      onNeedsAuth: request.onNeedsAuth,
    });
    throwIfAborted(runtimeSignal);

    if (state.uiServer) {
      state.uiServer.close("replaced");
      state.uiServer = null;
    }
    if (activeGlimpseWindow) {
      activeGlimpseWindow.close();
      activeGlimpseWindow = null;
    }

    const streamMode = request.streamMode;
    const streamId = streamMode ? randomUUID() : undefined;
    const streamToken = streamMode ? randomUUID() : undefined;
    const hostContext: UiHostContext | undefined = streamMode && streamId
      ? {
          [UI_STREAM_HOST_CONTEXT_KEY]: {
            mode: streamMode,
            streamId,
            intermediateResultPatches: streamMode === "stream-first",
            partialInput: false,
          },
        }
      : undefined;

    let active = true;
    let nextStreamSequence = 0;
    let handle: UiServerHandle;

    const cleanupStreamListener = () => {
      if (streamToken) {
        state.manager.removeUiStreamListener(streamToken);
      }
    };

    handle = await startUiServer({
      serverName: request.serverName,
      toolName: request.toolName,
      toolArgs: streamMode === "stream-first" ? {} : request.toolArgs,
      resource,
      manager: state.manager,
      config: state.config,
      state,
      ...(request.onNeedsAuth ? { onNeedsAuth: request.onNeedsAuth } : {}),
      consentManager: state.consentManager,
      ...(hostContext !== undefined ? { hostContext } : {}),

      onMessage: (params: UiMessageParams) => {
        const prompt = extractUiPromptText(params);
        if (prompt) {
          if (state.sendMessage) {
            state.sendMessage(
              {
                customType: "mcp-ui-prompt",
                content: [{ type: "text", text: `User sent prompt from ${request.serverName} UI: "${prompt}"` }],
                display: `💬 UI Prompt: ${prompt}`,
                details: { server: request.serverName, tool: request.toolName, prompt },
              },
              { triggerTurn: true },
            );
            log.debug("Triggered agent turn for UI prompt", { prompt: prompt.slice(0, 50) });
          }
        } else if (params.type === "intent" || params.intent) {
          const intent = params.intent ?? "";
          const intentParams = params.params;
          if (intent && state.sendMessage) {
            const paramsStr = intentParams ? ` ${JSON.stringify(intentParams)}` : "";
            state.sendMessage(
              {
                customType: "mcp-ui-intent",
                content: [{ type: "text", text: `User triggered intent from ${request.serverName} UI: ${intent}${paramsStr}` }],
                display: `🎯 UI Intent: ${intent}`,
                details: { server: request.serverName, tool: request.toolName, intent, params: intentParams },
              },
              { triggerTurn: true },
            );
            log.debug("Triggered agent turn for UI intent", { intent });
          }
        } else if (params.type === "notify" || params.message) {
          const text = params.message ?? "";
          if (text && state.ui) {
            state.ui.notify(`[${request.serverName}] ${text}`, "info");
          }
        }
      },

      onContextUpdate: (params: UiModelContextParams) => {
        const update = createUiModelContextUpdate(params);
        log.debug("Model context update from UI", {
          hasContent: !!params.content,
          hasStructured: !!params.structuredContent,
          hasUpdate: !!update,
        });
        if (update && state.sendMessage) {
          state.sendMessage(
            {
              customType: "mcp-ui-context",
              content: [{ type: "text", text: `User submitted model context from ${request.serverName} UI:\n${update.summary}` }],
              display: "UI Context submitted",
              details: { server: request.serverName, tool: request.toolName, context: update },
            },
            { triggerTurn: true },
          );
        }
      },

      onComplete: (reason: string) => {
        active = false;
        cleanupStreamListener();

        if (state.uiServer === handle) {
          const messages = handle.getSessionMessages();
          const stream = handle.getStreamSummary();
          const hasContent =
            messages.prompts.length > 0 ||
            messages.intents.length > 0 ||
            messages.notifications.length > 0 ||
            messages.contexts.length > 0 ||
            !!stream;

          if (hasContent) {
            state.completedUiSessions.push({
              serverName: handle.serverName,
              toolName: handle.toolName,
              completedAt: new Date(),
              reason,
              messages,
              ...(stream !== undefined ? { stream } : {}),
            });

            while (state.completedUiSessions.length > MAX_COMPLETED_SESSIONS) {
              state.completedUiSessions.shift();
            }

            log.debug("Session completed", {
              reason,
              prompts: messages.prompts.length,
              intents: messages.intents.length,
              notifications: messages.notifications.length,
              contexts: messages.contexts.length,
              streamFrames: stream?.frames ?? 0,
            });
          }

          state.uiServer = null;
          if (activeGlimpseWindow) {
            activeGlimpseWindow.close();
            activeGlimpseWindow = null;
          }
        }
      },
    });

    if (state.owner?.isActive() === false || runtimeSignal.aborted) {
      handle.close("runtime_owner_stopped");
      throwIfAborted(runtimeSignal);
      throw new Error("MCP UI session became stale before registration");
    }

    if (streamToken) {
      state.manager.registerUiStreamListener(streamToken, (serverName, notification) => {
        if (!active || state.uiServer !== handle) return;
        if (serverName !== request.serverName) return;
        nextStreamSequence += 1;
        handle.sendResultPatch(withStreamEnvelope(notification.result as CallToolResult, streamId, nextStreamSequence));
      });
    }

    state.uiServer = handle;

    const viewerPref = process.env.MCP_UI_VIEWER?.toLowerCase();
    const uiSuppressed = viewerPref === "none" || viewerPref === "off" || viewerPref === "disabled";

    let viewer: UiSessionViewer = "browser";
    let windowOpen = true;
    const remoteByEnv = isRemoteSession();

    if (uiSuppressed) {
      viewer = "suppressed";
      windowOpen = false;
      state.ui?.notify(`MCP UI window suppressed (MCP_UI_VIEWER=${viewerPref}). Open manually: ${handle.url}`, "info");
      log.info("Suppressing MCP UI window (MCP_UI_VIEWER=" + viewerPref + ")", { url: handle.url });
    } else {
      const remoteLikely = remoteByEnv || await hasActiveRemoteLogin();
      const emitRemoteHint = async (openError: string | null, openedOnHost = false) => {
        state.ui?.notify(remoteAccessHint({
          url: handle.url,
          port: handle.port,
          moshi: await probeMoshiGateway(),
          openError,
          openedOnHost,
        }), openError === null ? "info" : "warning");
      };
      const glimpseDetected = !remoteByEnv && isGlimpseAvailable();
      const useGlimpse = !remoteByEnv && (viewerPref === "glimpse" ||
        (viewerPref !== "browser" && glimpseDetected));

      if (useGlimpse) {
        try {
          const glimpseHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:0;width:100vw;height:100vh;overflow:hidden}iframe{width:100%;height:100%;border:none}</style></head><body><iframe src="${handle.url}"></iframe></body></html>`;
          const glimpseWindow = await openGlimpseWindow(glimpseHtml, {
            title: `MCP · ${request.serverName} · ${request.toolName}`,
            width: 1000,
            height: 800,
            onClosed: () => {
              if (active) handle.close("glimpse-closed");
            },
          });
          if (state.owner?.isActive() === false || runtimeSignal.aborted) {
            glimpseWindow.close();
            throwIfAborted(runtimeSignal);
            throw new Error("MCP Glimpse window became stale before registration");
          }
          activeGlimpseWindow = glimpseWindow;
          viewer = "glimpse";
          if (remoteLikely) {
            await emitRemoteHint(null, true);
          }
        } catch (error) {
          log.debug("Glimpse unavailable, using browser", {
            error: error instanceof Error ? error.message : String(error),
          });
          const openError = await openInBrowser(state, handle.url, runtimeSignal);
          if (openError !== null || remoteLikely) {
            await emitRemoteHint(openError);
          }
          viewer = "browser";
        }
      } else {
        const openError = await openInBrowser(state, handle.url, runtimeSignal);
        if (openError !== null || remoteLikely) {
          await emitRemoteHint(openError);
        }
      }
    }

    throwIfAborted(runtimeSignal);
    handle.viewer = viewer;
    handle.windowOpen = windowOpen;

    return {
      serverName: request.serverName,
      toolName: request.toolName,
      reused: false,
      ...(streamId !== undefined ? { streamId } : {}),
      ...(streamToken !== undefined ? { streamToken } : {}),
      ...(streamMode !== undefined ? { streamMode } : {}),
      ...(streamToken ? { requestMeta: { [UI_STREAM_REQUEST_META_KEY]: streamToken } } : {}),
      url: handle.url,
      viewer,
      windowOpen,
      isActive: () => active && state.uiServer === handle,
      sendToolResult: (result: CallToolResult) => {
        if (!active || state.uiServer !== handle) return;
        nextStreamSequence += 1;
        handle.sendToolResult(withStreamEnvelope(result, streamId, nextStreamSequence));
      },
      sendResultPatch: (result: CallToolResult) => {
        if (!active || state.uiServer !== handle) return;
        nextStreamSequence += 1;
        handle.sendResultPatch(withStreamEnvelope(result, streamId, nextStreamSequence));
      },
      sendToolCancelled: (reason: string) => {
        if (!active || state.uiServer !== handle) return;
        handle.sendToolCancelled(reason);
      },
      close: (reason?: string) => {
        active = false;
        cleanupStreamListener();
        handle.close(reason);
      },
    };
  } catch (error) {
    if (error instanceof UrlElicitationRequiredError || isAbortError(error, runtimeSignal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    log.error("Failed to start UI session", error instanceof Error ? error : undefined);
    state.ui?.notify(
      `MCP UI unavailable for ${request.toolName} (${request.serverName}): ${message}`,
      "warning",
    );
    return null;
  }
}
