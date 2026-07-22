import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
  GetPromptResult,
  PromptMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpExtensionState } from "./state.ts";
import type { McpConfig, PromptMetadata } from "./types.ts";
import { formatPromptCommandName } from "./types.ts";
import { lazyConnect } from "./init.ts";
import { loadMetadataCache, reconstructPromptMetadata } from "./metadata-cache.ts";
import { logger } from "./logger.ts";
import { truncateAtWord } from "./utils.ts";

/**
 * Resolve prompt metadata for slash-command registration at extension load
 * time. Mirrors `resolveDirectTools`: reads the persistent metadata cache so
 * commands are available before any server connects.
 */
export function resolveCachedPrompts(config: McpConfig): PromptMetadata[] {
  const cache = loadMetadataCache();
  if (!cache?.servers) return [];

  const prefix = config.settings?.toolPrefix ?? "server";
  const specs: PromptMetadata[] = [];

  for (const [serverName, entry] of Object.entries(cache.servers)) {
    if (!config.mcpServers[serverName]) continue;
    if (!entry?.prompts?.length) continue;
    specs.push(...reconstructPromptMetadata(serverName, entry.prompts, prefix));
  }

  return specs;
}

/**
 * Parse a slash-command argument string into positional and named MCP prompt
 * arguments. Supports bash-style quoting so callers can pass values with
 * spaces:
 *
 *   /mcp__demo__brief today "important tasks"
 *   /mcp__demo__brief day=today topic="important tasks"
 */
export function parsePromptArgs(input: string): { positional: string[]; named: Record<string, string> } {
  const positional: string[] = [];
  const named: Record<string, string> = {};

  const tokens = tokenizeArgs(input);
  for (const token of tokens) {
    const eq = findUnquotedEquals(token);
    if (eq > 0) {
      const key = token.slice(0, eq).trim();
      const value = stripQuotes(token.slice(eq + 1).trim());
      if (key) {
        named[key] = value;
        continue;
      }
    }
    positional.push(stripQuotes(token));
  }

  return { positional, named };
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      current += char;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function findUnquotedEquals(token: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "=") return i;
  }
  return -1;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
    return value.slice(1, -1);
  }
  return value;
}

export interface ResolvedPromptArgs {
  ok: boolean;
  /** Present when `ok === true`. */
  args?: Record<string, string>;
  /** Present when `ok === false`. */
  error?: string;
}

/**
 * Map positional and named arguments onto the prompt's declared argument
 * list. Named arguments win over positional when both target the same slot.
 * Missing required arguments produce a helpful usage message that the
 * command handler surfaces via `ctx.ui.notify`.
 */
export function resolvePromptArgs(
  metadata: PromptMetadata,
  parsed: { positional: string[]; named: Record<string, string> },
): ResolvedPromptArgs {
  const args: Record<string, string> = {};

  const declared = metadata.arguments;
  for (let i = 0; i < declared.length; i++) {
    const argDef = declared[i];
    const value = parsed.named[argDef.name] ?? parsed.positional[i];
    if (value !== undefined && value !== "") {
      args[argDef.name] = value;
    }
  }

  // Preserve named arguments the prompt did not declare so servers with
  // permissive schemas still receive them. The MCP spec allows arbitrary
  // string key/values in `prompts/get` params.arguments.
  for (const [key, value] of Object.entries(parsed.named)) {
    if (!(key in args)) args[key] = value;
  }

  const missing = declared.filter(a => a.required && (args[a.name] === undefined || args[a.name] === ""));
  if (missing.length > 0) {
    return { ok: false, error: buildUsageMessage(metadata, missing) };
  }

  return { ok: true, args };
}

function buildUsageMessage(metadata: PromptMetadata, missing: PromptMetadata["arguments"]): string {
  const usage = metadata.arguments
    .map(a => (a.required ? `<${a.name}>` : `[${a.name}]`))
    .join(" ");
  const missingList = missing.map(a => a.name).join(", ");
  return `Missing required argument${missing.length > 1 ? "s" : ""}: ${missingList}.\nUsage: /${metadata.commandName} ${usage}`.trim();
}

/**
 * Flatten a `GetPromptResult` into a single string suitable for
 * `pi.sendUserMessage`. MCP prompts can contain multiple messages with
 * mixed roles; we preserve role attribution as inline markers so the model
 * still sees the intended conversational shape without needing a
 * multi-message replay API on the pi side.
 */
export function formatPromptResult(result: GetPromptResult): string {
  const lines: string[] = [];
  for (const message of result.messages) {
    const text = extractMessageText(message);
    if (!text) continue;
    if (message.role === "user" && result.messages.length === 1) {
      lines.push(text);
    } else {
      lines.push(`[${message.role}] ${text}`);
    }
  }
  return lines.join("\n\n").trim();
}

function extractMessageText(message: PromptMessage): string {
  const content = message.content;
  if (!content || typeof content !== "object") return "";
  switch (content.type) {
    case "text":
      return content.text ?? "";
    case "resource": {
      const resource = content.resource;
      if (!resource) return "";
      if ("text" in resource && typeof resource.text === "string") {
        return `[resource ${resource.uri}]\n${resource.text}`;
      }
      return `[resource ${resource.uri}]`;
    }
    case "resource_link":
      return `[resource_link ${content.uri ?? ""}${content.name ? ` — ${content.name}` : ""}]`;
    case "image":
      return `[image ${content.mimeType ?? "unknown"}${content.data ? " (embedded)" : ""}]`;
    case "audio":
      return `[audio ${content.mimeType ?? "unknown"}]`;
    default:
      return "";
  }
}

/**
 * Build the pi command definition for a single MCP prompt. Registered once
 * per prompt at extension load time from the metadata cache; the same
 * factory is reused by tests to invoke the handler without a running pi.
 */
export function createPromptCommand(
  pi: ExtensionAPI,
  getState: () => McpExtensionState | null,
  metadata: PromptMetadata,
) {
  const description = buildCommandDescription(metadata);

  return {
    description,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const state = getState();
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const live = findLivePromptMetadata(state, metadata.serverName, metadata.originalName) ?? metadata;
      const parsed = parsePromptArgs(args ?? "");
      const resolved = resolvePromptArgs(live, parsed);
      if (!resolved.ok) {
        if (ctx.hasUI) ctx.ui.notify(resolved.error ?? "Invalid prompt arguments", "error");
        return;
      }
      const promptArgs = resolved.args ?? {};

      if (!state.config.mcpServers[metadata.serverName]) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `MCP prompt "${live.originalName}" is no longer configured. Run /mcp reconnect to refresh.`,
            "error",
          );
        }
        return;
      }

      const connected = await lazyConnect(state, metadata.serverName, ctx.signal);
      if (!connected) {
        if (ctx.hasUI) {
          const conn = state.manager.getConnection(metadata.serverName);
          const message = conn?.status === "needs-auth"
            ? `MCP server "${metadata.serverName}" needs authentication. Run /mcp-auth ${metadata.serverName}.`
            : `MCP server "${metadata.serverName}" is not available. Run /mcp reconnect ${metadata.serverName}.`;
          ctx.ui.notify(message, "error");
        }
        return;
      }

      let result: GetPromptResult;
      try {
        result = await state.manager.getPrompt(
          metadata.serverName,
          live.originalName,
          Object.keys(promptArgs).length > 0 ? promptArgs : undefined,
          ctx.signal,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`MCP prompt "${live.originalName}" on ${metadata.serverName} failed: ${message}`);
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP prompt "${live.originalName}" failed: ${message}`, "error");
        }
        return;
      }

      const text = formatPromptResult(result);
      if (!text) {
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP prompt "${live.originalName}" returned no text content.`, "warning");
        }
        return;
      }

      pi.sendUserMessage(text);
    },
  };
}

function findLivePromptMetadata(
  state: McpExtensionState,
  serverName: string,
  originalName: string,
): PromptMetadata | undefined {
  return state.promptMetadata?.get(serverName)?.find(p => p.originalName === originalName);
}

function buildCommandDescription(metadata: PromptMetadata): string {
  const base = metadata.description || metadata.title || `MCP prompt from ${metadata.serverName}`;
  return truncateAtWord(`MCP: ${base}`, 120) || `MCP prompt from ${metadata.serverName}`;
}

/**
 * Public helper used by `/mcp prompts` to render the list of prompts known
 * to the adapter, whether from a live connection or the metadata cache.
 */
export function listAllPromptMetadata(state: McpExtensionState): PromptMetadata[] {
  const flat: PromptMetadata[] = [];
  for (const list of state.promptMetadata?.values() ?? []) flat.push(...list);
  flat.sort((a, b) => a.commandName.localeCompare(b.commandName));
  return flat;
}

// Re-exported so index.ts can format cache-only prompt-command names without
// duplicating the namespace logic.
export { formatPromptCommandName };
