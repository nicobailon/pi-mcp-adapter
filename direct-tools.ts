import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UrlElicitationRequiredError, type Client } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpConfig, McpContent, ToolPrefix } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { lazyConnect, getFailureAgeSeconds, clearFailure } from "./init.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { isServerCacheValid, parseDirectToolSelectors } from "./metadata-cache.ts";
export { getMissingConfiguredDirectToolServers } from "./metadata-cache.ts";
import { formatSchema } from "./tool-metadata.ts";
import { resolveMcpResultContent, transformMcpContent, transformMcpResourceContents } from "./tool-registrar.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { maybeStartUiSession, summarizeUiSessionResult, type UiSessionRuntime } from "./ui-session.ts";
import { createToolSelectorCandidateIndex, formatToolName, getToolNameCandidates, isServerDisabled, isToolAllowed, resolveToolPrefix } from "./types.ts";
import { isUiToolVisibleToModel } from "./ui-tool-visibility.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { authenticate, supportsOAuth } from "./mcp-auth-flow.ts";
import { formatAuthRequiredMessage, resolveServerUrl, truncateAtWord } from "./utils.ts";
import { SessionRecoveryAuthRequiredError, withSessionRecovery } from "./session-recovery.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { ensureToolCallApproved } from "./tool-approval.ts";

type ClientCallToolResult = Awaited<ReturnType<Client["callTool"]>>;
type ClientReadResourceResult = Awaited<ReturnType<Client["readResource"]>>;

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);
const INSTRUCTIONS_SNIPPET_LENGTH = 150;
export const DIRECT_TOOLS_ADVISORY_THRESHOLD = 75;

type DirectAutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

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

export function resolveDirectTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: ToolPrefix,
  envOverride?: string[],
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  if (!cache) return specs;

  const seenNames = new Set<string>();

  const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;
  const globalDirect = config.settings?.directTools;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) continue;

    let toolFilter: true | string[] | false = false;

    if (envSelection) {
      if (envSelection.servers.has(serverName)) {
        toolFilter = true;
      } else if (envSelection.tools.has(serverName)) {
        toolFilter = [...envSelection.tools.get(serverName)!];
      }
    } else {
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }
    }

    if (!toolFilter) continue;

    const effectivePrefix = resolveToolPrefix(definition, prefix);
    const hasToolFilters =
      (Array.isArray(definition.includeTools) && definition.includeTools.length > 0) ||
      (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0);
    const selectorCandidateIndex = hasToolFilters ? (() => {
      const candidates = new Set<string>();
      for (const [otherServerName, otherDefinition] of Object.entries(config.mcpServers)) {
        const otherCache = cache.servers[otherServerName];
        if (!otherCache || !isServerCacheValid(otherCache, otherDefinition) || isServerDisabled(otherDefinition)) continue;
        const otherPrefix = resolveToolPrefix(otherDefinition, prefix);
        for (const otherTool of otherCache.tools ?? []) {
          if (!isUiToolVisibleToModel(otherTool.uiVisibility)) continue;
          for (const candidate of getToolNameCandidates(otherTool.name, otherServerName, otherPrefix, false)) candidates.add(candidate);
        }
        if (otherDefinition.exposeResources !== false) {
          for (const resource of otherCache.resources ?? []) {
            const baseName = `read_${resourceNameToToolName(resource.name)}`;
            for (const candidate of getToolNameCandidates(baseName, otherServerName, otherPrefix, false)) candidates.add(candidate);
          }
        }
      }
      return createToolSelectorCandidateIndex(candidates);
    })() : undefined;

    for (const tool of serverCache.tools ?? []) {
      if (!isUiToolVisibleToModel(tool.uiVisibility)) continue;
      if (toolFilter !== true && !toolFilter.includes(tool.name)) continue;
      if (!isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) continue;
      const prefixedName = formatToolName(tool.name, serverName, effectivePrefix);
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      if (seenNames.has(prefixedName)) {
        console.warn(`MCP: skipping duplicate direct tool "${prefixedName}" from "${serverName}"`);
        continue;
      }
      seenNames.add(prefixedName);
      specs.push({
        serverName,
        originalName: tool.name,
        prefixedName,
        description: tool.description ?? "",
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.uiResourceUri !== undefined ? { uiResourceUri: tool.uiResourceUri } : {}),
        ...(tool.uiStreamMode !== undefined ? { uiStreamMode: tool.uiStreamMode } : {}),
      });
    }

    if (definition.exposeResources !== false) {
      for (const resource of serverCache.resources ?? []) {
        const baseName = `read_${resourceNameToToolName(resource.name)}`;
        if (toolFilter !== true && !toolFilter.includes(baseName)) continue;
        if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) continue;
        const prefixedName = formatToolName(baseName, serverName, effectivePrefix);
        if (BUILTIN_NAMES.has(prefixedName)) {
          console.warn(`MCP: skipping direct resource tool "${prefixedName}" (collides with builtin)`);
          continue;
        }
        if (seenNames.has(prefixedName)) {
          console.warn(`MCP: skipping duplicate direct resource tool "${prefixedName}" from "${serverName}"`);
          continue;
        }
        seenNames.add(prefixedName);
        specs.push({
          serverName,
          originalName: baseName,
          prefixedName,
          description: resource.description ?? `Read resource: ${resource.uri}`,
          resourceUri: resource.uri,
        });
      }
    }
  }

  if (config.settings?.warnOnLargeDirectTools !== false && specs.length >= DIRECT_TOOLS_ADVISORY_THRESHOLD) {
    console.warn(`MCP: ${specs.length} direct tools resolved. Each direct tool adds prompt context; README guidance recommends targeted sets of 5-20 tools and using the proxy or an explicit string[] when 75+ direct tools would be registered.`);
  }

  return specs;
}

export function buildProxyDescription(
  config: McpConfig,
  cache: MetadataCache | null,
  directSpecs: DirectToolSpec[],
): string {
  const prefix = config.settings?.toolPrefix ?? "server";
  let desc = `MCP gateway — server status, tool search/describe, auth, and single MCP tool calls. When one request needs several MCP calls with logic between them, use mcpScript. Non-MCP Pi tools should be called directly, not through mcp.\n`;

  const directByServer = new Map<string, number>();
  for (const spec of directSpecs) {
    directByServer.set(spec.serverName, (directByServer.get(spec.serverName) ?? 0) + 1);
  }
  if (directByServer.size > 0) {
    const parts = [...directByServer.entries()].map(
      ([server, count]) => `${server} (${count})`,
    );
    desc += `\nDirect tools available (call as normal tools): ${parts.join(", ")}\n`;
  }

  const serverSummaries: string[] = [];
  for (const serverName of Object.keys(config.mcpServers)) {
    const definition = config.mcpServers[serverName];
    if (!definition || isServerDisabled(definition)) continue;
    const cachedEntry = cache?.servers?.[serverName];
    const entry = cachedEntry && isServerCacheValid(cachedEntry, definition) ? cachedEntry : undefined;
    const effectivePrefix = resolveToolPrefix(definition, prefix);
    const hasToolFilters =
      (Array.isArray(definition.includeTools) && definition.includeTools.length > 0) ||
      (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0);
    const selectorCandidateIndex = hasToolFilters && cache ? (() => {
      const candidates = new Set<string>();
      for (const [otherServerName, otherDefinition] of Object.entries(config.mcpServers)) {
        const otherEntry = cache.servers[otherServerName];
        if (!otherEntry || !isServerCacheValid(otherEntry, otherDefinition) || isServerDisabled(otherDefinition)) continue;
        const otherPrefix = resolveToolPrefix(otherDefinition, prefix);
        for (const otherTool of otherEntry.tools ?? []) {
          if (!isUiToolVisibleToModel(otherTool.uiVisibility)) continue;
          for (const candidate of getToolNameCandidates(otherTool.name, otherServerName, otherPrefix, false)) candidates.add(candidate);
        }
        if (otherDefinition.exposeResources !== false) {
          for (const resource of otherEntry.resources ?? []) {
            const baseName = `read_${resourceNameToToolName(resource.name)}`;
            for (const candidate of getToolNameCandidates(baseName, otherServerName, otherPrefix, false)) candidates.add(candidate);
          }
        }
      }
      return createToolSelectorCandidateIndex(candidates);
    })() : undefined;
    const toolCount = (entry?.tools ?? []).filter(
      (tool) => isUiToolVisibleToModel(tool.uiVisibility)
        && isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex),
    ).length;
    const resourceCount = definition?.exposeResources !== false
      ? (entry?.resources ?? []).filter((resource) => {
          const baseName = `read_${resourceNameToToolName(resource.name)}`;
          return isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex);
        }).length
      : 0;
    const totalItems = toolCount + resourceCount;
    if (totalItems === 0) continue;
    const directCount = directByServer.get(serverName) ?? 0;
    const proxyCount = totalItems - directCount;
    if (proxyCount > 0) {
      serverSummaries.push(`${serverName} (${proxyCount} tools)`);
    }
  }

  if (serverSummaries.length > 0) {
    desc += `\nServers: ${serverSummaries.join(", ")}\n`;
  }

  const disabledServers = Object.entries(config.mcpServers)
    .filter(([, definition]) => isServerDisabled(definition))
    .map(([serverName]) => serverName);
  if (disabledServers.length > 0) {
    desc += `\nDisabled servers (enable with /mcp enable <server> and /reload): ${disabledServers.join(", ")}\n`;
  }

  const instructionSummaries: string[] = [];
  for (const serverName of Object.keys(config.mcpServers)) {
    if (isServerDisabled(config.mcpServers[serverName])) continue;
    const definition = config.mcpServers[serverName];
    const entry = definition && cache?.servers?.[serverName];
    const instructions = entry && definition && isServerCacheValid(entry, definition) ? entry.instructions : undefined;
    if (!instructions) continue;
    const snippet = truncateAtWord(instructions.replace(/\s+/g, " ").trim(), INSTRUCTIONS_SNIPPET_LENGTH);
    instructionSummaries.push(`  ${serverName}: ${snippet}`);
  }
  if (instructionSummaries.length > 0) {
    desc += `\nServer instructions (truncated - full text via mcp({ instructions: "name" })):\n${instructionSummaries.join("\n")}\n`;
  }

  desc += `\nUsage:\n`;
  desc += `  mcp({ })                              → Show server status\n`;
  desc += `  mcp({ server: "name" })               → List tools from server\n`;
  desc += `  mcp({ search: "query" })              → Search MCP tools by name/description\n`;
  desc += `  mcp({ describe: "tool_name" })        → Show tool details and parameters\n`;
  desc += `  mcp({ instructions: "name" })         → Show full server usage instructions\n`;
  desc += `  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n`;
  desc += `  mcp({ tool: "name", args: { key: "value" } })         → Call a tool (object args; JSON string also accepted)\n`;
  desc += `  mcp({ action: "ui-messages" })        → Retrieve accumulated messages from completed UI sessions\n`;
  desc += `  mcp({ action: "auth-start", server: "name" })      → Start manual OAuth and get a browser URL\n`;
  desc += `  mcp({ action: "auth-complete", server: "name", args: { redirectUrl: "..." } }) → Complete manual OAuth\n`;
  desc += `\nMode: action > tool (call) > connect > describe > instructions > search > server (list) > nothing (status)`;

  return desc;
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

    const approval = await ensureToolCallApproved(state, spec.serverName, {
      name: spec.prefixedName,
      originalName: spec.originalName,
      description: spec.description,
      ...(spec.inputSchema !== undefined ? { inputSchema: spec.inputSchema } : {}),
      ...(spec.resourceUri !== undefined ? { resourceUri: spec.resourceUri } : {}),
      ...(spec.uiResourceUri !== undefined ? { uiResourceUri: spec.uiResourceUri } : {}),
      ...(spec.uiStreamMode !== undefined ? { uiStreamMode: spec.uiStreamMode } : {}),
    }, params, ownedSignal, spec.resourceUri ? "resource" : "direct");
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
          (conn) => conn.client.readResource({ uri: spec.resourceUri! }, requestOptions),
        );
        const content = transformMcpResourceContents(result.contents ?? [], state.owner?.signal);
        const guarded = await guardMcpOutput(content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }], outputGuardOptions);
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
            toolArgs: params ?? {},
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
        (conn) => abortable(conn.client.callTool({
          name: spec.originalName,
          arguments: params ?? {},
          _meta: uiSession?.requestMeta,
        }, requestOptions), ownedSignal),
      );
      uiSession?.sendToolResult(result as unknown as import("@modelcontextprotocol/client").CallToolResult);

      if (result.isError) {
        const mcpContent = (result.content ?? []) as McpContent[];
        const content = transformMcpContent(mcpContent, state.owner?.signal);
        const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
        const schemaText = spec.inputSchema ? `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}` : "";
        const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, prefix: "Error: ", suffix: schemaText, emptyTextFallback: "Tool execution failed" });
        return {
          content: guarded.content,
          details: { error: "tool_error", server: spec.serverName, ...guardedMcpDetails(guarded) },
        };
      }

      const content = resolveMcpResultContent(result as Record<string, unknown>, state.owner?.signal);
      const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
      if (hasUi) {
        const uiSummary = summarizeUiSessionResult(uiSession);
        const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, suffix: `\n\n${uiSummary.message}` });
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

      const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions });
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
      const message = error instanceof Error ? error.message : String(error);
      uiSession?.sendToolCancelled(message);
      const schemaText = spec.inputSchema ? `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}` : "";
      const guarded = await guardMcpOutput([{ type: "text" as const, text: message }], { ...outputGuardOptions, prefix: "Failed to call tool: ", suffix: schemaText });
      return {
        content: guarded.content,
        details: { error: isAbortError(error, ownedSignal) ? "aborted" : "call_failed", server: spec.serverName, ...guardedMcpDetails(guarded) },
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
