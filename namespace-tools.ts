import type { AgentToolResult, ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type McpConfig } from "./types.ts";
import { isServerCacheValid, type MetadataCache } from "./metadata-cache.ts";
import { executeCall } from "./proxy-modes.ts";
import { createMcpProxyToolCallRenderer, createMcpToolResultRenderer, resolveMcpToolRenderOptions, type McpToolRenderOptions, type RenderTheme, type McpToolRenderContext } from "./tool-result-renderer.ts";
export { namespaceProxyName } from "./mcp-references.ts";
import { hasCallableCachedTargets, isMcpServerDirectlyRegistered, namespaceProxyName, type DirectToolSelectorOverride } from "./mcp-references.ts";

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
}

function namespaceProxyCandidate(
  config: McpConfig,
  cache: MetadataCache,
  envOverride: DirectToolSelectorOverride | null,
  existingDirectNames: Set<string>,
  serverName: string,
): NamespaceProxySpec | null {
  const definition = config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) return null;
  if (isMcpServerDirectlyRegistered(definition, config.settings, serverName, envOverride)) return null;
  const entry = cache.servers?.[serverName];
  if (!entry || !isServerCacheValid(entry, definition) || !hasCallableCachedTargets(entry, definition)) return null;
  const toolName = namespaceProxyName(serverName);
  if (existingDirectNames.has(toolName)) return null;
  return {
    serverName,
    toolName,
    description:
      `Namespace-proxy for MCP server "${serverName}". ` +
      `Forwards \`{tool, args}\` through the adapter's executeCall, so it inherits ` +
      `the same auth / lifecycle / output-guard rules as the \`mcp\` proxy.`,
  };
}

function filterCollidingNamespaceProxyTools(candidates: NamespaceProxySpec[]): NamespaceProxySpec[] {
  const names = new Map<string, NamespaceProxySpec[]>();
  for (const spec of candidates) {
    const colliding = names.get(spec.toolName) ?? [];
    colliding.push(spec);
    names.set(spec.toolName, colliding);
  }
  return candidates.filter((spec) => {
    const colliding = names.get(spec.toolName)!;
    if (colliding.length === 1) return true;
    if (colliding[0] === spec) {
      console.warn(`MCP: skipping namespace proxy "${spec.toolName}" because servers ${colliding.map(({ serverName }) => `"${serverName}"`).sort().join(", ")} normalize to the same name`);
    }
    return false;
  });
}

function resolveNamespaceProxyTools(
  config: McpConfig | null,
  cache: MetadataCache | null,
  envOverride: DirectToolSelectorOverride | null,
  existingDirectNames: Set<string>,
  unavailableServers: ReadonlySet<string>,
): NamespaceProxySpec[] {
  if (!config || !cache) return [];
  return filterCollidingNamespaceProxyTools(
    Object.keys(config.mcpServers)
      .map((serverName) => namespaceProxyCandidate(config, cache, envOverride, existingDirectNames, serverName))
      .filter((spec): spec is NamespaceProxySpec => spec !== null),
  ).filter((spec) => !unavailableServers.has(spec.serverName));
}

/**
 * Lazily-required reference to the agent state — passed as a closure so the
 * namespace proxy tool's execute can call `executeCall` once `state` exists.
 * `getInitPromise` lets the executor await the first initialization round
 * the same way `createDirectToolExecutor` does.
 */
export type GetState = () => McpExtensionState | null;
export type GetInitPromise = () => Promise<McpExtensionState> | null;
export type GetPiTools = () => ToolInfo[];

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
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed for ${serverName}: ${message}` }],
            details: { error: "init_failed", server: serverName, message },
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
      getPiTools,
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
  envOverride: DirectToolSelectorOverride | null;
  existingDirectNames: Set<string>;
  activeDirectNames?: ReadonlySet<string>;
  existingNamespaceNames: Set<string>;
  unavailableServers?: ReadonlySet<string>;
  pi: ExtensionAPI;
  getState: GetState;
  getInitPromise: GetInitPromise;
  getPiTools: GetPiTools;
  renderOptions?: McpToolRenderOptions;
  renderShell?: "self" | "default";
  renderResult?: unknown;
}

export interface SyncNamespaceProxyToolsResult {
  specs: NamespaceProxySpec[];
  added: string[];
  updated: string[];
  deactivated: string[];
}

function createNamespaceRenderCall(renderOptions: McpToolRenderOptions, serverName: string) {
  const renderCall = createMcpProxyToolCallRenderer(renderOptions);
  return (args: { tool?: string; args?: Record<string, unknown> }, theme?: RenderTheme, context?: McpToolRenderContext) => renderCall({
    ...(args.tool !== undefined ? { tool: args.tool } : {}),
    ...(args.args !== undefined ? { args: args.args } : {}),
    server: serverName,
  }, theme, context);
}

function registerNamespaceProxyTool(
  input: SyncNamespaceProxyToolsInput,
  spec: NamespaceProxySpec,
  renderOptions: McpToolRenderOptions,
  renderShell: "self" | "default",
  renderResult: unknown,
): void {
  (input.pi.registerTool as (tool: unknown) => unknown)({
    name: spec.toolName,
    label: `MCP: ${spec.serverName}`,
    description: spec.description,
    promptSnippet: `MCP namespace proxy for ${spec.serverName}`,
    parameters,
    renderShell,
    renderCall: createNamespaceRenderCall(renderOptions, spec.serverName),
    renderResult,
    execute: namespaceExecute(
      input.getState,
      input.getInitPromise,
      spec.serverName,
      input.getPiTools,
    ),
  });
}

function getActiveToolsForStaleCleanup(pi: ExtensionAPI, staleNames: string[]): string[] | undefined {
  if (staleNames.length === 0) return undefined;
  try {
    return pi.getActiveTools?.();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Action methods cannot be called during extension loading")) return undefined;
    throw error;
  }
}

function deactivateStaleNamespaceTools(input: SyncNamespaceProxyToolsInput, nextNames: Set<string>): string[] {
  const activeDirectNames = input.activeDirectNames ?? new Set<string>();
  const staleNames = [...input.existingNamespaceNames].filter(
    (name) => !nextNames.has(name) && !activeDirectNames.has(name),
  );
  const deactivated: string[] = [];
  const unregisterTool = (input.pi as unknown as {
    unregisterTool?: (name: string) => boolean;
  }).unregisterTool;
  for (const stale of staleNames) {
    if (unregisterTool?.(stale)) deactivated.push(stale);
  }
  const activeTools = getActiveToolsForStaleCleanup(input.pi, staleNames);
  if (!activeTools) return deactivated;

  const stale = new Set(staleNames);
  const nextActiveTools = activeTools.filter((name) => !stale.has(name));
  if (nextActiveTools.length === activeTools.length) return deactivated;

  input.pi.setActiveTools(nextActiveTools);
  for (const name of staleNames) {
    if (!deactivated.includes(name)) deactivated.push(name);
  }
  return deactivated;
}

/**
 * Idempotent sync of namespace-proxy tool registrations.
 */
export function syncNamespaceProxyTools(input: SyncNamespaceProxyToolsInput): SyncNamespaceProxyToolsResult {
  const specs = resolveNamespaceProxyTools(
    input.config,
    input.cache,
    input.envOverride,
    input.existingDirectNames,
    input.unavailableServers ?? new Set(),
  );
  const nextNames = new Set(specs.map((s) => s.toolName));
  const result: SyncNamespaceProxyToolsResult = { specs, added: [], updated: [], deactivated: [] };
  const renderOptions = input.renderOptions ?? resolveMcpToolRenderOptions();
  const renderShell = input.renderShell ?? (renderOptions.resultRendering === "compact" ? "self" : "default");
  const renderResult = input.renderResult ?? createMcpToolResultRenderer(renderOptions);

  for (const spec of specs) {
    registerNamespaceProxyTool(input, spec, renderOptions, renderShell, renderResult);
    (input.existingNamespaceNames.has(spec.toolName) ? result.updated : result.added).push(spec.toolName);
  }

  result.deactivated.push(...deactivateStaleNamespaceTools(input, nextNames));

  return result;
}
