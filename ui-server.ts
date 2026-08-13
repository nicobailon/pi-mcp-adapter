import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildAllowAttribute } from "./ui-app-bridge-helpers.ts";
import {
  type CallToolRequest,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { ContentBlockSchema } from "@modelcontextprotocol/core";
import type { ConsentManager } from "./consent-manager.ts";
import { ServerError, wrapError } from "./errors.ts";
import { formatAuthRequiredMessage } from "./utils.ts";
import { buildHostHtmlTemplate, buildCspMetaContent } from "./host-html-template.ts";
import { logger } from "./logger.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { McpExtensionState } from "./state.ts";
import { SessionRecoveryAuthRequiredError, withSessionRecovery, type SessionRecoveryDeps } from "./session-recovery.ts";
import { ensureToolCallApproved, isToolCallApprovalRequired } from "./tool-approval.ts";
import { extractUiToolVisibility, isUiToolCallableByApp, isUiToolVisibleToModel } from "./ui-tool-visibility.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import {
  createUiModelContextUpdate,
  extractUiPromptText,
  getVisualizationStreamEnvelope,
  isServerDisabled,
  type McpConfig,
  type UiDisplayMode,
  type UiDisplayModeRequest,
  type UiDisplayModeResult,
  type UiHostContext,
  type UiMessageParams,
  type UiModelContextParams,
  type UiOpenLinkResult,
  type UiProxyRequestBody,
  type UiProxyResult,
  type UiResourceContent,
  type UiSessionMessages,
  type UiStreamSummary,
} from "./types.ts";

const MAX_BODY_SIZE = 2 * 1024 * 1024;
const ABANDONED_GRACE_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const MAX_EVENT_LOG = 128;
const MAX_CONTEXT_UPDATES = 20;
const MOSHI_DISCOVERY_PORT_START = 8377;
const MOSHI_DISCOVERY_PORT_END = 8396;
let nextMoshiDiscoveryPort = MOSHI_DISCOVERY_PORT_START;

export interface UiServerOptions {
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resource: UiResourceContent;
  manager: McpServerManager;
  /**
   * Live extension config, used to re-read the server definition when
   * recovering a terminated Streamable HTTP session (see
   * session-recovery.ts). Optional so existing embedders/tests that don't
   * need session recovery aren't forced to supply it; without it, proxied
   * tool calls run without recovery (unchanged pre-existing behavior).
   */
  config?: McpConfig;
  /** Live state enables TUI approval prompts for iframe-originated tool calls. */
  state?: McpExtensionState;
  onNeedsAuth?: SessionRecoveryDeps["onNeedsAuth"];
  consentManager: ConsentManager;
  hostContext?: UiHostContext;
  initialResultPromise?: Promise<CallToolResult>;
  sessionToken?: string;
  port?: number;
  onMessage?: (params: UiMessageParams) => Promise<void> | void;
  onContextUpdate?: (params: UiModelContextParams) => Promise<void> | void;
  onComplete?: (reason: string) => void;
}

export interface UiServerHandle {
  url: string;
  port: number;
  sessionToken: string;
  serverName: string;
  toolName: string;
  viewer?: "browser" | "glimpse" | "suppressed";
  windowOpen?: boolean;
  close: (reason?: string) => void;
  sendToolInput: (args: Record<string, unknown>) => void;
  sendToolResult: (result: CallToolResult) => void;
  sendResultPatch: (result: CallToolResult) => void;
  sendToolCancelled: (reason: string) => void;
  sendHostContext: (context: UiHostContext) => void;
  /** Get accumulated messages from this session */
  getSessionMessages: () => UiSessionMessages;
  getStreamSummary: () => UiStreamSummary | undefined;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const sessionToken = options.sessionToken ?? randomUUID();
  const uiResourceToken = randomUUID();
  const log = logger.child({ 
    component: "UiServer",
    server: options.serverName,
    tool: options.toolName,
    session: sessionToken.slice(0, 8),
  });

  log.debug("Starting UI server");

  const sseClients = new Set<ServerResponse>();
  let completed = false;
  let lastHeartbeatAt = Date.now();
  let watchdog: NodeJS.Timeout | null = null;
  let currentDisplayMode: UiDisplayMode = options.hostContext?.displayMode ?? "inline";
  let nextEventId = 1;
  const eventLog: Array<{ id: number; name: string; payload: unknown }> = [];
  let streamSummary: UiStreamSummary | undefined;

  // Track messages from UI for retrieval
  const sessionMessages: UiSessionMessages = {
    prompts: [],
    notifications: [],
    intents: [],
    contexts: [],
  };

  const hostContext: UiHostContext = {
    displayMode: currentDisplayMode,
    availableDisplayModes: ["inline", "fullscreen", "pip"],
    platform: "desktop",
    ...options.hostContext,
    // Only include toolInfo if caller provides full tool definition with inputSchema
    // The App validates toolInfo.tool.inputSchema as required object
  };

  const initialStreamContext = hostContext["pi-mcp-adapter/stream"];
  if (initialStreamContext && typeof initialStreamContext === "object") {
    const streamId = (initialStreamContext as { streamId?: unknown }).streamId;
    const mode = (initialStreamContext as { mode?: unknown }).mode;
    if (typeof streamId === "string" && (mode === "eager" || mode === "stream-first")) {
      streamSummary = {
        streamId,
        mode,
        frames: 0,
        phases: [],
      };
    }
  }

  const isAppOnlyTool = (toolName: string): boolean => {
    const toolDefinition = options.manager.getConnection(options.serverName)?.tools?.find((tool) => tool.name === toolName);
    if (!toolDefinition) return false;
    const visibility = extractUiToolVisibility(toolDefinition._meta);
    return isUiToolCallableByApp(visibility) && !isUiToolVisibleToModel(visibility);
  };

  const recordUiMessage = async (msgParams: UiMessageParams): Promise<void> => {
    const promptText = extractUiPromptText(msgParams);

    // Track messages by type (order: prompt → intent → notify)
    // Must match the order in index.ts onMessage handler
    if (promptText) {
      sessionMessages.prompts.push(promptText);
      log.debug("UI prompt received", { prompt: promptText.slice(0, 100) });
    } else if (msgParams.type === "intent" || msgParams.intent) {
      const intentName = msgParams.intent ?? "";
      if (intentName) {
        sessionMessages.intents.push({
          intent: intentName,
          ...(msgParams.params !== undefined ? { params: msgParams.params } : {}),
        });
        log.debug("UI intent received", { intent: intentName });
      }
    } else if (msgParams.type === "notify" || msgParams.message) {
      const notifyText = msgParams.message ?? "";
      if (notifyText) {
        sessionMessages.notifications.push(notifyText);
        log.debug("UI notification", { message: notifyText.slice(0, 100) });
      }
    }

    await options.onMessage?.(msgParams);
  };

  const touchHeartbeat = () => {
    lastHeartbeatAt = Date.now();
  };

  const updateStreamSummary = (payload: unknown) => {
    const envelope = getVisualizationStreamEnvelope((payload as { structuredContent?: unknown } | null)?.structuredContent);
    if (!envelope) return;
    if (!streamSummary) {
      streamSummary = {
        streamId: envelope.streamId,
        mode: "eager",
        frames: 0,
        phases: [],
      };
    }
    streamSummary.frames += 1;
    if (!streamSummary.phases.includes(envelope.phase)) {
      streamSummary.phases.push(envelope.phase);
    }
    streamSummary.finalStatus = envelope.status;
    if (envelope.message !== undefined) streamSummary.lastMessage = envelope.message;
    else delete streamSummary.lastMessage;
  };

  const serializeEvent = (eventId: number, name: string, payload: unknown): string => {
    return `id: ${eventId}\nevent: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  };

  const getLatestCheckpointIndex = () => {
    for (let index = eventLog.length - 1; index >= 0; index -= 1) {
      const entry = eventLog[index];
      if (!entry) continue;
      const envelope = getVisualizationStreamEnvelope((entry.payload as { structuredContent?: unknown } | null)?.structuredContent);
      if (envelope?.frameType === "checkpoint" || envelope?.frameType === "final") {
        return index;
      }
    }
    return -1;
  };

  const pruneEventLog = () => {
    if (eventLog.length <= MAX_EVENT_LOG) return;
    const latestCheckpointIndex = getLatestCheckpointIndex();

    if (latestCheckpointIndex > 0) {
      eventLog.splice(0, latestCheckpointIndex);
    }

    if (eventLog.length > MAX_EVENT_LOG) {
      eventLog.splice(0, eventLog.length - MAX_EVENT_LOG);
    }
  };

  const pushEvent = (name: string, payload: unknown) => {
    if (completed) return;
    const eventId = nextEventId++;
    eventLog.push({ id: eventId, name, payload });
    updateStreamSummary(payload);
    pruneEventLog();
    const chunk = serializeEvent(eventId, name, payload);
    for (const client of sseClients) {
      try {
        client.write(chunk);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const replayEvents = (res: ServerResponse, lastEventIdHeader?: string | null) => {
    const parsedLastId = lastEventIdHeader ? Number(lastEventIdHeader) : Number.NaN;
    const eventsToReplay = Number.isFinite(parsedLastId)
      ? eventLog.filter((entry) => entry.id > parsedLastId)
      : (() => {
          const latestCheckpointIndex = getLatestCheckpointIndex();
          return latestCheckpointIndex >= 0 ? eventLog.slice(latestCheckpointIndex) : eventLog;
        })();

    for (const entry of eventsToReplay) {
      try {
        res.write(serializeEvent(entry.id, entry.name, entry.payload));
      } catch {
        sseClients.delete(res);
        return;
      }
    }
  };

  const closeSse = () => {
    for (const client of sseClients) {
      try {
        client.end();
      } catch {}
    }
    sseClients.clear();
  };

  const stopWatchdog = () => {
    if (!watchdog) return;
    clearInterval(watchdog);
    watchdog = null;
  };

  const markCompleted = (reason: string) => {
    if (completed) return;
    log.debug("Session completed", { reason });
    pushEvent("session-complete", { reason });
    completed = true;
    stopWatchdog();
    options.onComplete?.(reason);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const hostHeader = req.headers.host;
      const url = new URL(req.url || "/", `http://${hostHeader || "127.0.0.1"}`);
      if (hostHeader !== undefined && !isAllowedHost(url.hostname)) {
        sendText(res, 403, "Invalid host");
        return;
      }

      if (method === "HEAD" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end();
        return;
      }

      if (method === "GET" && url.pathname === "/") {
        if (!url.searchParams.has("session")) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          res.end(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>MCP UI</title></head>" +
              "<body><p>Open the authenticated MCP UI URL shown by Pi.</p></body></html>",
          );
          return;
        }
        if (!validateTokenQuery(url, sessionToken, res)) return;
        touchHeartbeat();

        const html = buildHostHtmlTemplate({
          sessionToken,
          uiResourceToken,
          serverName: options.serverName,
          toolName: options.toolName,
          toolArgs: options.toolArgs,
          resource: options.resource,
          allowAttribute: buildAllowAttribute(options.resource.meta.permissions),
          requireToolConsent: options.consentManager.requiresPrompt(options.serverName),
          cacheToolConsent: options.consentManager.shouldCacheConsent(),
          hostContext,
        });

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      if (method === "GET" && url.pathname === "/events") {
        if (!validateTokenQuery(url, sessionToken, res)) return;
        touchHeartbeat();
        log.debug("SSE client connected", { clientCount: sseClients.size + 1 });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        sseClients.add(res);
        replayEvents(res, req.headers["last-event-id"] ? String(req.headers["last-event-id"]) : null);
        req.on("close", () => {
          sseClients.delete(res);
        });
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        if (!validateTokenQuery(url, sessionToken, res)) return;
        sendJson(res, 200, { ok: true, result: { healthy: true } });
        return;
      }

      if (method === "GET" && url.pathname === "/ui-app") {
        if (!validateTokenQuery(url, uiResourceToken, res, "resource")) return;
        touchHeartbeat();
        // Enforce host metadata independently of where app HTML places its document head.
        const cspContent = buildCspMetaContent(options.resource.meta.csp);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": cspContent,
        });
        res.end(options.resource.html);
        return;
      }

      if (method === "GET" && url.pathname === "/app-bridge.bundle.js") {
        // Serve the pre-bundled AppBridge module
        const bundlePath = path.join(import.meta.dirname, "app-bridge.bundle.js");
        try {
          const content = await fs.readFile(bundlePath, "utf-8");
          res.writeHead(200, {
            "Content-Type": "application/javascript",
            "Cache-Control": "public, max-age=31536000",
          });
          res.end(content);
        } catch {
          sendJson(res, 500, { ok: false, error: "Bundle not found" });
        }
        return;
      }

      if (method !== "POST") {
        sendJson(res, 404, { ok: false, error: "Not found" });
        return;
      }

      const body = await parseBody(req, res);
      if (!body) return;
      if (!validateTokenBody(body, sessionToken, res)) return;
      const params = body.params ?? {};
      touchHeartbeat();

      if (url.pathname === "/proxy/tools/call") {
        options.consentManager.ensureApproved(options.serverName);
        const callParams = params as CallToolRequest["params"];
        if (!callParams || typeof callParams.name !== "string" || !callParams.name.trim()) {
          sendJson(res, 400, { ok: false, error: "Invalid tools/call params" });
          return;
        }

        const connection = options.manager.getConnection(options.serverName);
        if (!connection || connection.status !== "connected") {
          sendJson(res, 503, { ok: false, error: `Server "${options.serverName}" is not connected` });
          return;
        }
        if (isServerDisabled(options.config?.mcpServers[options.serverName]) || isServerDisabled(connection.definition)) {
          sendJson(res, 503, { ok: false, error: `Server "${options.serverName}" is disabled` });
          return;
        }

        const toolDefinitions = Array.isArray(connection.tools) ? connection.tools : [];
        const toolDefinition = toolDefinitions.find((tool) => tool.name === callParams.name);
        if (!toolDefinition) {
          sendJson(res, 403, { ok: false, error: `MCP tool "${callParams.name}" is not callable by apps` });
          return;
        }
        const uiVisibility = extractUiToolVisibility(toolDefinition._meta);
        if (!isUiToolCallableByApp(uiVisibility)) {
          sendJson(res, 403, { ok: false, error: `MCP tool "${callParams.name}" is not callable by apps` });
          return;
        }

        const callArgs = {
          name: callParams.name,
          arguments:
            callParams.arguments && typeof callParams.arguments === "object" && !Array.isArray(callParams.arguments)
              ? callParams.arguments
              : {},
        };
        const toolMeta = {
          name: callParams.name,
          originalName: callParams.name,
          description: toolDefinition?.description ?? "",
          ...(toolDefinition?.inputSchema !== undefined ? { inputSchema: toolDefinition.inputSchema } : {}),
          ...(uiVisibility !== undefined ? { uiVisibility } : {}),
        };
        const approvalMetadata = new Map(options.state?.toolMetadata);
        const definition = options.config?.mcpServers[options.serverName] ?? options.state?.config.mcpServers[options.serverName];
        approvalMetadata.set(options.serverName, [
          ...connection.tools.map(tool => ({
            name: tool.name,
            originalName: tool.name,
            description: tool.description ?? "",
          })),
          ...(definition?.exposeResources !== false ? (connection.resources ?? []).map(resource => {
            const originalName = `read_${resourceNameToToolName(resource.name)}`;
            return {
              name: originalName,
              originalName,
              description: resource.description ?? `Read resource: ${resource.uri}`,
            };
          }) : []),
        ]);
        const approval = options.state
          ? await ensureToolCallApproved(
              options.state,
              options.serverName,
              toolMeta,
              callArgs.arguments,
              options.state.owner?.signal,
              "iframe",
              approvalMetadata,
            )
          : options.config && isToolCallApprovalRequired(options.config, options.serverName, toolMeta, approvalMetadata)
            ? { ok: false as const, reason: "approval_required_headless" as const }
            : { ok: true as const };
        if (approval.ok === false) {
          const denied = approval.reason === "denied";
          const message = denied
            ? `The user declined approval to run MCP tool "${callParams.name}" on server "${options.serverName}".`
            : `MCP tool "${callParams.name}" on server "${options.serverName}" is approval-gated and requires an interactive session.`;
          sendJson(res, 200, {
            ok: true,
            result: {
              content: [{ type: "text" as const, text: message }],
              details: {
                error: denied ? "approval_denied" : "approval_required",
                server: options.serverName,
                tool: callParams.name,
              },
            },
          });
          return;
        }

        try {
          options.manager.touch(options.serverName);
          options.manager.incrementInFlight(options.serverName);
          const result = options.config
            ? await withSessionRecovery(
                {
                  manager: options.manager,
                  config: options.config,
                  ...(options.onNeedsAuth ? { onNeedsAuth: options.onNeedsAuth } : {}),
                },
                options.serverName,
                (conn) => conn.client.callTool(callArgs, options.manager.getRequestOptions?.(options.serverName)),
              )
            : await connection.client.callTool(callArgs, options.manager.getRequestOptions?.(options.serverName));
          sendJson(res, 200, { ok: true, result });
        } finally {
          options.manager.decrementInFlight(options.serverName);
          options.manager.touch(options.serverName);
        }
        return;
      }

      if (url.pathname === "/proxy/ui/consent") {
        const approved = !!(params as { approved?: boolean }).approved;
        options.consentManager.registerDecision(options.serverName, approved);
        sendJson(res, 200, { ok: true, result: { approved } });
        return;
      }

      if (url.pathname === "/proxy/ui/generated-tool-call-intent") {
        const tool = typeof params.tool === "string" ? params.tool : undefined;
        if (tool && isAppOnlyTool(tool)) {
          log.debug("Ignored generated app-only tool call intent", { tool });
        } else {
          await recordUiMessage({
            type: "intent",
            intent: "call_tool",
            params: {
              ...(tool !== undefined ? { tool } : {}),
              ...(params.arguments !== undefined ? { arguments: params.arguments } : {}),
              ...(params.isError !== undefined ? { isError: params.isError } : {}),
            },
          });
        }
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }

      if (url.pathname === "/proxy/ui/message") {
        await recordUiMessage(params as UiMessageParams);
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }

      if (url.pathname === "/proxy/ui/context") {
        const content = params.content;
        const structuredContent = params.structuredContent;
        if (
          (content !== undefined && (!Array.isArray(content) || content.some((block) => !ContentBlockSchema.safeParse(block).success))) ||
          (structuredContent !== undefined && (!structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent)))
        ) {
          sendJson(res, 400, { ok: false, error: "Invalid update-model-context params" });
          return;
        }
        const ctxParams: UiModelContextParams = {
          ...(content !== undefined ? { content: content as NonNullable<UiModelContextParams["content"]> } : {}),
          ...(structuredContent !== undefined ? { structuredContent: structuredContent as Record<string, unknown> } : {}),
        };
        const update = createUiModelContextUpdate(ctxParams);
        if (update) {
          sessionMessages.contexts.push(update);
          while (sessionMessages.contexts.length > MAX_CONTEXT_UPDATES) {
            sessionMessages.contexts.shift();
          }
        }
        log.debug("UI context update", { hasContent: !!ctxParams.content, hasUpdate: !!update });
        await options.onContextUpdate?.(ctxParams);
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }

      if (url.pathname === "/proxy/ui/open-link") {
        const openParams = params as { url?: string };
        if (!openParams?.url || typeof openParams.url !== "string") {
          sendJson(res, 400, { ok: false, error: "Invalid open-link params" });
          return;
        }
        let result: UiOpenLinkResult = {};
        try {
          new URL(openParams.url);
        } catch {
          result = { isError: true };
        }
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (url.pathname === "/proxy/ui/download-file") {
        sendJson(res, 200, { ok: true, result: { isError: true } });
        return;
      }

      if (url.pathname === "/proxy/ui/request-display-mode") {
        const displayParams = params as UiDisplayModeRequest;
        const requested = displayParams?.mode;
        const available = hostContext.availableDisplayModes ?? ["inline"];
        if (requested && available.includes(requested)) {
          currentDisplayMode = requested;
        }
        hostContext.displayMode = currentDisplayMode;
        pushEvent("host-context", { displayMode: currentDisplayMode });
        const result: UiDisplayModeResult = { mode: currentDisplayMode };
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (url.pathname === "/proxy/ui/heartbeat") {
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }

      if (url.pathname === "/proxy/ui/complete") {
        const reason = typeof (params as { reason?: string }).reason === "string"
          ? (params as { reason?: string }).reason!
          : "done";
        markCompleted(reason);
        sendJson(res, 200, { ok: true, result: {} });
        setTimeout(() => {
          try {
            server.close();
          } catch {}
          closeSse();
        }, 20).unref();
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      if (error instanceof SessionRecoveryAuthRequiredError) {
        const fallback = `Server "${options.serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${options.serverName}" }) to get a browser URL, or /mcp-auth ${options.serverName} in an interactive local session.`;
        const message = error.authMessage ?? (options.config
          ? formatAuthRequiredMessage(options.config, options.serverName, fallback)
          : fallback);
        sendJson(res, 401, { ok: false, error: message });
        return;
      }
      const wrapped = wrapError(error, { server: options.serverName, tool: options.toolName });
      const status = /approval required|denied/i.test(wrapped.message) ? 403 : 500;
      if (status === 500) {
        log.error("Request handler error", error instanceof Error ? error : undefined);
      }
      sendJson(res, status, { ok: false, error: wrapped.message });
    }
  });

  if (options.initialResultPromise) {
    options.initialResultPromise.then(
      (result) => pushEvent("tool-result", result),
      (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        pushEvent("tool-cancelled", { reason });
      }
    );
  }

  watchdog = setInterval(() => {
    if (completed) return;
    if (Date.now() - lastHeartbeatAt <= ABANDONED_GRACE_MS) return;
    markCompleted("stale");
    try {
      server.close();
    } catch {}
    closeSse();
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  return new Promise((resolve, reject) => {
    const candidates = resolvePortCandidates(options.port);
    let candidateIndex = 0;

    const listen = () => {
      server.once("error", onError);
      server.listen(candidates[candidateIndex], "127.0.0.1", onListening);
    };

    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE" && candidateIndex < candidates.length - 1) {
        candidateIndex += 1;
        listen();
        return;
      }
      log.error("Failed to start server", error);
      const port = candidates[candidateIndex];
      reject(new ServerError(error.message, {
        ...(port !== undefined ? { port } : {}),
        cause: error,
      }));
    };

    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        const err = new ServerError("invalid address");
        log.error("Invalid server address", err);
        reject(err);
        return;
      }

      log.debug("Server started", { port: address.port });
      rememberMoshiDiscoveryPort(address.port);

      const handle: UiServerHandle = {
        url: `http://localhost:${address.port}/?session=${sessionToken}`,
        port: address.port,
        sessionToken,
        serverName: options.serverName,
        toolName: options.toolName,
        close: (reason?: string) => {
          markCompleted(reason ?? "closed");
          try {
            server.close();
          } catch {}
          closeSse();
        },
        sendToolInput: (args: Record<string, unknown>) => {
          pushEvent("tool-input", { arguments: args });
        },
        sendToolResult: (result: CallToolResult) => {
          pushEvent("tool-result", result);
        },
        sendResultPatch: (result: CallToolResult) => {
          pushEvent("result-patch", result);
        },
        sendToolCancelled: (reason: string) => {
          pushEvent("tool-cancelled", { reason });
        },
        sendHostContext: (context: UiHostContext) => {
          Object.assign(hostContext, context);
          pushEvent("host-context", context);
        },
        getSessionMessages: () => ({ ...sessionMessages }),
        getStreamSummary: () => streamSummary ? { ...streamSummary, phases: [...streamSummary.phases] } : undefined,
      };

      resolve(handle);
    };

    listen();
  });
}

async function parseBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<UiProxyRequestBody<Record<string, unknown>> | null> {
  try {
    const body = await readBody(req);
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { ok: false, error: "Invalid request body" });
      return null;
    }
    return body as UiProxyRequestBody<Record<string, unknown>>;
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid body" });
    return null;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function resolvePortCandidates(port: number | undefined): number[] {
  if (port !== undefined) return [port];
  const candidates: number[] = [];
  const count = MOSHI_DISCOVERY_PORT_END - MOSHI_DISCOVERY_PORT_START + 1;
  for (let offset = 0; offset < count; offset += 1) {
    const candidate = MOSHI_DISCOVERY_PORT_START + ((nextMoshiDiscoveryPort - MOSHI_DISCOVERY_PORT_START + offset) % count);
    candidates.push(candidate);
  }
  candidates.push(0);
  return candidates;
}

function rememberMoshiDiscoveryPort(port: number): void {
  if (port < MOSHI_DISCOVERY_PORT_START || port > MOSHI_DISCOVERY_PORT_END) return;
  nextMoshiDiscoveryPort = port >= MOSHI_DISCOVERY_PORT_END ? MOSHI_DISCOVERY_PORT_START : port + 1;
}

function isAllowedHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function validateTokenQuery(
  url: URL,
  expected: string,
  res: ServerResponse,
  parameter = "session",
): boolean {
  const token = url.searchParams.get(parameter);
  if (token !== expected) {
    sendJson(res, 403, { ok: false, error: "Invalid session" });
    return false;
  }
  return true;
}

function validateTokenBody(
  body: UiProxyRequestBody<Record<string, unknown>>,
  expected: string,
  res: ServerResponse,
): boolean {
  if (body.token !== expected) {
    sendJson(res, 403, { ok: false, error: "Invalid session" });
    return false;
  }
  return true;
}

function sendJson<T>(
  res: ServerResponse,
  status: number,
  payload: UiProxyResult<T>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}
