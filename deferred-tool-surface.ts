import { createHash } from "node:crypto";
import type { DirectToolSpec, McpConfig } from "./types.ts";
import { formatServerNamespace, isServerDisabled, resolveToolPrefix } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { isServerCacheValid } from "./metadata-cache.ts";
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
}

/** The key one MCP tool or resource tool of one server is registered under. */
export function deferredToolKey(serverName: string, originalName: string, resourceUri?: string): string {
  return JSON.stringify([serverName, originalName, resourceUri ?? null]);
}

/**
 * `mcp__<server namespace>__<tool>`, as Pi's built-in MCP names its tools, so the name is also the
 * identifier codemode scripts call it by. Anything but `[A-Za-z0-9_]` becomes `_`; a name that is
 * too long or taken gets an 8-hex hash of the raw server and tool names.
 */
export function formatDeferredToolName(serverName: string, toolName: string, isTaken: (name: string) => boolean): string {
  const name = `mcp__${formatServerNamespace(serverName)}__${toolName}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = createHash("sha256").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 8);
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
  const specs: DeferredToolSpec[] = [];

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) continue;
    const serverSpecs = resolveServerToolSpecs(serverName, definition, serverCache, resolveToolPrefix(definition, prefix), true, selectorIndexFor(definition));
    for (const spec of serverSpecs) {
      if (direct.has(deferredToolKey(spec.serverName, spec.originalName, spec.resourceUri))) continue;
      const name = formatDeferredToolName(serverName, spec.originalName, (candidate) => taken.has(candidate));
      if (taken.has(name)) {
        console.warn(`MCP: skipping deferred tool "${name}" for "${spec.originalName}" on "${serverName}" (name already taken)`);
        continue;
      }
      taken.add(name);
      specs.push({ ...spec, name });
    }
  }
  return specs;
}
