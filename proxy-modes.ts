import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import { UrlElicitationRequiredError, type Client } from "@modelcontextprotocol/client";
import { createRequire } from "node:module";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata, McpContent } from "./types.ts";
import { getServerPrefix, isServerDisabled, parseUiPromptHandoff } from "./types.ts";
import { lazyConnect, markKeepAliveAfterConnect, notifyToolMetadataUpdated, updateServerMetadata, updateMetadataCache, getFailureAgeSeconds, updateStatusBar, clearFailure, recordFailure } from "./init.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { buildToolMetadata, getToolNames, findToolByName, formatSchema } from "./tool-metadata.ts";
import { renderTsShape } from "./ts-shape.ts";
import { reconstructPromptMetadata } from "./metadata-cache.ts";
import { resolveMcpResultContent, transformMcpContent, transformMcpResourceContents } from "./tool-registrar.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { maybeStartUiSession, summarizeUiSessionResult, type UiSessionRuntime } from "./ui-session.ts";
import { formatAuthRequiredMessage, formatMcpStatus, resolveServerUrl, truncateAtWord } from "./utils.ts";
import { authenticate, completeAuthFromInput, startAuth, supportsOAuth } from "./mcp-auth-flow.ts";
import { SessionRecoveryAuthRequiredError, withSessionRecovery } from "./session-recovery.ts";
import { paginate, rankSuggestions, rankToolMatches, resolveSearchKeywords } from "./search-ranking.ts";
import { ensureToolCallApproved, isToolCallApprovalRequired } from "./tool-approval.ts";

type ProxyToolResult = AgentToolResult<Record<string, unknown>>;
type ClientCallToolResult = Awaited<ReturnType<Client["callTool"]>>;
type ClientReadResourceResult = Awaited<ReturnType<Client["readResource"]>>;

const require = createRequire(import.meta.url);
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

function getToolMatches(metadata: ToolMetadata[] | undefined, toolName: string, exact: boolean): ToolMetadata[] {
  if (!metadata) return [];
  if (exact) return metadata.filter(tool => tool.name === toolName);
  const normalizedName = toolName.replace(/-/g, "_");
  return metadata.filter(tool => tool.name.replace(/-/g, "_") === normalizedName);
}

function getEnabledToolMatches(state: McpExtensionState, toolName: string, exact: boolean): { server: string; tool: ToolMetadata }[] {
  const matches: { server: string; tool: ToolMetadata }[] = [];
  for (const [server, metadata] of state.toolMetadata) {
    if (isServerDisabled(state.config.mcpServers[server])) continue;
    for (const tool of getToolMatches(metadata, toolName, exact)) matches.push({ server, tool });
  }
  return matches;
}

function getSingleToolMatch(metadata: ToolMetadata[] | undefined, toolName: string): ToolMetadata | "ambiguous" | undefined {
  const exactMatches = getToolMatches(metadata, toolName, true);
  const matches = exactMatches.length > 0 ? exactMatches : getToolMatches(metadata, toolName, false);
  return matches.length > 1 ? "ambiguous" : matches[0];
}

function ambiguousToolResult(mode: "call" | "describe", toolName: string): ProxyToolResult {
  const message = `Tool "${toolName}" matches multiple servers. Specify a server.`;
  return {
    content: [{ type: "text" as const, text: message }],
    details: { mode, error: "ambiguous_tool", requestedTool: toolName, message },
  };
}

function disabledResult(mode: string, serverName: string): ProxyToolResult {
  const message = `Server "${serverName}" is disabled. Run /mcp enable ${serverName} and /reload to enable it.`;
  return {
    content: [{ type: "text" as const, text: message }],
    details: { mode, error: "server_disabled", server: serverName, message },
  };
}

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
    `mcp({ action: "auth-complete", server: "${serverName}", args: { redirectUrl: "PASTE_REDIRECT_URL_HERE" } })`,
    "",
    'You can also pass just the `code` query parameter as `args: { code: "PASTE_CODE_HERE" }`. JSON-string args remain supported.',
    portNote.trimEnd(),
  ].filter(Boolean).join("\n");
}

async function attemptAutoAuth(
  state: McpExtensionState,
  serverName: string,
  signal?: AbortSignal,
): Promise<AutoAuthResult> {
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
    return { status: "failed", message: getAuthFailedMessage(state, serverName, message) };
  }
  if (!serverUrl) {
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
      if (signal) {
        await authenticate(serverName, serverUrl, definition, { signal, runtime: state.oauthRuntime });
      } else {
        await authenticate(serverName, serverUrl, definition, { runtime: state.oauthRuntime });
      }
    }
    return { status: "success" };
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
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
  const allContexts = sessions.flatMap((session) => session.messages.contexts);
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

    const contexts = session.messages.contexts;
    if (contexts.length > 0) {
      output.push("\n### Context updates:");
      for (const context of contexts) {
        output.push(`- ${context.summary}${context.truncated ? " (truncated)" : ""}`);
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
      contexts: allContexts,
      handoffs: parsedHandoffs,
      cleared: true,
    },
  };
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
  const servers: Array<{ name: string; status: string; toolCount: number; failedAgo: number | null; disabled?: boolean }> = [];

  for (const name of Object.keys(state.config.mcpServers)) {
    const definition = state.config.mcpServers[name];
    const disabled = isServerDisabled(definition);
    const connection = disabled ? undefined : state.manager.getConnection(name);
    const metadata = disabled ? undefined : state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = disabled ? null : getFailureAgeSeconds(state, name);
    let status = disabled ? "disabled" : "not connected";
    if (!disabled && connection?.status === "connected") {
      status = "connected";
    } else if (!disabled && connection?.status === "needs-auth") {
      status = "needs-auth";
    } else if (!disabled && failedAgo !== null) {
      status = "failed";
    } else if (!disabled && metadata !== undefined) {
      status = "cached";
    }

    servers.push({ name, status, toolCount, failedAgo, ...(disabled ? { disabled: true } : {}) });
  }

  const disabledCount = servers.filter(s => s.disabled).length;
  const enabledServers = servers.filter(s => !s.disabled);
  const totalTools = enabledServers.reduce((sum, s) => sum + s.toolCount, 0);
  const connectedCount = enabledServers.filter(s => s.status === "connected").length;

  let text = `MCP: ${connectedCount}/${enabledServers.length} servers, ${totalTools} tools`;
  if (disabledCount > 0) text += ` (${disabledCount} disabled)`;
  text += "\n\n";
  for (const server of servers) {
    if (server.disabled) {
      text += `⊘ ${server.name} (disabled)\n`;
      continue;
    }
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
    details: { mode: "status", servers, totalTools, connectedCount, disabledCount },
  };
}

export async function executeAuthStart(state: McpExtensionState, serverName: string, signal?: AbortSignal): Promise<ProxyToolResult> {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "auth-start", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("auth-start", serverName);

  try {
    const serverUrl = resolveServerUrl(definition);
    if (!serverUrl || !supportsOAuth(definition)) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" is not configured for OAuth over HTTP.` }],
        details: { mode: "auth-start", error: "oauth_not_supported", server: serverName },
      };
    }

    const { authorizationUrl } = state.authStorageOptions
      ? ownedSignal
        ? await startAuth(serverName, serverUrl, definition, { authStorageOptions: state.authStorageOptions, signal: ownedSignal, runtime: state.oauthRuntime })
        : await startAuth(serverName, serverUrl, definition, { authStorageOptions: state.authStorageOptions, runtime: state.oauthRuntime })
      : ownedSignal
        ? await startAuth(serverName, serverUrl, definition, { signal: ownedSignal, runtime: state.oauthRuntime })
        : await startAuth(serverName, serverUrl, definition, { runtime: state.oauthRuntime });
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

export async function executeAuthComplete(state: McpExtensionState, serverName: string, input: string, signal?: AbortSignal): Promise<ProxyToolResult> {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "auth-complete", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("auth-complete", serverName);

  try {
    const status = state.authStorageOptions
      ? ownedSignal
        ? await completeAuthFromInput(serverName, input, { authStorageOptions: state.authStorageOptions, signal: ownedSignal, runtime: state.oauthRuntime })
        : await completeAuthFromInput(serverName, input, { authStorageOptions: state.authStorageOptions, runtime: state.oauthRuntime })
      : ownedSignal
        ? await completeAuthFromInput(serverName, input, { signal: ownedSignal, runtime: state.oauthRuntime })
        : await completeAuthFromInput(serverName, input, { runtime: state.oauthRuntime });
    if (status !== "authenticated") {
      return {
        content: [{ type: "text" as const, text: `OAuth authentication did not complete for "${serverName}".` }],
        details: { mode: "auth-complete", error: "not_authenticated", server: serverName, status },
      };
    }

    await state.manager.close(serverName);
    clearFailure(state, serverName);
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
  const exactMatches = getEnabledToolMatches(state, toolName, true);
  if (exactMatches.length > 1) return ambiguousToolResult("describe", toolName);
  if (exactMatches.length === 0 && getEnabledToolMatches(state, toolName, false).length > 1) {
    return ambiguousToolResult("describe", toolName);
  }

  let serverName = exactMatches[0]?.server;
  let toolMeta = exactMatches[0]?.tool;
  let disabledMatch: string | undefined;

  if (!toolMeta) {
    for (const [server, metadata] of state.toolMetadata.entries()) {
      const found = findToolByName(metadata, toolName);
      if (!found) continue;
      if (isServerDisabled(state.config.mcpServers[server])) {
        disabledMatch ??= server;
        continue;
      }
      serverName = server;
      toolMeta = found;
      break;
    }
  }

  if (!serverName || !toolMeta) {
    if (disabledMatch) return disabledResult("describe", disabledMatch);
    const suggestions = rankSuggestions(state, toolName, 5);
    const suggestionText = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : "";
    return {
      content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.${suggestionText}` }],
      details: { mode: "describe", error: "tool_not_found", requestedTool: toolName, suggestions },
    };
  }

  const approvalMarker = isToolCallApprovalRequired(state.config, serverName, toolMeta, state.toolMetadata)
    ? " (requires approval)"
    : "";
  let text = `${toolMeta.name}${approvalMarker}\n`;
  text += `Server: ${serverName}\n`;
  if (toolMeta.resourceUri) {
    text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`;
  }
  text += `\n${toolMeta.description || "(no description)"}\n`;

  if (toolMeta.inputSchema && !toolMeta.resourceUri) {
    const shape = renderTsShape(toolMeta.inputSchema);
    text += shape === null ? `\nParameters:\n${formatSchema(toolMeta.inputSchema)}` : `\nShape:\n${shape}`;
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
  limit = 12,
  offset = 0,
): ProxyToolResult {
  const showSchemas = includeSchemas !== false;
  if (server && isServerDisabled(state.config.mcpServers[server])) return disabledResult("search", server);

  let matches: Array<{ server: string; tool: ToolMetadata; score: number }>;
  if (regex) {
    let pattern: RegExp;
    try {
      if (query.length > MAX_REGEX_SEARCH_QUERY_LENGTH) {
        return {
          content: [{ type: "text" as const, text: `Regex query is too long; maximum length is ${MAX_REGEX_SEARCH_QUERY_LENGTH} characters.` }],
          details: { mode: "search", error: "query_too_long", query, maxLength: MAX_REGEX_SEARCH_QUERY_LENGTH },
        };
      }
      pattern = new RegExp(query, "i");
      let safety;
      try {
        const { checkSync } = require("recheck") as typeof import("recheck");
        safety = checkSync(query, "i", REGEX_SAFETY_CHECK_PARAMS);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: "Regex query rejected because safety analysis failed." }],
          details: { mode: "search", error: "unsafe_pattern", query, reason },
        };
      }
      if (safety.status !== "safe") {
        return {
          content: [{ type: "text" as const, text: `Regex query rejected as unsafe (${safety.status}).` }],
          details: { mode: "search", error: "unsafe_pattern", query, safetyStatus: safety.status },
        };
      }
    } catch {
      return {
        content: [{ type: "text" as const, text: `Invalid regex: ${query}` }],
        details: { mode: "search", error: "invalid_pattern", query },
      };
    }

    matches = [];
    const globalPrefix = state.config.settings?.toolPrefix ?? "server";
    for (const [serverName, metadata] of state.toolMetadata.entries()) {
      const definition = state.config.mcpServers[serverName];
      if (isServerDisabled(definition)) continue;
      if (server && serverName !== server) continue;
      for (const tool of metadata) {
        const matched = pattern.test(tool.name) || pattern.test(tool.description)
          || resolveSearchKeywords(definition, tool.originalName, serverName, globalPrefix).some(keyword => pattern.test(keyword));
        if (matched) matches.push({ server: serverName, tool, score: 0 });
      }
    }
  } else if (query.trim().length === 0) {
    if (!server) {
      return {
        content: [{ type: "text" as const, text: "Search query cannot be empty" }],
        details: { mode: "search", error: "empty_query" },
      };
    }
    matches = (state.toolMetadata.get(server) ?? [])
      .map(tool => ({ server, tool, score: 0 }))
      .sort((a, b) => a.tool.name.localeCompare(b.tool.name));
  } else {
    matches = rankToolMatches(state, query, server);
  }

  const page = paginate(matches, offset, limit);
  if (page.total === 0) {
    const connectingServers = server
      ? state.config.mcpServers[server] && state.manager.isConnecting(server) ? [server] : []
      : Object.keys(state.config.mcpServers)
        .filter(name => !isServerDisabled(state.config.mcpServers[name]) && state.manager.isConnecting(name))
        .sort((a, b) => a.localeCompare(b));
    const msg = server ? `No tools matching "${query}" in "${server}"` : `No tools matching "${query}"`;
    const connectingMessage = connectingServers.length === 1
      ? ` Server "${connectingServers[0]}" is still connecting; retry in a moment.`
      : connectingServers.length > 1
        ? ` Servers ${connectingServers.map(name => `"${name}"`).join(", ")} are still connecting; retry in a moment.`
        : "";
    return {
      content: [{ type: "text" as const, text: `${msg}${connectingMessage}` }],
      details: {
        mode: "search",
        matches: [],
        count: 0,
        hasMore: false,
        nextOffset: null,
        query,
        ...(connectingServers.length > 0 ? { connectingServers } : {}),
      },
    };
  }

  let text = `Found ${page.total} tool${page.total === 1 ? "" : "s"} matching "${query}":\n\n`;
  for (const match of page.items) {
    const approvalMarker = isToolCallApprovalRequired(state.config, match.server, match.tool, state.toolMetadata)
      ? " (requires approval)"
      : "";
    if (showSchemas) {
      text += `${match.tool.name}${approvalMarker}\n`;
      text += `  ${match.tool.description || "(no description)"}\n`;
      if (match.tool.inputSchema && !match.tool.resourceUri) {
        const shape = renderTsShape(match.tool.inputSchema);
        text += shape === null
          ? `\n  Parameters:\n${formatSchema(match.tool.inputSchema, "    ")}\n`
          : `\n  Shape:\n${shape.split("\n").map(line => `    ${line}`).join("\n")}\n`;
      } else if (match.tool.resourceUri) {
        text += "  No parameters (resource tool).\n";
      }
      text += "\n";
    } else {
      text += `- ${match.tool.name}${approvalMarker}`;
      if (match.tool.description) text += ` - ${truncateAtWord(match.tool.description, 50)}`;
      text += "\n";
    }
  }
  if (page.hasMore) text += `\n${page.items.length} of ${page.total} — offset: ${page.nextOffset} for more\n`;

  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: {
      mode: "search",
      matches: page.items.map(match => ({ server: match.server, tool: match.tool.name, score: match.score })),
      count: page.total,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      query,
    },
  };
}

export function executeList(state: McpExtensionState, server: string): ProxyToolResult {
  const definition = state.config.mcpServers[server];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("list", server);

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
  const definition = state.config.mcpServers[server];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "instructions", server, error: "not_found" },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("instructions", server);

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
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }
  if (isServerDisabled(definition)) return disabledResult("connect", serverName);

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", formatMcpStatus(state.config, `connecting to ${serverName}...`));
    }
    const currentConnection = state.manager.getConnection(serverName);
    let connection = currentConnection?.status === "connected"
      ? await state.manager.reconnect(serverName, definition, currentConnection, ownedSignal)
      : await state.manager.connect(serverName, definition, ownedSignal);
    if (connection.status === "needs-auth") {
      const autoAuth = await attemptAutoAuth(state, serverName, ownedSignal);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { mode: "connect", error: "auth_required", server: serverName, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await state.manager.close(serverName);
        throwIfAborted(ownedSignal);
        connection = ownedSignal
          ? await state.manager.connect(serverName, definition, ownedSignal)
          : await state.manager.connect(serverName, definition);
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
    const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix, state.config.mcpServers, state.toolMetadata);
    state.toolMetadata.set(serverName, metadata);
    if (!connection.promptDiscoveryFailed) {
      state.promptMetadata?.set(serverName, reconstructPromptMetadata(serverName, connection.prompts ?? [], prefix, definition));
      state.promptMetadataLive?.add(serverName);
    }
    if (connection.instructions) {
      state.serverInstructions.set(serverName, connection.instructions);
    } else {
      state.serverInstructions.delete(serverName);
    }
    updateMetadataCache(state, serverName);
    notifyToolMetadataUpdated(state, serverName, "proxy-connect");
    markKeepAliveAfterConnect(state, serverName);
    clearFailure(state, serverName);
    updateStatusBar(state);
    return executeList(state, serverName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAbortError(error, ownedSignal)) recordFailure(state, serverName, message);
    updateStatusBar(state);
    return {
      content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
      details: { mode: "connect", error: isAbortError(error, ownedSignal) ? "aborted" : "connect_failed", server: serverName, message },
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
  origin?: "proxy" | "script",
): Promise<ProxyToolResult> {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  let serverName: string | undefined = serverOverride;
  let toolMeta: ToolMetadata | undefined;
  let autoAuthAttempted = false;
  const prefixMode = state.config.settings?.toolPrefix ?? "server";
  const disabledCallResult = (disabledServer: string, metadata?: ToolMetadata): ProxyToolResult => {
    if (!metadata) {
      const message = `Server "${disabledServer}" is disabled. Run /mcp enable ${disabledServer} and /reload to enable it.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { mode: "call", error: "server_disabled", server: disabledServer, requestedTool: toolName, message },
      };
    }
    const message = `Server "${disabledServer}" is disabled. Run /mcp enable ${disabledServer} and /reload to enable it.`;
    const identity = metadata.resourceUri
      ? { server: disabledServer, resourceUri: metadata.resourceUri }
      : { server: disabledServer, tool: metadata.originalName };
    return {
      content: [{ type: "text" as const, text: message }],
      details: { mode: "call", error: "server_disabled", ...identity, message },
    };
  };

  if (serverName && !state.config.mcpServers[serverName]) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "call", error: "server_not_found", server: serverName, requestedTool: toolName },
    };
  }
  if (serverName) {
    const match = getSingleToolMatch(state.toolMetadata.get(serverName), toolName);
    if (match === "ambiguous") return ambiguousToolResult("call", toolName);
    toolMeta = match;
    if (isServerDisabled(state.config.mcpServers[serverName])) {
      return disabledCallResult(serverName, toolMeta);
    }
  } else {
    const exactMatches = getEnabledToolMatches(state, toolName, true);
    if (exactMatches.length > 1) return ambiguousToolResult("call", toolName);
    if (exactMatches.length === 0 && getEnabledToolMatches(state, toolName, false).length > 1) {
      return ambiguousToolResult("call", toolName);
    }

    let disabledMatch: { serverName: string; toolMeta: ToolMetadata } | undefined;
    for (const [server, metadata] of state.toolMetadata.entries()) {
      const found = metadata.find(tool => tool.name === toolName);
      if (!found) continue;
      if (isServerDisabled(state.config.mcpServers[server])) {
        disabledMatch ??= { serverName: server, toolMeta: found };
        continue;
      }
      serverName = server;
      toolMeta = found;
      break;
    }
    if (!toolMeta && !disabledMatch) {
      for (const [server, metadata] of state.toolMetadata.entries()) {
        const found = findToolByName(metadata, toolName);
        if (!found) continue;
        if (isServerDisabled(state.config.mcpServers[server])) {
          disabledMatch ??= { serverName: server, toolMeta: found };
          continue;
        }
        serverName = server;
        toolMeta = found;
        break;
      }
    }
    if (!toolMeta && disabledMatch) return disabledCallResult(disabledMatch.serverName, disabledMatch.toolMeta);
  }

  if (serverName && !toolMeta) {
    const connected = await lazyConnect(state, serverName, ownedSignal);
    if (connected) {
      const match = getSingleToolMatch(state.toolMetadata.get(serverName), toolName);
      if (match === "ambiguous") return ambiguousToolResult("call", toolName);
      toolMeta = match;
    } else {
      const needsAuthConnection = state.manager.getConnection(serverName);
      if (needsAuthConnection?.status === "needs-auth") {
        if (!autoAuthAttempted) {
          autoAuthAttempted = true;
          const autoAuth = await attemptAutoAuth(state, serverName, ownedSignal);
          if (autoAuth.status === "failed") {
            return {
              content: [{ type: "text" as const, text: autoAuth.message }],
              details: { mode: "call", error: "auth_required", server: serverName, requestedTool: toolName, message: autoAuth.message },
            };
          }
          if (autoAuth.status === "success") {
            await state.manager.close(serverName);
            clearFailure(state, serverName);
            const connectedAfterAuth = await lazyConnect(state, serverName, ownedSignal);
            if (connectedAfterAuth) {
              const match = getSingleToolMatch(state.toolMetadata.get(serverName), toolName);
              if (match === "ambiguous") return ambiguousToolResult("call", toolName);
              toolMeta = match;
              if (!toolMeta) {
                const suggestions = rankSuggestions(state, toolName, 5);
                const suggestionText = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : "";
                return {
                  content: [{ type: "text" as const, text: `Tool "${toolName}" not found on "${serverName}" after reconnect.${suggestionText}` }],
                  details: { mode: "call", error: "tool_not_found_after_reconnect", server: serverName, requestedTool: toolName, suggestions },
                };
              }
            }
          }
        }

        if (!toolMeta && state.manager.getConnection(serverName)?.status === "needs-auth") {
          const message = getAuthRequiredMessage(state, serverName);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { mode: "call", error: "auth_required", server: serverName, requestedTool: toolName, message },
          };
        }
      }

      if (!toolMeta) {
        const failedAgo = getFailureAgeSeconds(state, serverName);
        if (failedAgo !== null) {
          return {
            content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
            details: { mode: "call", error: "server_backoff", server: serverName, requestedTool: toolName },
          };
        }
      }
    }
  }

  let prefixMatchedServer: string | undefined;

  if (!serverName && !toolMeta && prefixMode !== "none") {
    const lazyExactMatches: { serverName: string; toolMeta: ToolMetadata }[] = [];
    const lazyFallbackMatches: { serverName: string; toolMeta: ToolMetadata }[] = [];
    const candidates = Object.keys(state.config.mcpServers)
      .filter(name => !isServerDisabled(state.config.mcpServers[name]))
      .map(name => ({ name, prefix: getServerPrefix(name, prefixMode) }))
      .filter(c => c.prefix && toolName.startsWith(c.prefix + "_"))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { name: configuredServer } of candidates) {
      const existingConnection = state.manager.getConnection(configuredServer);
      const failedAgo = getFailureAgeSeconds(state, configuredServer);
      if (failedAgo !== null && existingConnection?.status !== "needs-auth") continue;

      let connected = await lazyConnect(state, configuredServer, ownedSignal);
      if (!connected && state.manager.getConnection(configuredServer)?.status === "needs-auth" && !autoAuthAttempted) {
        autoAuthAttempted = true;
        const autoAuth = await attemptAutoAuth(state, configuredServer, ownedSignal);
        if (autoAuth.status === "failed") {
          return {
            content: [{ type: "text" as const, text: autoAuth.message }],
            details: { mode: "call", error: "auth_required", server: configuredServer, requestedTool: toolName, message: autoAuth.message },
          };
        }
        if (autoAuth.status === "success") {
          await state.manager.close(configuredServer);
          clearFailure(state, configuredServer);
          connected = await lazyConnect(state, configuredServer, ownedSignal);
        }
      }

      if (!connected) continue;
      if (!prefixMatchedServer) prefixMatchedServer = configuredServer;
      const metadata = state.toolMetadata.get(configuredServer);
      const exactMatches = getToolMatches(metadata, toolName, true);
      if (exactMatches.length > 1) return ambiguousToolResult("call", toolName);
      if (exactMatches.length === 1) {
        lazyExactMatches.push({ serverName: configuredServer, toolMeta: exactMatches[0]! });
        continue;
      }
      const fallbackMatches = getToolMatches(metadata, toolName, false);
      if (fallbackMatches.length > 1) return ambiguousToolResult("call", toolName);
      if (fallbackMatches.length === 1) lazyFallbackMatches.push({ serverName: configuredServer, toolMeta: fallbackMatches[0]! });
    }
    const lazyMatches = lazyExactMatches.length > 0 ? lazyExactMatches : lazyFallbackMatches;
    if (lazyMatches.length > 1) return ambiguousToolResult("call", toolName);
    if (lazyMatches.length === 1) {
      serverName = lazyMatches[0]!.serverName;
      toolMeta = lazyMatches[0]!.toolMeta;
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
    const suggestions = rankSuggestions(state, toolName, 5);
    if (suggestions.length > 0) msg += ` Did you mean: ${suggestions.join(", ")}`;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "call", error: "tool_not_found", requestedTool: toolName, hintServer, suggestions },
    };
  }

  const callIdentity = toolMeta.resourceUri
    ? { server: serverName, resourceUri: toolMeta.resourceUri }
    : { server: serverName, tool: toolMeta.originalName };

  let connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    if (!autoAuthAttempted) {
      autoAuthAttempted = true;
      const autoAuth = await attemptAutoAuth(state, serverName, ownedSignal);
      if (autoAuth.status === "failed") {
        return {
          content: [{ type: "text" as const, text: autoAuth.message }],
          details: { mode: "call", error: "auth_required", ...callIdentity, message: autoAuth.message },
        };
      }
      if (autoAuth.status === "success") {
        await state.manager.close(serverName);
        clearFailure(state, serverName);
        connection = state.manager.getConnection(serverName);
      }
    }

    if (connection?.status === "needs-auth") {
      const message = getAuthRequiredMessage(state, serverName);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { mode: "call", error: "auth_required", ...callIdentity, message },
      };
    }
  }
  if (!connection || connection.status !== "connected") {
    const failedAgo = getFailureAgeSeconds(state, serverName);
    if (failedAgo !== null) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
        details: { mode: "call", error: "server_backoff", ...callIdentity },
      };
    }

    const definition = state.config.mcpServers[serverName];
    if (!definition) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not connected` }],
        details: { mode: "call", error: "server_not_connected", ...callIdentity },
      };
    }

    try {
      if (state.ui) {
        state.ui.setStatus("mcp", formatMcpStatus(state.config, `connecting to ${serverName}...`));
      }
      connection = await state.manager.connect(serverName, definition, ownedSignal);
      if (connection.status === "needs-auth") {
        if (!autoAuthAttempted) {
          autoAuthAttempted = true;
          const autoAuth = await attemptAutoAuth(state, serverName, ownedSignal);
          if (autoAuth.status === "failed") {
            return {
              content: [{ type: "text" as const, text: autoAuth.message }],
              details: { mode: "call", error: "auth_required", ...callIdentity, message: autoAuth.message },
            };
          }
          if (autoAuth.status === "success") {
            await state.manager.close(serverName);
            connection = await state.manager.connect(serverName, definition, ownedSignal);
          }
        }

        if (connection.status === "needs-auth") {
          const message = getAuthRequiredMessage(state, serverName);
          return {
            content: [{ type: "text" as const, text: message }],
            details: { mode: "call", error: "auth_required", ...callIdentity, message },
          };
        }
      }
      clearFailure(state, serverName);
      updateServerMetadata(state, serverName);
      updateMetadataCache(state, serverName);
      notifyToolMetadataUpdated(state, serverName, "proxy-call-reconnect");
      markKeepAliveAfterConnect(state, serverName);
      updateStatusBar(state);
      const match = getSingleToolMatch(state.toolMetadata.get(serverName), toolName);
      if (match === "ambiguous") return ambiguousToolResult("call", toolName);
      toolMeta = match;
      if (!toolMeta) {
        const available = getToolNames(state, serverName);
        const hint = available.length > 0
          ? `Available tools on "${serverName}": ${available.join(", ")}`
          : `Server "${serverName}" has no tools.`;
        const suggestions = rankSuggestions(state, toolName, 5);
        const suggestionText = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : "";
        return {
          content: [{ type: "text" as const, text: `Tool "${toolName}" not found on "${serverName}" after reconnect. ${hint}${suggestionText}` }],
          details: { mode: "call", error: "tool_not_found_after_reconnect", server: serverName, requestedTool: toolName, suggestions },
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isAbortError(error, ownedSignal)) recordFailure(state, serverName, message);
      updateStatusBar(state);
      return {
        content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
        details: { mode: "call", error: isAbortError(error, ownedSignal) ? "aborted" : "connect_failed", ...callIdentity, message },
      };
    }
  }

  if (isServerDisabled(state.config.mcpServers[serverName])) {
    return disabledCallResult(serverName, toolMeta);
  }

  const approval = await ensureToolCallApproved(
    state,
    serverName,
    toolMeta,
    args,
    ownedSignal,
    origin ?? (toolMeta.resourceUri ? "resource" : "proxy"),
  );
  if (approval.ok === false) {
    const denied = approval.reason === "denied";
    const message = denied
      ? `The user declined approval to run MCP tool "${toolMeta.originalName}" on server "${serverName}".`
      : `MCP tool "${toolMeta.originalName}" on server "${serverName}" is approval-gated and requires an interactive session.`;
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        mode: "call",
        error: denied ? "approval_denied" : "approval_required",
        server: serverName,
        tool: toolMeta.originalName,
      },
    };
  }

  let uiSession: UiSessionRuntime | null = null;
  const requestOptions = state.manager.getRequestOptions?.(serverName, ownedSignal) ?? (ownedSignal ? { signal: ownedSignal } : undefined);

  const outputGuardOptions = resolveMcpOutputGuardOptions(state.config.settings);
  const recoverAuthConnection = async () => {
    const current = state.manager.getConnection(serverName);
    if (current?.status === "connected") return current;

    if (!autoAuthAttempted) {
      autoAuthAttempted = true;
      const autoAuth = await attemptAutoAuth(state, serverName, ownedSignal);
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
        clearFailure(state, serverName);
        connection = await state.manager.connect(serverName, definition, ownedSignal);
        return connection;
      }
    }
    return state.manager.getConnection(serverName);
  };

  try {
    state.manager.touch(serverName);
    state.manager.incrementInFlight(serverName);

    if (toolMeta.resourceUri) {
      const result = await withSessionRecovery<ClientReadResourceResult>(
        {
          manager: state.manager,
          config: state.config,
          ...(ownedSignal ? { signal: ownedSignal } : {}),
          onNeedsAuth: recoverAuthConnection,
        },
        serverName,
        (conn) => conn.client.readResource({ uri: toolMeta.resourceUri! }, requestOptions),
      );
      const content = transformMcpResourceContents(result.contents ?? [], state.owner?.signal);
      const guarded = await guardMcpOutput(content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }], outputGuardOptions);
      return {
        content: guarded.content,
        details: { mode: "call", ...callIdentity, ...guardedMcpDetails(guarded) },
      };
    }

    uiSession = toolMeta.uiResourceUri
      ? await maybeStartUiSession(state, {
          serverName,
          toolName: toolMeta.originalName,
          toolArgs: args ?? {},
          uiResourceUri: toolMeta.uiResourceUri,
          ...(toolMeta.uiStreamMode !== undefined ? { streamMode: toolMeta.uiStreamMode } : {}),
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
      serverName,
      (conn) => abortable(conn.client.callTool({
        name: toolMeta.originalName,
        arguments: args ?? {},
        _meta: uiSession?.requestMeta,
      }, requestOptions), ownedSignal),
    );

    if (toolMeta.uiResourceUri) {
      uiSession?.sendToolResult(result as unknown as import("@modelcontextprotocol/client").CallToolResult);

      if (result.isError) {
        const mcpContent = (result.content ?? []) as McpContent[];
        const content = transformMcpContent(mcpContent, state.owner?.signal);
        const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
        const schemaText = toolMeta.inputSchema ? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}` : "";
        const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, prefix: "Error: ", suffix: schemaText, emptyTextFallback: "Tool execution failed", rawMcpResult: result });
        return {
          content: guarded.content,
          details: { mode: "call", error: "tool_error", ...callIdentity, ...guardedMcpDetails(guarded) },
        };
      }

      const content = resolveMcpResultContent(result as Record<string, unknown>, state.owner?.signal);
      const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
      const uiSummary = summarizeUiSessionResult(uiSession);
      const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, suffix: `\n\n${uiSummary.message}`, rawMcpResult: result });
      return {
        content: guarded.content,
        details: {
          mode: "call",
          ...guardedMcpDetails(guarded),
          ...callIdentity,
          uiOpen: uiSummary.uiOpen,
          uiViewer: uiSummary.uiViewer,
          uiUrl: uiSummary.uiUrl,
        },
      };
    }

    if (result.isError) {
      const mcpContent = (result.content ?? []) as McpContent[];
      const content = transformMcpContent(mcpContent, state.owner?.signal);
      const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
      const schemaText = toolMeta.inputSchema ? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}` : "";
      const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, prefix: "Error: ", suffix: schemaText, emptyTextFallback: "Tool execution failed", rawMcpResult: result });
      return {
        content: guarded.content,
        details: { mode: "call", error: "tool_error", ...callIdentity, ...guardedMcpDetails(guarded) },
      };
    }

    const content = resolveMcpResultContent(result as Record<string, unknown>, state.owner?.signal);
    const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
    const guarded = await guardMcpOutput(outputContent, { ...outputGuardOptions, rawMcpResult: result });
    return {
      content: guarded.content,
      details: { mode: "call", ...guardedMcpDetails(guarded), ...callIdentity },
    };
  } catch (error) {
    if (error instanceof SessionRecoveryAuthRequiredError) {
      const message = error.authMessage ?? getAuthRequiredMessage(state, serverName);
      uiSession?.sendToolCancelled(message);
      return {
        content: [{ type: "text" as const, text: message }],
        details: { mode: "call", error: "auth_required", ...callIdentity, message, autoAuthAttempted },
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
        details: { mode: "call", error: "url_elicitation_required", ...callIdentity, action },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    uiSession?.sendToolCancelled(message);

    const schemaText = toolMeta.inputSchema ? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}` : "";
    const guarded = await guardMcpOutput([{ type: "text" as const, text: message }], { ...outputGuardOptions, prefix: "Failed to call tool: ", suffix: schemaText });

    return {
      content: guarded.content,
      details: { mode: "call", error: isAbortError(error, ownedSignal) ? "aborted" : "call_failed", ...callIdentity, message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : message, ...guardedMcpDetails(guarded) },
    };
  } finally {
    if (uiSession?.reused) {
      uiSession.close();
    }
    state.manager.decrementInFlight(serverName);
    state.manager.touch(serverName);
  }
}
