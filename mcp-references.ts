/**
 * Native `mcp:`-reference resolution for pi-mcp-adapter.
 *
 * Translates `mcp:<server>`, `mcp:<server>/<tool>`, and `mcp:<tool>` references
 * into the concrete tool names the adapter registers (via its own
 * `formatToolName` naming) so consumers like tool-groups and slow-mode can
 * validate them against the live registry instead of flagging them as unknown.
 *
 * This module is the package-native home of the resolution logic previously
 * shipped as `agent/extensions/_shared/mcp-tools/` in the user's Pi harness.
 * The contract is preserved: pure resolver with config + metadata cache
 * injected, plus a ready-made `createMcpRefResolver` wrapper that loads them
 * once from the standard discovery sources.
 */
import {
  formatToolName,
  isToolAllowed,
  isServerDisabled,
  resolveToolPrefix,
  type McpConfig,
  type McpSettings,
  type ServerCacheEntry,
  type ServerEntry,
  type ToolPrefix,
} from "./types.ts";
import type { MetadataCache } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { loadMcpConfig } from "./config.ts";
import { loadMetadataCache, parseDirectToolSelectors } from "./metadata-cache.ts";

export interface McpToolReference {
  /** Full original reference, e.g. "mcp:context7" or "mcp:context7/query_docs". */
  raw: string;
  /** Server name when the reference targets a server (or server/tool). */
  server?: string;
  /** Tool name when the reference targets a specific tool (server/tool). */
  tool?: string;
}

export interface McpToolResolution {
  /** Concrete registered tool names, order-preserving, deduplicated. */
  names: string[];
  /** Human-readable reasons for references that could not be resolved. */
  diagnostics: string[];
}

export type McpRefResolver = (refs: string) => string[];

/** Direct-tool override parsed from `MCP_DIRECT_TOOLS` (see `parseDirectToolSelectors`). */
export interface McpDirectOverride {
  servers: Set<string>;
  tools: Map<string, Set<string>>;
}

/**
 * Namespace-proxy tool name for a proxy-only server.
 *
 * Simple underscore form (`context-mode` → `mcp__context_mode`), deliberately
 * identical to the harness resolver and `namespace-tools.ts` registration.
 * Differs from upstream `formatToolName(..., "mcp")` which uses
 * `sanitizeServerPrefix` and produces names like `mcp__context_2d_mode`.
 */
export function namespaceProxyName(serverName: string): string {
  return `mcp__${serverName.replace(/-/g, "_")}`;
}

export function parseMcpReference(raw: string): McpToolReference {
  if (!raw.startsWith("mcp:")) return { raw };
  const rest = raw.slice("mcp:".length).trim();
  if (!rest) return { raw };

  if (rest.includes("/")) {
    const slash = rest.indexOf("/");
    const server = rest.slice(0, slash).trim();
    const tool = rest.slice(slash + 1).trim();
    return {
      ...(server ? { server } : {}),
      ...(tool ? { tool } : {}),
      raw,
    };
  }
  return { raw, server: rest };
}

/** Effective tool-prefix mode for a server definition + global settings. */
function effectivePrefix(settings: McpSettings | undefined, def: ServerEntry | undefined): ToolPrefix {
  return resolveToolPrefix(def, settings?.toolPrefix);
}

/** Whether a server is forced direct by the `MCP_DIRECT_TOOLS` env override. */
function isEnvDirect(serverName: string, envOverride: McpDirectOverride | null | undefined): boolean {
  if (!envOverride) return false;
  return envOverride.servers.has(serverName) || envOverride.tools.has(serverName);
}

/**
 * Whether a server's tools are exposed under direct-tool names. Proxy-only
 * servers (no directTools) expose their tools ONLY through the proxy `mcp`
 * tool, so a bare reference cannot map to a concrete registered tool name.
 */
export function isProxyOnlyServer(
  serverName: string,
  def: ServerEntry | undefined,
  settings: McpSettings | undefined,
  envOverride?: McpDirectOverride | null,
): boolean {
  if (!def) return true;
  if (def.disabled === true) return false;
  if (isEnvDirect(serverName, envOverride)) return false;
  const direct = def.directTools !== undefined ? def.directTools : settings?.directTools;
  return !(direct === true || (Array.isArray(direct) && direct.length > 0));
}

function isServerCacheUsable(entry: ServerCacheEntry | undefined): entry is ServerCacheEntry {
  return !!entry && Array.isArray(entry.tools);
}

function collectServerTools(
  serverName: string,
  def: ServerEntry,
  entry: ServerCacheEntry,
  prefix: ToolPrefix,
  onlyTool?: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  const matches = (baseName: string): boolean =>
    onlyTool === undefined || baseName === onlyTool || formatToolName(baseName, serverName, prefix) === onlyTool;

  const push = (baseName: string): void => {
    if (!matches(baseName)) return;
    if (!isToolAllowed(baseName, serverName, prefix, def.includeTools, def.excludeTools)) return;
    const name = formatToolName(baseName, serverName, prefix);
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  for (const tool of entry.tools ?? []) {
    if (tool?.name) push(tool.name);
  }

  if (def.exposeResources !== false) {
    for (const resource of entry.resources ?? []) {
      if (resource?.name) push(`read_${resourceNameToToolName(resource.name)}`);
    }
  }

  return names;
}

/**
 * Resolve `mcp:`-prefixed references to concrete registered tool names.
 *
 * Mutually validates against config + metadata cache. For a proxy-only server
 * (no directTools), a bare server-level reference resolves to the server's
 * namespace-proxy name rather than failing — the caller decides whether that
 * proxy is actually registered.
 */
export function resolveMcpToolReferences(
  refs: string[],
  config: McpConfig | null,
  cache: MetadataCache | null,
  envOverride?: McpDirectOverride | null,
): McpToolResolution {
  const names: string[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();

  const addName = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };

  for (const raw of refs) {
    if (!raw.startsWith("mcp:")) {
      // Non-mcp references are passed through untouched by this helper.
      addName(raw);
      continue;
    }

    const parsed = parseMcpReference(raw);
    if (!parsed.server) {
      diagnostics.push(`MCP reference "${raw}" is empty after the "mcp:" prefix`);
      continue;
    }

    if (!config) {
      diagnostics.push(`MCP reference "${raw}" cannot be resolved: no MCP config`);
      continue;
    }

    const def = config.mcpServers[parsed.server];
    if (!def) {
      // Bare tool reference (e.g. "mcp:ctx_execute"): seek the tool across servers.
      resolveBareToolReference(raw, parsed.server, config, cache, envOverride, addName, diagnostics);
      continue;
    }
    if (isServerDisabled(def)) {
      diagnostics.push(`MCP reference "${raw}" refers to disabled server "${parsed.server}"`);
      continue;
    }

    const prefix = effectivePrefix(config.settings, def);
    const entry = cache?.servers?.[parsed.server];

    if (!isServerCacheUsable(entry)) {
      diagnostics.push(`MCP reference "${raw}" cannot be resolved: no metadata for server "${parsed.server}"`);
      continue;
    }

    if (isProxyOnlyServer(parsed.server, def, config.settings, envOverride)) {
      // Proxy-only server: resolve to the namespace-proxy name.
      addName(namespaceProxyName(parsed.server));
      continue;
    }

    if (parsed.tool !== undefined) {
      const toolNames = collectServerTools(parsed.server, def, entry, prefix, parsed.tool);
      if (toolNames.length === 0) {
        diagnostics.push(`MCP reference "${raw}" refers to unknown tool "${parsed.tool}" on server "${parsed.server}"`);
        continue;
      }
      for (const n of toolNames) addName(n);
      continue;
    }

    // Server-level expansion to all tools.
    const allNames = collectServerTools(parsed.server, def, entry, prefix);
    if (allNames.length === 0) {
      diagnostics.push(`MCP reference "${raw}" resolves to no tools on server "${parsed.server}"`);
      continue;
    }
    for (const n of allNames) addName(n);
  }

  return { names, diagnostics };
}

/**
 * Resolve a bare tool reference ("mcp:<tool>") that matched no server name by
 * searching every configured server for a tool (or resource) that matches by
 * original name or registered prefixed name. Returns the concrete registered
 * name for direct servers, or the hosting server's namespace-proxy name for
 * proxy-only servers.
 */
function resolveBareToolReference(
  raw: string,
  toolName: string,
  config: McpConfig | null,
  cache: MetadataCache | null,
  envOverride: McpDirectOverride | null | undefined,
  addName: (name: string) => void,
  diagnostics: string[],
): void {
  if (!config || !cache) {
    diagnostics.push(`MCP reference "${raw}" cannot be resolved: no MCP config/cache`);
    return;
  }

  for (const [serverName, def] of Object.entries(config.mcpServers)) {
    if (!def || isServerDisabled(def)) continue;
    const entry = cache.servers?.[serverName];
    if (!isServerCacheUsable(entry)) continue;

    const prefix = effectivePrefix(config.settings, def);
    const matchesTool = (baseName: string): boolean =>
      baseName === toolName || formatToolName(baseName, serverName, prefix) === toolName;
    const hasTool = (entry.tools ?? []).some((t) => t?.name && matchesTool(t.name));
    const hasResource =
      def.exposeResources !== false &&
      (entry.resources ?? []).some((r) => r?.name && matchesTool(`read_${resourceNameToToolName(r.name)}`));

    if (!hasTool && !hasResource) continue;

    if (isProxyOnlyServer(serverName, def, config.settings, envOverride)) {
      addName(namespaceProxyName(serverName));
      return;
    }

    const found = collectServerTools(serverName, def, entry, prefix, toolName);
    for (const n of found) addName(n);
    return;
  }

  diagnostics.push(`MCP reference "${raw}" refers to no matching server or tool`);
}

export interface McpRefResolverDeps {
  /** Config loader override for tests. Defaults to the package `loadMcpConfig`. */
  loadConfig?: (cwd: string) => McpConfig | null;
  /** Cache loader override for tests. Defaults to the package `loadMetadataCache`. */
  loadCache?: () => MetadataCache | null;
  /** Direct-tool selector override for tests. Defaults to `process.env.MCP_DIRECT_TOOLS`. */
  envDirectTools?: string[] | undefined;
}

/**
 * Ready-made `mcp:` reference resolver bound to the merged config + metadata
 * cache. Loads once (memoized, including a null result for an absent config),
 * so repeated calls are cheap and stable for the lifetime of the consumer.
 * A load exception is retried on the next call rather than memoized.
 *
 * Non-`mcp:` references pass through unchanged (`[ref]`); unresolvable `mcp:`
 * references return `[]`.
 */
export function createMcpRefResolver(
  cwd: string = process.cwd(),
  deps: McpRefResolverDeps = {},
): McpRefResolver {
  const loadConfig = deps.loadConfig ?? ((workingDir: string) => loadMcpConfig(undefined, workingDir));
  const loadCache = deps.loadCache ?? loadMetadataCache;
  const envRaw =
    deps.envDirectTools !== undefined ? deps.envDirectTools : process.env.MCP_DIRECT_TOOLS;
  const envValues: string[] | undefined = Array.isArray(envRaw)
    ? envRaw
    : envRaw
      ? envRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

  let loaded = false;
  let config: McpConfig | null = null;
  let cache: MetadataCache | null = null;
  let envOverride: McpDirectOverride | null = null;

  return (ref: string): string[] => {
    if (!ref.startsWith("mcp:")) return [ref];
    if (!loaded) {
      try {
        config = loadConfig(cwd);
        cache = loadCache();
        envOverride = envValues && envValues.length > 0 ? parseDirectToolSelectors(envValues) : null;
        loaded = true;
      } catch {
        // Retry on the next call; never memoize an exception.
        return [];
      }
    }
    if (!config) return [];
    return resolveMcpToolReferences([ref], config, cache, envOverride).names;
  };
}