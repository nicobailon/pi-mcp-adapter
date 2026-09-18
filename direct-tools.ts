import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UrlElicitationRequiredError, type Client } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpContent } from "./types.ts";
import { lazyConnect, getFailureAgeSeconds, clearFailure } from "./init.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { formatSchema } from "./tool-metadata.ts";
import { resolveMcpResultContent, transformMcpContent, transformMcpResourceContents } from "./tool-registrar.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { maybeStartUiSession, summarizeUiSessionResult, type UiSessionRuntime } from "./ui-session.ts";
import { isServerDisabled } from "./types.ts";
import { authenticate, supportsOAuth } from "./mcp-auth-flow.ts";
import { formatAuthRequiredMessage, normalizeToolArguments, resolveServerUrl } from "./utils.ts";
import { SessionRecoveryAuthRequiredError, withSessionRecovery } from "./session-recovery.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { ensureToolCallApproved } from "./tool-approval.ts";
import { getInputRequiredNeedsUiDetails } from "./errors.ts";

type ClientCallToolResult = Awaited<ReturnType<Client["callTool"]>>;
type ClientReadResourceResult = Awaited<ReturnType<Client["readResource"]>>;

type DirectAutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

export {
  DIRECT_TOOLS_ADVISORY_THRESHOLD,
  buildProxyDescription,
  getMissingConfiguredDirectToolServers,
  prepareDirectToolArguments,
  resolveDirectTools,
} from "./direct-tool-surface.ts";

function getDirectAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
): string {
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getDirectAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  if (customGuidance) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getDirectAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`;
}

async function attemptDirectAutoAuth(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
): Promise<DirectAutoAuthResult> {
  if (state.config.settings?.autoAuth !== true) {
    return { status: "skipped" };
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition) || !supportsOAuth(definition)) {
    return { status: "skipped" };
  }

  let serverUrl: string | undefined;
  try {
    serverUrl = resolveServerUrl(definition);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message: getDirectAuthFailedMessage(state, serverName, message) };
  }
  if (!serverUrl) {
    return { status: "skipped" };
  }

  const grantType = definition.oauth ? definition.oauth.grantType ?? "authorization_code" : "authorization_code";
  if (!state.ui && grantType !== "client_credentials") {
    return {
      status: "failed",
      message: getDirectAuthRequiredMessage(
        state,
        serverName,
        `MCP server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
      ),
    };
  }

  try {
    if (state.authStorageOptions) {
      await authenticate(
        serverName,
        serverUrl,
        definition,
        signal
          ? { authStorageOptions: state.authStorageOptions, signal, runtime: state.oauthRuntime }
          : { authStorageOptions: state.authStorageOptions, runtime: state.oauthRuntime },
      );
    } else {
      await authenticate(serverName, serverUrl, definition, {
        ...(signal ? { signal } : {}),
        runtime: state.oauthRuntime,
      });
    }
    return { status: "success" };
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: getDirectAuthFailedMessage(state, serverName, message),
    };
  }
}

type DirectToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<Record<string, unknown>>>;

export function createDirectToolExecutor(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
  spec: DirectToolSpec
): DirectToolExecute {
  return async function execute(_toolCallId, params, signal) {
    throwIfAborted(signal);
    let state = getState();
    const initPromise = getInitPromise();

    if (!state && initPromise) {
      try {
        state = await initPromise;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
          details: { error: "init_failed", message },
        };
      }
    }
    if (!state) {
      return {
        content: [{ type: "text" as const, text: "MCP not initialized" }],
        details: { error: "not_initialized" },
      };
    }

    const definition = state.config.mcpServers[spec.serverName];
    if (isServerDisabled(definition)) {
      const message = `MCP server "${spec.serverName}" is disabled. Run /mcp enable ${spec.serverName} and /reload to enable it.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { error: "server_disabled", server: spec.serverName, message },
      };
    }

    const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
    throwIfAborted(ownedSignal);
    let connected = await lazyConnect(state, spec.serverName, ownedSignal);
    let autoAuthAttempted = false;

    if (!connected && state.manager.getConnection(spec.serverName)?.status === "needs-auth") {
      autoAuthAttempted = true;
      const autoAuth = await attemptDirectAutoAuth(state, spec.serverName, ownedSignal);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { error: "auth_required", server: spec.serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await state.manager.close(spec.serverName);
        clearFailure(state, spec.serverName);
        connected = await lazyConnect(state, spec.serverName, ownedSignal);
      }
    }

    if (!connected) {
      const authConnection = state.manager.getConnection(spec.serverName);
      if (authConnection?.status === "needs-auth") {
        const message = getDirectAuthRequiredMessage(state, spec.serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "auth_required", server: spec.serverName, message, autoAuthAttempted },
        };
      }
      const failedAgo = getFailureAgeSeconds(state, spec.serverName);
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not available${failedAgo !== null ? ` (failed ${failedAgo}s ago)` : ""}` }],
        details: { error: "server_unavailable", server: spec.serverName },
      };
    }

    const connection = state.manager.getConnection(spec.serverName);
    if (!connection || connection.status !== "connected") {
      return {
        content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not connected` }],
        details: { error: "not_connected", server: spec.serverName },
      };
    }

    const normalizedParams = spec.resourceUri ? params : normalizeToolArguments(params);
    const approval = await ensureToolCallApproved(state, spec.serverName, {
      name: spec.prefixedName,
      originalName: spec.originalName,
      description: spec.description,
      ...(spec.inputSchema !== undefined ? { inputSchema: spec.inputSchema } : {}),
      ...(spec.resourceUri !== undefined ? { resourceUri: spec.resourceUri } : {}),
      ...(spec.uiResourceUri !== undefined ? { uiResourceUri: spec.uiResourceUri } : {}),
      ...(spec.uiStreamMode !== undefined ? { uiStreamMode: spec.uiStreamMode } : {}),
    }, normalizedParams, ownedSignal, spec.resourceUri ? "resource" : "direct");
    if (approval.ok === false) {
      const denied = approval.reason === "denied";
      const message = denied
        ? `The user declined approval to run MCP tool "${spec.originalName}" on server "${spec.serverName}".`
        : `MCP tool "${spec.originalName}" on server "${spec.serverName}" is approval-gated and requires an interactive session.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: {
          error: denied ? "approval_denied" : "approval_required",
          server: spec.serverName,
          tool: spec.originalName,
        },
      };
    }

    let uiSession: UiSessionRuntime | null = null;
    const requestOptions = state.manager.getRequestOptions?.(spec.serverName, ownedSignal) ?? (ownedSignal ? { signal: ownedSignal } : undefined);

    const outputGuardOptions = resolveMcpOutputGuardOptions(state.config.settings);
    const recoverAuthConnection = async () => {
      const current = state.manager.getConnection(spec.serverName);
      if (current?.status === "connected") return current;

      if (!autoAuthAttempted) {
        autoAuthAttempted = true;
        const autoAuth = await attemptDirectAutoAuth(state, spec.serverName, ownedSignal);
        if (autoAuth.status === "failed") {
          throw new SessionRecoveryAuthRequiredError(spec.serverName, autoAuth.message);
        }
        if (autoAuth.status === "success") {
          const afterAuth = state.manager.getConnection(spec.serverName);
          if (afterAuth?.status === "connected") return afterAuth;
          if (afterAuth?.status === "needs-auth") {
            await state.manager.close(spec.serverName);
          }
          clearFailure(state, spec.serverName);
          const reconnected = await lazyConnect(state, spec.serverName, ownedSignal);
          return reconnected ? state.manager.getConnection(spec.serverName) : undefined;
        }
      }
      return state.manager.getConnection(spec.serverName);
    };

    try {
      state.manager.touch(spec.serverName);
      state.manager.incrementInFlight(spec.serverName);

      if (spec.resourceUri) {
        const result = await withSessionRecovery<ClientReadResourceResult>(
          {
            manager: state.manager,
            config: state.config,
            ...(ownedSignal ? { signal: ownedSignal } : {}),
            onNeedsAuth: recoverAuthConnection,
          },
          spec.serverName,
          async (conn) => {
            const refreshRead = await state.manager.prepareResourceUse?.(spec.serverName, spec.resourceUri!, conn);
            return conn.client.readResource(
              { uri: spec.resourceUri! },
              refreshRead ? { ...requestOptions, cacheMode: "refresh" } : requestOptions,
            );
          },
        );
        const content = transformMcpResourceContents(result.contents ?? [], state.owner?.signal);
        const guarded = await guardMcpOutput(content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }], {
          ...outputGuardOptions,
          ...(state.config.settings?.directToolResultDetails === "bounded" ? { rawMcpResult: result } : {}),
        });
        return {
          content: guarded.content,
          details: { server: spec.serverName, resourceUri: spec.resourceUri, ...guardedMcpDetails(guarded) },
        };
      }

      const hasUi = !!spec.uiResourceUri;
      uiSession = hasUi
        ? await maybeStartUiSession(state, {
            serverName: spec.serverName,
            toolName: spec.originalName,
            toolArgs: normalizedParams,
            uiResourceUri: spec.uiResourceUri!,
            ...(spec.uiStreamMode !== undefined ? { streamMode: spec.uiStreamMode } : {}),
            ...(signal ? { signal } : {}),
            onNeedsAuth: recoverAuthConnection,
          })
        : null;

      const result = await withSessionRecovery<ClientCallToolResult>(
        {
          manager: state.manager,
          config: state.config,
          ...(ownedSignal ? { signal: ownedSignal } : {}),
          onNeedsAuth: recoverAuthConnection,
        },
        spec.serverName,
        async (conn) => {
          await state.manager.ensureListen?.(spec.serverName, conn);
          return abortable(conn.client.callTool({
            name: spec.originalName,
            arguments: normalizedParams,
            _meta: uiSession?.requestMeta,
          }, requestOptions), ownedSignal);
        },
      );
      uiSession?.sendToolResult(result as unknown as import("@modelcontextprotocol/client").CallToolResult);

      if (result.isError) {
        const mcpContent = (result.content ?? []) as McpContent[];
        const content = transformMcpContent(mcpContent, state.owner?.signal);
        const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
        const guarded = await guardMcpOutput(outputContent, {
          ...outputGuardOptions,
          prefix: "Error: ",
          emptyTextFallback: "Tool execution failed",
          ...(state.config.settings?.directToolResultDetails === "bounded" ? { rawMcpResult: result } : {}),
        });
        return {
          content: guarded.content,
          details: { error: "tool_error", server: spec.serverName, ...guardedMcpDetails(guarded) },
        };
      }

      const content = resolveMcpResultContent(result as Record<string, unknown>, state.owner?.signal);
      const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
      if (hasUi) {
        const uiSummary = summarizeUiSessionResult(uiSession);
        const guarded = await guardMcpOutput(outputContent, {
          ...outputGuardOptions,
          suffix: `\n\n${uiSummary.message}`,
          ...(state.config.settings?.directToolResultDetails === "bounded" ? { rawMcpResult: result } : {}),
        });
        return {
          content: guarded.content,
          details: {
            server: spec.serverName,
            tool: spec.originalName,
            uiOpen: uiSummary.uiOpen,
            uiViewer: uiSummary.uiViewer,
            uiUrl: uiSummary.uiUrl,
            ...guardedMcpDetails(guarded),
          },
        };
      }

      const guarded = await guardMcpOutput(outputContent, {
        ...outputGuardOptions,
        ...(state.config.settings?.directToolResultDetails === "bounded" ? { rawMcpResult: result } : {}),
      });
      return {
        content: guarded.content,
        details: { server: spec.serverName, tool: spec.originalName, ...guardedMcpDetails(guarded) },
      };
    } catch (error) {
      if (error instanceof SessionRecoveryAuthRequiredError) {
        const message = error.authMessage ?? getDirectAuthRequiredMessage(state, spec.serverName);
        uiSession?.sendToolCancelled(message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "auth_required", server: spec.serverName, message, autoAuthAttempted },
        };
      }
      if (error instanceof UrlElicitationRequiredError) {
        const action = await state.manager.handleUrlElicitationRequired(spec.serverName, error);
        const message = action === "accept"
          ? "The original MCP tool did not run. Complete the opened browser interaction, then retry the tool."
          : `The URL interaction was ${action === "decline" ? "declined" : "cancelled"}.`;
        uiSession?.sendToolCancelled(message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: "url_elicitation_required", server: spec.serverName, action },
        };
      }
      const inputRequired = getInputRequiredNeedsUiDetails(error, spec.resourceUri
        ? { server: spec.serverName, resourceUri: spec.resourceUri }
        : { server: spec.serverName, tool: spec.originalName });
      if (inputRequired) {
        uiSession?.sendToolCancelled(inputRequired.message);
        return {
          content: [{ type: "text" as const, text: inputRequired.message }],
          details: { ...inputRequired },
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      const aborted = isAbortError(error, ownedSignal);
      if (!aborted) {
        await state.manager.close(spec.serverName).catch(() => {});
      }
      uiSession?.sendToolCancelled(message);
      const schemaText = spec.inputSchema ? `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}` : "";
      const guarded = await guardMcpOutput([{ type: "text" as const, text: message }], { ...outputGuardOptions, prefix: "Failed to call tool: ", suffix: schemaText });
      return {
        content: guarded.content,
        details: { error: aborted ? "aborted" : "call_failed", server: spec.serverName, ...guardedMcpDetails(guarded) },
      };
    } finally {
      if (uiSession?.reused) {
        uiSession.close();
      }
      state.manager.decrementInFlight(spec.serverName);
      state.manager.touch(spec.serverName);
    }
  };
}
