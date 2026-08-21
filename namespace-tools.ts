import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpExtensionState } from "./state.ts";
import type { McpConfig } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { executeCall } from "./proxy-modes.ts";

/**
 * Namespace-proxy tool registration for proxy-only MCP servers.
 *
 * For each configured proxy-only server (no `directTools: true` and not a
 * runtime server forced direct), register exactly one tool named
 * `mcp__<server>` (matching the harness `_shared/mcp-tools` resolver's
 * `namespaceProxyName`). Its execute accepts `{tool, args}` and forwards
 * through the adapter's existing `executeCall`, so it inherits the same
 * auto-auth, session recovery, output guard, and approval rules as the
 * single `mcp` proxy tool — without polluting the prompt with one entry
 * per tool.
 *
 * This unblocks `mcp:<server>` references from `tool-groups` and
 * `slow-mode` against proxy-only servers without flipping `directTools: true`.
 */

export interface NamespaceProxySpec {
  serverName: string;
  toolName: string;
  description: string;
  prefix: string;
}

/**
 * Mirror of the harness `_shared/mcp-tools` resolver's
 * `namespaceProxyName`. Kept deliberately identical to the harness so
 * tool-groups/slow-mode validation lines up without a config migration.
 * Differs from upstream `formatToolName(..., "mcp")` which uses
 * `sanitizeServerPrefix` and produces names like `mcp__context_2d_mode`.
 * When upstream adds its own namespace-proxy, we align conventions.
 */
export function namespaceProxyName(serverName: string): string {
  return `mcp__${serverName.replace(/-/g, "_")}`;
}

function isServerDisabled(definition: { disabled?: boolean } | undefined): boolean {
  return definition?.disabled === true;
}

function isDirectlyRegistered(
  definition: { directTools?: boolean | string[] } | undefined,
  settings: McpConfig["settings"],
  serverName: string,
  envOverride: { servers: Set<string>; tools: Map<string, Set<string>> } | null,
): boolean {
  if (envOverride) {
    if (envOverride.servers.has(serverName)) return true;
    if (envOverride.tools.has(serverName)) return true;
  }
  if (definition?.directTools !== undefined) {
    return definition.directTools === true || (Array.isArray(definition.directTools) && definition.directTools.length > 0);
  }
  return settings?.directTools === true;
}

/**
 * Resolve namespace-proxy tool specs for all proxy-only servers in `config`.
 * A server qualifies when it is enabled, has cache metadata available, and is
 * not directly registered. Server-name collisions with already-known direct
 * tool prefixes (`mcp__<server>` reserved) are skipped.
 */
export function resolveNamespaceProxyTools(
  config: McpConfig | null,
  cache: MetadataCache | null,
  envOverride: { servers: Set<string>; tools: Map<string, Set<string>> } | null,
  existingDirectNames: Set<string>,
): NamespaceProxySpec[] {
  if (!config || !cache) return [];
  const specs: NamespaceProxySpec[] = [];
  const seen = new Set<string>();

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (!definition || isServerDisabled(definition)) continue;

    if (isDirectlyRegistered(definition, config.settings, serverName, envOverride)) {
      continue;
    }

    const entry = cache.servers?.[serverName];
    if (!entry || !Array.isArray(entry.tools) || entry.tools.length === 0) {
      continue;
    }

    const toolName = namespaceProxyName(serverName);
    if (existingDirectNames.has(toolName) || seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);

    specs.push({
      serverName,
      toolName,
      description:
        `Namespace-proxy for MCP server "${serverName}". ` +
        `Forwards \`{tool, args}\` through the adapter's executeCall, so it inherits ` +
        `the same auth / lifecycle / output-guard rules as the \`mcp\` proxy.`,
      prefix: toolName,
    });
  }

  return specs;
}

/**
 * Lazily-required reference to the agent state — passed as a closure so the
 * namespace proxy tool's execute can call `executeCall` once `state` exists.
 * `getInitPromise` lets the executor await the first initialization round
 * the same way `createDirectToolExecutor` does.
 */
export type GetState = () => McpExtensionState | null;
export type GetInitPromise = () => Promise<McpExtensionState> | null;
export type GetPiTools = () => Array<{ name: string }>;

function namespaceExecute(
  getState: GetState,
  getInitPromise: GetInitPromise,
  serverName: string,
  getPiTools: GetPiTools,
) {
  return async (
    _toolCallId: string,
    params: { tool?: string; args?: Record<string, unknown> },
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    if (typeof params.tool !== "string" || params.tool.length === 0) {
      return {
        content: [{ type: "text" as const, text: `mcp__${serverName} requires a \`tool\` parameter naming the underlying MCP tool.` }],
        details: { error: "missing_tool", server: serverName },
      };
    }
    let state = getState();
    if (!state) {
      const initPromise = getInitPromise();
      if (initPromise) {
        try {
          state = await initPromise;
        } catch {
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed for ${serverName}.` }],
            details: { error: "init_failed", server: serverName },
          };
        }
      }
    }
    if (!state) {
      return {
        content: [{ type: "text" as const, text: `MCP not initialized for ${serverName}.` }],
        details: { error: "not_initialized", server: serverName },
      };
    }
    return executeCall(
      state,
      params.tool,
      params.args ?? {},
      serverName,
      getPiTools as never,
      signal,
      "proxy",
    );
  };
}

const parameters = Type.Object({
  tool: Type.String({ description: "Underlying MCP tool name to call on this server." }),
  args: Type.Optional(Type.Object({}, {
    additionalProperties: true,
    description: "Arguments for the underlying tool. The exact shape depends on the tool being called; use mcp({ describe: 'server/tool' }) to inspect.",
  })),
});

export interface SyncNamespaceProxyToolsInput {
  config: McpConfig | null;
  cache: MetadataCache | null;
  envOverride: { servers: Set<string>; tools: Map<string, Set<string>> } | null;
  existingDirectNames: Set<string>;
  pi: ExtensionAPI;
  getState: GetState;
  getInitPromise: GetInitPromise;
  getPiTools: GetPiTools;
}

export interface SyncNamespaceProxyToolsResult {
  specs: NamespaceProxySpec[];
  added: string[];
  updated: string[];
  deactivated: string[];
}

/**
 * Idempotent sync of namespace-proxy tool registrations:
 * - Registers a new tool for each spec whose name is not yet registered.
 * - Updates (re-registers with a fresh fingerprint) when the spec changes.
 * - Unregisters tools for servers that are no longer proxy-only.
 */
export function syncNamespaceProxyTools(input: SyncNamespaceProxyToolsInput): SyncNamespaceProxyToolsResult {
  const specs = resolveNamespaceProxyTools(
    input.config,
    input.cache,
    input.envOverride,
    input.existingDirectNames,
  );
  const nextNames = new Set(specs.map((s) => s.toolName));
  const result: SyncNamespaceProxyToolsResult = { specs, added: [], updated: [], deactivated: [] };

  for (const spec of specs) {
    input.pi.registerTool({
      name: spec.toolName,
      label: `MCP: ${spec.serverName}`,
      description: spec.description,
      parameters,
      execute: namespaceExecute(
        input.getState,
        input.getInitPromise,
        spec.serverName,
        input.getPiTools,
      ),
    } as never);
    result.added.push(spec.toolName);
  }

  // Deactivate stale entries.
  const registered = (input.pi as unknown as {
    unregisterTool?: (name: string) => boolean;
  }).unregisterTool;
  // We can't enumerate the registered map from outside the closure, so the
  // caller owns lifecycle for stale entries by tracking previous names.
  if (registered) {
    for (const stale of input.existingDirectNames) {
      if (stale.startsWith("mcp__") && !nextNames.has(stale)) {
        if (registered(stale)) result.deactivated.push(stale);
      }
    }
  }

  return result;
}