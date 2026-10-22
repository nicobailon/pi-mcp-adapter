import { createHash } from "node:crypto";
import type { DirectToolSpec, McpConfig } from "./types.ts";
import { formatServerNamespace, isServerDisabled, resolveToolPrefix } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { executorAppToolMetadata, isServerCacheValid } from "./metadata-cache.ts";
import { createServerSelectorIndexResolver, resolveServerToolSpecs } from "./direct-tool-surface.ts";

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;

/** A tool registered with Pi as `deferred` under `name`; `prefixedName` stays the adapter's canonical name. */
export interface DeferredToolSpec extends DirectToolSpec {
  name: string;
}

export interface DeferredToolReservations {
  /** Pi tool names the adapter already uses: direct and search-mode tools, namespace proxies. */
  names: ReadonlySet<string>;
  /** Tools with a direct or search-mode registration, which get no second one. */
  directTools: ReadonlyArray<Pick<DirectToolSpec, "serverName" | "originalName" | "resourceUri">>;
  /** The deferredToolKey each name was given to earlier in the session; no other tool gets it. */
  owners?: ReadonlyMap<string, string>;
}

/** The key one MCP tool or resource tool of one server is registered under. */
export function deferredToolKey(serverName: string, originalName: string, resourceUri?: string): string {
  return JSON.stringify([serverName, originalName, resourceUri ?? null]);
}

/** `mcp__<server namespace>__<tool>` with anything but `[A-Za-z0-9_]` turned into `_`, before any hash. */
function plainDeferredToolName(serverName: string, toolName: string): string {
  return `mcp__${formatServerNamespace(serverName)}__${toolName}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * `mcp__<server namespace>__<tool>`, as Pi's built-in MCP names its tools, so the name is also the
 * identifier codemode scripts call it by. Anything but `[A-Za-z0-9_]` becomes `_`; a name that is
 * too long or taken gets an 8-hex hash of the raw server and tool names, and of the URI for a
 * resource tool, so each resource URI gets its own hashed name.
 */
export function formatDeferredToolName(serverName: string, toolName: string, isTaken: (name: string) => boolean, resourceUri?: string): string {
  const name = plainDeferredToolName(serverName, toolName);
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hashInput = `${serverName}\0${toolName}${resourceUri !== undefined ? `\0${resourceUri}` : ""}`;
  const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/**
 * Every model-visible cached tool of every enabled server that has no direct or search-mode
 * registration. The selection a server's `directTools` makes does not apply: it decides what is
 * declared to the model, not what is reachable. Failure backoff does not apply either, so a
 * flapping server does not withdraw and restore its tools.
 */
export function resolveDeferredToolSpecs(
  config: McpConfig,
  cache: MetadataCache | null,
  reserved: DeferredToolReservations,
): DeferredToolSpec[] {
  if (!cache) return [];
  const prefix = config.settings?.toolPrefix ?? "server";
  const direct = new Set(reserved.directTools.map((spec) => deferredToolKey(spec.serverName, spec.originalName, spec.resourceUri)));
  const taken = new Set(reserved.names);
  const selectorIndexFor = createServerSelectorIndexResolver(config, cache, prefix);
  const candidates: DirectToolSpec[] = [];
  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) continue;
    const effectivePrefix = resolveToolPrefix(definition, prefix);
    const serverSpecs = resolveServerToolSpecs(serverName, definition, serverCache, effectivePrefix, true, selectorIndexFor(definition));
    for (const spec of serverSpecs) {
      if (!direct.has(deferredToolKey(spec.serverName, spec.originalName, spec.resourceUri))) candidates.push(spec);
    }
    // Executor app tools are only ever deferred, whatever directTools selects. Their Pi names follow
    // the rules below, which hash every shared name, so list order decides none of them and one
    // whose adapter name a server tool has still gets its own.
    for (const tool of executorAppToolMetadata(serverName, serverCache, effectivePrefix, definition, selectorIndexFor(definition), undefined)) {
      candidates.push({
        serverName,
        originalName: tool.originalName,
        prefixedName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        executorPath: tool.executorPath!,
      });
    }
  }

  // Every tool whose plain name another tool shares gets the hash, as in Pi's built-in MCP, so list
  // order never decides which tool a name calls.
  const plainNameCounts = new Map<string, number>();
  for (const spec of candidates) {
    const plain = plainDeferredToolName(spec.serverName, spec.originalName);
    plainNameCounts.set(plain, (plainNameCounts.get(plain) ?? 0) + 1);
  }
  const specs: DeferredToolSpec[] = [];
  for (const spec of candidates) {
    const key = deferredToolKey(spec.serverName, spec.originalName, spec.resourceUri);
    const unavailable = (candidate: string) => taken.has(candidate) || (reserved.owners?.get(candidate) ?? key) !== key;
    const name = formatDeferredToolName(spec.serverName, spec.originalName,
      (candidate) => unavailable(candidate) || (plainNameCounts.get(candidate) ?? 0) > 1, spec.resourceUri);
    if (unavailable(name)) {
      console.warn(`MCP: skipping deferred tool "${name}" for "${spec.originalName}" on "${spec.serverName}" (name already taken)`);
      continue;
    }
    taken.add(name);
    specs.push({ ...spec, name });
  }
  return specs;
}
