import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/sdk/types.js";
import { checkSync } from "recheck";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata, McpContent } from "./types.ts";
import { getServerPrefix, parseUiPromptHandoff } from "./types.ts";
import { lazyConnect, updateServerMetadata, updateMetadataCache, getFailureAgeSeconds, updateStatusBar } from "./init.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { buildToolMetadata, getToolNames, findToolByName, formatSchema } from "./tool-metadata.ts";
import { resolveMcpResultContent, transformMcpContent } from "./tool-registrar.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { maybeStartUiSession, summarizeUiSessionResult, type UiSessionRuntime } from "./ui-session.ts";
import { formatAuthRequiredMessage, truncateAtWord } from "./utils.ts";
import { authenticate, completeAuthFromInput, startAuth, supportsOAuth } from "./mcp-auth-flow.ts";
import { SessionRecoveryAuthRequiredError, withSessionRecovery } from "./session-recovery.ts";

type ProxyToolResult = AgentToolResult<Record<string, unknown>>;

const MAX_REGEX_SEARCH_QUERY_LENGTH = 256;
const INSTRUCTIONS_PREVIEW_LENGTH = 300;
const REGEX_SAFETY_CHECK_PARAMS = {
  attackTimeout: 50,
  incubationTimeout: 50,
  timeout: 250,
} as const;

type AutoAuthResult =
  | { status: "skipped" }
  | { status: "success" }
  | { status: "failed"; message: string };

function getAuthRequiredMessage(
  state: McpExtensionState,
  serverName: string,
  defaultMessage = `Server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
): string {
  return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
  const customGuidance = state.config.settings?.authRequiredMessage;
  if (customGuidance) {
    return `OAuth authentication failed for "${serverName}": ${message}. ${getAuthRequiredMessage(state, serverName)}`;
  }
  return `OAuth authentication failed for "${serverName}": ${message}. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`;
}

function getRedirectPort(authorizationUrl: string): number | undefined {
  try {
    const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri");
    if (!redirectUri) return undefined;
    const port = Number.parseInt(new URL(redirectUri).port, 10);
    return Number.isInteger(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function formatManualAuthInstructions(serverName: string, authorizationUrl: string): string {
  const port = getRedirectPort(authorizationUrl);
  const portNote = port
    ? `\nThe redirect URL will use local port ${port}. On a remote server it is expected for that localhost page to fail locally; copy the address bar URL anyway.`
    : "";

  return [
    `MCP OAuth required for "${serverName}".`,
    "",
    "Open this URL in your local browser:",
    "",
    authorizationUrl,
    "",
    "After approving, copy the full redirected localhost URL from your browser address bar and send it back with:",
    `mcp({ action: "auth-complete", server: "${serverName}", args: '{"redirectUrl":"PASTE_REDIRECT_URL_HERE"}' })`,
    "",
    "You can also pass just the `code` query parameter as `args: '{\"code\":\"PASTE_CODE_HERE\"}'`.",
    portNote.trimEnd(),
  ].filter(Boolean).join("\n");
}

async function attemptAutoAuth(
  state: McpExtensionState,
  serverName: string,
): Promise<AutoAuthResult> {
  if (state.config.settings?.autoAuth !== true) {
    return { status: "skipped" };
  }

  const definition = state.config.mcpServers[serverName];
  if (!definition || !supportsOAuth(definition) || !definition.url) {
    return { status: "skipped" };
  }

  const grantType = definition.oauth ? definition.oauth.grantType ?? "authorization_code" : "authorization_code";
  if (!state.ui && grantType !== "client_credentials") {
    return {
      status: "failed",
      message: getAuthRequiredMessage(
        state,
        serverName,
        `Server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp-auth ${serverName} in an interactive local session.`,
      ),
    };
  }

  try {
    await authenticate(serverName, definition.url, definition);
    return { status: "success" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: getAuthFailedMessage(state, serverName, message),
    };
  }
}

export function executeUiMessages(state: McpExtensionState): ProxyToolResult {
  const sessions = state.completedUiSessions;

  if (sessions.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No UI session messages available." }],
      details: { sessions: 0 },
    };
  }

  const output: string[] = [];
  output.push(`UI Session Messages (${sessions.length} session${sessions.length > 1 ? "s" : ""}):\n`);

  const allPrompts: string[] = [];
  const allIntents = sessions.flatMap((session) => session.messages.intents);
  const parsedHandoffs: Array<{ intent: string; params: Record<string, unknown>; raw: string }> = [];

  for (const session of sessions) {
    const timestamp = session.completedAt.toLocaleTimeString();
    output.push(`\n## ${session.serverName} / ${session.toolName} (${timestamp}, ${session.reason})`);

    const plainPrompts: string[] = [];
    for (const prompt of session.messages.prompts) {
      allPrompts.push(prompt);
      const handoff = parseUiPromptHandoff(prompt);
      if (handoff) {
        parsedHandoffs.push(handoff);
      } else {
        plainPrompts.push(prompt);
      }
    }

    if (plainPrompts.length > 0) {
      output.push("\n### Prompts:");
      for (const prompt of plainPrompts) {
        output.push(`- ${prompt}`);
      }
    }

    const intentsForSession = [
      ...session.messages.intents,
      ...session.messages.prompts
        .map((prompt) => parseUiPromptHandoff(prompt))
        .filter((handoff): handoff is NonNullable<typeof handoff> => !!handoff)
        .map((handoff) => ({ intent: handoff.intent, params: handoff.params })),
    ];

    if (intentsForSession.length > 0) {
      output.push("\n### Intents:");
      for (const intent of intentsForSession) {
        const params = intent.params ? ` (${JSON.stringify(intent.params)})` : "";
        output.push(`- ${intent.intent}${params}`);
      }
    }

    if (session.messages.notifications.length > 0) {
      output.push("\n### Notifications:");
      for (const notification of session.messages.notifications) {
        output.push(`- ${notification}`);
      }
    }
  }

  const count = sessions.length;
  state.completedUiSessions = [];

  return {
    content: [{ type: "text" as const, text: output.join("\n") }],
    details: {
      sessions: count,
      prompts: allPrompts,
      intents: [...allIntents, ...parsedHandoffs.map(({ intent, params }) => ({ intent, params }))],
      handoffs: parsedHandoffs,
      cleared: true,
    },
  };
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
  const servers: Array<{ name: string; status: string; toolCount: number; failedAgo: number | null }> = [];

  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    if (connection?.status === "connected") {
      status = "connected";
    } else if (connection?.status === "needs-auth") {
      status = "needs-auth";
    } else if (failedAgo !== null) {
      status = "failed";
    } else if (metadata !== undefined) {
      status = "cached";
    }

    servers.push({ name, status, toolCount, failedAgo });
  }

  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const connectedCount = servers.filter(s => s.status === "connected").length;

  let text = `MCP: ${connectedCount}/${servers.length} servers, ${totalTools} tools\n\n`;
  for (const server of servers) {
    if (server.status === "connected") {
      text += `✓ ${server.name} (${server.toolCount} tools)\n`;
      continue;
    }
    if (server.status === "needs-auth") {
      text += `⚠ ${server.name} (needs auth)\n`;
      continue;
    }
    if (server.status === "cached") {
      text += `○ ${server.name} (${server.toolCount} tools, cached)\n`;
      continue;
    }
    if (server.status === "failed") {
      text += `✗ ${server.name} (failed ${server.failedAgo ?? 0}s ago)\n`;
      continue;
    }
    text += `○ ${server.name} (not connected)\n`;
  }

  if (servers.length > 0) {
    text += `\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search`;
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "status", servers, totalTools, connectedCount },
  };
}

export async function executeAuthStart(state: McpExtensionState, serverName: string): Promise<ProxyToolResult> {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "auth-start", error: "not_found", server: serverName },
    };
  }

  if (!definition.url || !supportsOAuth(definition)) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" is not configured for OAuth over HTTP.` }],
      details: { mode: "auth-start", error: "oauth_not_supported", server: serverName },
    };
  }

  try {
    const { authorizationUrl } = await startAuth(serverName, definition.url, definition);
    if (!authorizationUrl) {
      return {
        content: [{ type: "text" as const, text: `OAuth authentication successful for "${serverName}".` }],
        details: { mode: "auth-start", server: serverName, authenticated: true },
      };
    }

    return {
      content: [{ type: "text" as const, text: formatManualAuthInstructions(serverName, authorizationUrl) }],
      details: { mode: "auth-start", server: serverName, authorizationUrl },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to start OAuth for "${serverName}": ${message}` }],
      details: { mode: "auth-start", error: "auth_start_failed", server: serverName, message },
    };
  }
}

export async function executeAuthComplete(state: McpExtensionState, serverName: string, input: string): Promise<ProxyToolResult> {
  if (!state.config.mcpServers[serverName]) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "auth-complete", error: "not_found", server: serverName },
    };
  }

  try {
    const status = await completeAuthFromInput(serverName, input);
    if (status !== "authenticated") {
      return {
        content: [{ type: "text" as const, text: `OAuth authentication did not complete for "${serverName}".` }],
        details: { mode: "auth-complete", error: "not_authenticated", server: serverName, status },
      };
    }

    await state.manager.close(serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
    return {
      content: [{ type: "text" as const, text: `OAuth authentication successful for "${serverName}". Run mcp({ connect: "${serverName}" }) to connect with the new token.` }],
      details: { mode: "auth-complete", server: serverName, authenticated: true },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to complete OAuth for "${serverName}": ${message}` }],
      details: { mode: "auth-complete", error: "auth_complete_failed", server: serverName, message },
    };
  }
}

export function executeDescribe(state: McpExtensionState, toolName: string): ProxyToolResult {
  let serverName: string | undefined;
  let toolMeta: ToolMetadata | undefined;

  for (const [server, metadata] of state.toolMetadata.entries()) {
    const found = findToolByName(metadata, toolName);
    if (found) {
      serverName = server;
      toolMeta = found;
      break;
    }
  }

  if (!serverName || !toolMeta) {
    return {
      content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.` }],
      details: { mode: "describe", error: "tool_not_found", requestedTool: toolName },
    };
  }

  let text = `${toolMeta.name}\n`;
  text += `Server: ${serverName}\n`;
  if (toolMeta.resourceUri) {
    text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`;
  }
  text += `\n${toolMeta.description || "(no description)"}\n`;

  if (toolMeta.inputSchema && !toolMeta.resourceUri) {
    text += `\nParameters:\n${formatSchema(toolMeta.inputSchema)}`;
  } else if (toolMeta.resourceUri) {
    text += `\nNo parameters required (resource tool).`;
  } else {
    text += `\nNo parameters defined.`;
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "describe", tool: toolMeta, server: serverName },
  };
}

export function executeSearch(
  state: McpExtensionState,
  query: string,
  regex?: boolean,
  server?: string,
  includeSchemas?: boolean,
): ProxyToolResult {
  const showSchemas = includeSchemas !== false;

  const matches: Array<{ server: string; tool: ToolMetadata }> = [];

  let pattern: RegExp;
  try {
    if (regex) {
      if (query.length > MAX_REGEX_SEARCH_QUERY_LENGTH) {
        return {
          content: [{ type: "text" as const, text: `Regex query is too long; maximum length is ${MAX_REGEX_SEARCH_QUERY_LENGTH} characters.` }],
          details: { mode: "search", error: "query_too_long", query, maxLength: MAX_REGEX_SEARCH_QUERY_LENGTH },
        };
      }

      pattern = new RegExp(query, "i");
      let safety;
      try {
        safety = checkSync(query, "i", REGEX_SAFETY_CHECK_PARAMS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: "Regex query rejected because safety analysis failed." }],
          details: { mode: "search", error: "unsafe_pattern", query, reason: message },
        };
      }
      if (safety.status !== "safe") {
        return {
          content: [{ type: "text" as const, text: `Regex query rejected as unsafe (${safety.status}).` }],
          details: { mode: "search", error: "unsafe_pattern", query, safetyStatus: safety.status },
        };
      }
    } else {
      const terms = query.trim().split(/\s+/).filter(t => t.length > 0);
      if (terms.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Search query cannot be empty" }],
          details: { mode: "search", error: "empty_query" },
        };
      }
      const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      pattern = new RegExp(escaped.join("|"), "i");
    }
  } catch {
    return {
      content: [{ type: "text" as const, text: `Invalid regex: ${query}` }],
      details: { mode: "search", error: "invalid_pattern", query },
    };
  }

  for (const [serverName, metadata] of state.toolMetadata.entries()) {
    if (server && serverName !== server) continue;
    for (const tool of metadata) {
      if (pattern.test(tool.name) || pattern.test(tool.description)) {
        matches.push({
          server: serverName,
          tool,
        });
      }
    }
  }

  const totalCount = matches.length;

  if (totalCount === 0) {
    const msg = server
      ? `No tools matching "${query}" in "${server}"`
      : `No tools matching "${query}"`;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "search", matches: [], count: 0, query },
    };
  }

  let text = `Found ${totalCount} tool${totalCount === 1 ? "" : "s"} matching "${query}":\n\n`;

  for (const match of matches) {
    if (showSchemas) {
      text += `${match.tool.name}\n`;
      text += `  ${match.tool.description || "(no description)"}\n`;
      if (match.tool.inputSchema && !match.tool.resourceUri) {
        text += `\n  Parameters:\n${formatSchema(match.tool.inputSchema, "    ")}\n`;
      } else if (match.tool.resourceUri) {
        text += `  No parameters (resource tool).\n`;
      }
      text += "\n";
    } else {
      text += `- ${match.tool.name}`;
      if (match.tool.description) {
        text += ` - ${truncateAtWord(match.tool.description, 50)}`;
      }
      text += "\n";
    }
  }

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: {
      mode: "search",
      matches: matches.map(m => ({ server: m.server, tool: m.tool.name })),
      count: totalCount,
      query,
    },
  };
}

export function executeList(state: McpExtensionState, server: string): ProxyToolResult {
  if (!state.config.mcpServers[server]) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
    };
  }

  const metadata = state.toolMetadata.get(server);
  const toolNames = metadata?.map(m => m.name) ?? [];
  const connection = state.manager.getConnection(server);
  const instructions = state.serverInstructions.get(server);
  let instructionsText = "";
  if (instructions) {
    const preview = truncateAtWord(instructions, INSTRUCTIONS_PREVIEW_LENGTH);
    instructionsText = `\n\nServer instructions:\n${preview}`;
    if (preview !== instructions) {
      instructionsText += `\nUse mcp({ instructions: "${server}" }) for the full text.`;
    }
  }

  if (toolNames.length === 0) {
    if (connection?.status === "connected") {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no tools.${instructionsText}` }],
        details: { mode: "list", server, tools: [], count: 0, hasInstructions: Boolean(instructions) },
      };
    }
    if (metadata !== undefined) {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no cached tools (not connected).${instructionsText}` }],
        details: { mode: "list", server, tools: [], count: 0, cached: true, hasInstructions: Boolean(instructions) },
      };
    }
    return {
      content: [{ type: "text" as const, text: `Server "${server}" is configured but not connected. Use mcp({ connect: "${server}" }) or /mcp reconnect ${server} to retry.${instructionsText}` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_connected", hasInstructions: Boolean(instructions) },
    };
  }

  const cachedNote = connection?.status === "connected" ? "" : " (not connected, cached)";
  let text = `${server} (${toolNames.length} tools${cachedNote}):\n\n`;

  const descMap = new Map<string, string>();
  if (metadata) {
    for (const m of metadata) {
      descMap.set(m.name, m.description);
    }
  }

  for (const tool of toolNames) {
    const desc = descMap.get(tool) ?? "";
    const truncated = truncateAtWord(desc, 50);
    text += `- ${tool}`;
    if (truncated) text += ` - ${truncated}`;
    text += "\n";
  }

  text += instructionsText;

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "list", server, tools: toolNames, count: toolNames.length, hasInstructions: Boolean(instructions) },
  };
}

export function executeInstructions(state: McpExtensionState, server: string): ProxyToolResult {
  if (!state.config.mcpServers[server]) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "instructions", server, error: "not_found" },
    };
  }

  const instructions = state.serverInstructions.get(server);
  if (instructions) {
    return {
      content: [{ type: "text" as const, text: `${server} instructions:\n\n${instructions}` }],
      details: { mode: "instructions", server, length: instructions.length },
    };
  }

  const connection = state.manager.getConnection(server);
  if (connection?.status === "connected") {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" does not provide instructions.` }],
      details: { mode: "instructions", server, error: "no_instructions" },
    };
  }

  return {
    content: [{ type: "text" as const, text: `No instructions cached for "${server}". Use mcp({ connect: "${server}" }) to connect and refresh.` }],
    details: { mode: "instructions", server, error: "not_connected" },
  };
}

export async function executeConnect(state: McpExtensionState, serverName: string, signal?: AbortSignal): Promise<ProxyToolResult> {
  throwIfAborted(signal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    let connection = await state.manager.connect(serverName, definition, signal);
    if (connection.status === "needs-auth") {
      const autoAuth = await attemptAutoAuth(state, serverName);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await state.manager.close(serverName);
        connection = await state.manager.connect(serverName, definition, signal);
      }
      if (connection.status === "needs-auth") {
        const message = getAuthRequiredMessage(state, serverName);
        return {
          content: [{ type: "text" as const, text: message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message },
        };
      }
    }
    const prefix = state.config.settings?.toolPrefix ?? "server";
    const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
    state.toolMetadata.set(serverName, metadata);
    if (connection.instructions) {
      state.serverInstructions.set(serverName, connection.instructions);
    } else {
      state.serverInstructions.delete(serverName);
    }
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
    return executeList(state, serverName);
  } catch (error) {
    if (!signal?.aborted) {
      state.failureTracker.set(serverName, Date.now());
    }
    updateStatusBar(state);
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
      details: { mode: "connect", error: signal?.aborted ? "aborted" : "connect_failed", server: serverName, message },
    };
  }
}

export async function executeCall(
  state: McpExtensionState,
  toolName: string,
  args?: Record<string, unknown>,
  serverOverride?: string,
  getPiTools?: () => ToolInfo[],
  signal?: AbortSignal,
): Promise<ProxyToolResult> {
  throwIfAborted(signal);
  let serverName: string | undefined = serverOverride;
  let toolMeta: ToolMetadata | undefined;
  let autoAuthAttempted = false;
  const prefixMode = state.config.settings?.toolPrefix ?? "server";

  if (serverName && !state.config.mcpServers[serverName]) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "call", error: "server_not_found", server: serverName },
    };
  }

  if (serverName) {
    toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
  } else {
    for (const [server, metadata] of state.toolMetadata.entries()) {
      const found = findToolByName(metadata, toolName);
      if (found) {
        serverName = server;
        toolMeta = found;
        break;
      }
    }
  }

  if (serverName && !toolMeta) {
    const connected = await lazyConnect(state, serverName, signal);
    if (connected) {
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
    } else {
      const needsAuthConnection = state.manager.getConnection(serverName);
      if (needsAuthConnection?.status === "needs-auth") {
        if (!autoAuthAttempted) {
          autoAuthAttempted = true;
          const autoAuth = await attemptAutoAuth(state, serverName);
          if (autoAuth.status === "failed") {
            return {
              content: [{ type: "text" as const, text: autoAuth.message }],
              details: { mode: "call", error: "auth_required", server: serverName, message: autoAuth.message },
            };
          }
          if (autoAuth.status === "success") {
            await state.manager.close(serverName);
            state.failureTracker.delete(serverName);
            const connectedAfterAuth = await lazyConnect(state, serverName, signal);
            if (connectedAfterAuth) {
              toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
              if (!toolMeta) {
                return {
                  content: [{ type: "text" as const, text: `Tool "${toolName}" not found on "${serverName}" after reconnect.` }],
                  details: { mode: "call", error: "tool_not_found_after_reconnect", requestedTool: toolName },
                };
              }
            }
          }
        }

        if (!toolMeta && state.manager.getConnection(serverName)?.status === "needs-auth") {
          const message = getAuthRequiredMessage(state, serverName);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { mode: "call", error: "auth_required", server: serverName, message },
          };
        }
      }

      if (!toolMeta) {
        const failedAgo = getFailureAgeSeconds(state, serverName);
        if (failedAgo !== null) {
          return {
            content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
            details: { mode: "call", error: "server_backoff", server: serverName },
          };
        }
      }
    }
  }

  let prefixMatchedServer: string | undefined;

  if (!serverName && !toolMeta && prefixMode !== "none") {
    const candidates = Object.keys(state.config.mcpServers)
      .map(name => ({ name, prefix: getServerPrefix(name, prefixMode) }))
      .filter(c => c.prefix && toolName.startsWith(c.prefix + "_"))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { name: configuredServer } of candidates) {
      const existingConnection = state.manager.getConnection(configuredServer);
      const failedAgo = getFailureAgeSeconds(state, configuredServer);
      if (failedAgo !== null && existingConnection?.status !== "needs-auth") continue;

      let connected = await lazyConnect(state, configuredServer, signal);
      if (!connected && state.manager.getConnection(configuredServer)?.status === "needs-auth" && !autoAuthAttempted) {
        autoAuthAttempted = true;
        const autoAuth = await attemptAutoAuth(state, configuredServer);
        if (autoAuth.status === "failed") {
          return {
            content: [{ type: "text" as const, text: autoAuth.message }],
            details: { mode: "call", error: "auth_required", server: configuredServer, message: autoAuth.message },
          };
        }
        if (autoAuth.status === "success") {
          await state.manager.close(configuredServer);
          state.failureTracker.delete(configuredServer);
          connected = await lazyConnect(state, configuredServer, signal);
        }
      }

      if (!connected) continue;
      if (!prefixMatchedServer) prefixMatchedServer = configuredServer;
      toolMeta = findToolByName(state.toolMetadata.get(configuredServer), toolName);
      if (toolMeta) {
        serverName = configuredServer;
        break;
      }
    }
  }

  if (!serverName || !toolMeta) {
    const nativeTool = !serverOverride
      ? getPiTools?.().find((tool) => tool.name === toolName && tool.name !== "mcp")
      : undefined;
    if (nativeTool) {
      return {
        content: [{ type: "text" as const, text: `"${toolName}" is a native Pi tool. Call ${toolName} directly instead of using mcp({ tool: "${toolName}" }).` }],
        details: { mode: "call", error: "native_tool", requestedTool: toolName },
      };
    }

    const hintServer = serverName ?? prefixMatchedServer;
    const available = hintServer ? getToolNames(state, hintServer) : [];
    let msg = `Tool "${toolName}" not found.`;
    if (available.length > 0) {
      msg += ` Server "${hintServer}" has: ${available.join(", ")}`;
    } else {
      msg += ` Use mcp({ search: "..." }) to search.`;
    }
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "call", error: "tool_not_found", requestedTool: toolName, hintServer },
    };
  }

  let connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    if (!autoAuthAttempted) {
      autoAuthAttempted = true;
      const autoAuth = await attemptAutoAuth(state, serverName);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { mode: "call", error: "auth_required", server: serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await state.manager.close(serverName);
        state.failureTracker.delete(serverName);
        connection = state.manager.getConnection(serverName);
      }
    }

    if (connection?.status === "needs-auth") {
      const message = getAuthRequiredMessage(state, serverName);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { mode: "call", error: "auth_required", server: serverName, message },
      };
    }
  }
  if (!connection || connection.status !== "connected") {
    const failedAgo = getFailureAgeSeconds(state, serverName);
    if (failedAgo !== null) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
        details: { mode: "call", error: "server_backoff", server: serverName },
      };
    }

    const definition = state.config.mcpServers[serverName];
    if (!definition) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not connected` }],
        details: { mode: "call", error: "server_not_connected", server: serverName },
      };
    }

    try {
      if (state.ui) {
        state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
      }
      connection = await state.manager.connect(serverName, definition, signal);
      if (connection.status === "needs-auth") {
        if (!autoAuthAttempted) {
          autoAuthAttempted = true;
          const autoAuth = await attemptAutoAuth(state, serverName);
          if (autoAuth.status === "failed") {
            return {
              content: [{ type: "text" as const, text: autoAuth.message }],
              details: { mode: "call", error: "auth_required", server: serverName, message: autoAuth.message },
            };
          }
          if (autoAuth.status === "success") {
            await state.manager.close(serverName);
            connection = await state.manager.connect(serverName, definition, signal);
          }
        }

        if (connection.status === "needs-auth") {
          const message = getAuthRequiredMessage(state, serverName);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { mode: "call", error: "auth_required", server: serverName, message },
          };
        }
      }
      state.failureTracker.delete(serverName);
      updateServerMetadata(state, serverName);
      updateMetadataCache(state, serverName);
      updateStatusBar(state);
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
      if (!toolMeta) {
        const available = getToolNames(state, serverName);
        const hint = available.length > 0
          ? `Available tools on "${serverName}": ${available.join(", ")}`
          : `Server "${serverName}" has no tools.`;
        return {
          content: [{ type: "text" as const, text: `Tool "${toolName}" not found on "${serverName}" after reconnect. ${hint}` }],
          details: { mode: "call", error: "tool_not_found_after_reconnect", requestedTool: toolName },
        };
      }
    } catch (error) {
      if (!signal?.aborted) {
        state.failureTracker.set(serverName, Date.now());
      }
      updateStatusBar(state);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
        details: { mode: "call", error: signal?.aborted ? "aborted" : "connect_failed", message },
      };
    }
  }

  let uiSession: UiSessionRuntime | null = null;
  const requestOptions = state.manager.getRequestOptions?.(serverName, signal) ?? (signal ? { signal } : undefined);

  const outputGuardOptions = resolveMcpOutputGuardOptions(state.config.settings);
  const recoverAuthConnection = async () => {
    const current = state.manager.getConnection(serverName);
    if (current?.status === "connected") return current;

    if (!autoAuthAttempted) {
      autoAuthAttempted = true;
      const autoAuth = await attemptAutoAuth(state, serverName);
      if (autoAuth.status === "failed") {
        throw new SessionRecoveryAuthRequiredError(serverName, autoAuth.message);
      }
      if (autoAuth.status === "success") {
        const definition = state.config.mcpServers[serverName];
        if (!definition) return undefined;
        const afterAuth = state.manager.getConnection(serverName);
        if (afterAuth?.status === "connected") return afterAuth;
        if (afterAuth?.status === "needs-auth") {
          await state.manager.close(serverName);
        }
        state.failureTracker.delete(serverName);
        connection = await state.manager.connect(serverName, definition, signal);
        return connection;
      }
    }
    return state.manager.getConnection(serverName);
  };

  try {
    state.manager.touch(serverName);
    state.manager.incrementInFlight(serverName);

    if (toolMeta.resourceUri) {
      const result = await withSessionRecovery(
        { manager: state.manager, config: state.config, signal, onNeedsAuth: recoverAuthConnection },
        serverName,
        (conn) => conn.client.readResource({ uri: toolMeta.resourceUri! }, requestOptions),
      );
      const content = (result.contents ?? []).map(c => ({
        type: "text" as const,
        text: "text" in c ? c.text : ("blob" in c ? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]` : JSON.stringify(c)),
      }));
      const guarded = await guardMcpOutput(content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }], outputGuardOptions);
      return {
        content: guarded.content,
        details: { mode: "call", resourceUri: toolMeta.resourceUri, server: serverName, ...guardedMcpDetails(guarded) },
      };
    }

    uiSession = toolMeta.uiResourceUri
      ? await maybeStartUiSession(state, {
          serverName,
          toolName: toolMeta.originalName,
          toolArgs: args ?? {},
          uiResourceUri: toolMeta.uiResourceUri,
          streamMode: toolMeta.uiStreamMode,
          signal,
          onNeedsAuth: recoverAuthConnection,
        })
      : null;

    const result = await withSessionRecovery(
      { manager: state.manager, config: state.config, signal, onNeedsAuth: recoverAuthConnection },
      serverName,
      (conn) => abortable(conn.client.callTool({
        name: toolMeta.originalName,
        arguments: args ?? {},
        _meta: uiSession?.requestMeta,
      }, undefined, requestOptions), signal),
    );

    if (toolMeta.uiResourceUri) {
      uiSession?.sendToolResult(result as unknown as import("@modelcontextprotocol/sdk/types.js").CallToolResult);

      if (result.isError) {
        const mcpContent = (result.content ?? []) as McpContent[];
        const content = transformMcpContent(mcpContent);
        const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
        const schemaText = toolMeta.inputSchema ? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}` : "";
        const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, prefix: "Error: ", suffix: schemaText, emptyTextFallback: "Tool execution failed", rawMcpResult: result });
        return {
          content: guarded.content,
          details: { mode: "call", error: "tool_error", ...guardedMcpDetails(guarded) },
        };
      }

      const content = resolveMcpResultContent(result as Record<string, unknown>);
      const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
      const uiSummary = summarizeUiSessionResult(uiSession);
      const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, suffix: `\n\n${uiSummary.message}`, rawMcpResult: result });
      return {
        content: guarded.content,
        details: {
          mode: "call",
          ...guardedMcpDetails(guarded),
          server: serverName,
          tool: toolMeta.originalName,
          uiOpen: uiSummary.uiOpen,
          uiViewer: uiSummary.uiViewer,
          uiUrl: uiSummary.uiUrl,
        },
      };
    }

    if (result.isError) {
      const mcpContent = (result.content ?? []) as McpContent[];
      const content = transformMcpContent(mcpContent);
      const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
      const schemaText = toolMeta.inputSchema ? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}` : "";
      const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, prefix: "Error: ", suffix: schemaText, emptyTextFallback: "Tool execution failed", rawMcpResult: result });
      return {
        content: guarded.content,
        details: { mode: "call", error: "tool_error", ...guardedMcpDetails(guarded) },
      };
    }

    const content = resolveMcpResultContent(result as Record<string, unknown>);
    const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
    const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, rawMcpResult: result });
    return {
      content: guarded.content,
      details: { mode: "call", ...guardedMcpDetails(guarded), server: serverName, tool: toolMeta.originalName },
    };
  } catch (error) {
    if (error instanceof SessionRecoveryAuthRequiredError) {
      const message = error.authMessage ?? getAuthRequiredMessage(state, serverName);
      uiSession?.sendToolCancelled(message);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { mode: "call", error: "auth_required", server: serverName, message, autoAuthAttempted },
      };
    }
    if (error instanceof UrlElicitationRequiredError) {
      const action = await state.manager.handleUrlElicitationRequired(serverName, error);
      const message = action === "accept"
        ? "The original MCP tool did not run. Complete the opened browser interaction, then retry the tool."
        : `The URL interaction was ${action === "decline" ? "declined" : "cancelled"}.`;
      uiSession?.sendToolCancelled(message);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { mode: "call", error: "url_elicitation_required", server: serverName, action },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    uiSession?.sendToolCancelled(message);

    const schemaText = toolMeta.inputSchema ? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}` : "";
    const guarded = await guardMcpOutput([{ type: "text" as const, text: message }], { ...outputGuardOptions, prefix: "Failed to call tool: ", suffix: schemaText });

    return {
      content: guarded.content,
      details: { mode: "call", error: "call_failed", message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : message, ...guardedMcpDetails(guarded) },
    };
  } finally {
    if (uiSession?.reused) {
      uiSession.close();
    }
    state.manager.decrementInFlight(serverName);
    state.manager.touch(serverName);
  }
}
