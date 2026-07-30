// metadata-cache.ts - Persistent MCP metadata cache
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import { createHash } from "node:crypto";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CachedPrompt,
  CachedResource,
  CachedTool,
  McpConfig,
  McpTool,
  McpResource,
  McpPrompt,
  McpPromptArgument,
  MetadataCache,
  ServerCacheEntry,
  ServerEntry,
  ToolMetadata,
  PromptMetadata,
} from "./types.ts";
import { formatPromptCommandName, formatToolName, isServerDisabled, isToolAllowed, resolveToolPrefix, type ToolPrefix } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import {
  extractToolUiStreamMode,
  interpolateEnvRecord,
  resolveBearerToken,
  resolveConfigPath,
  resolveServerUrl,
} from "./utils.ts";

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type { CachedPrompt, CachedResource, CachedTool, MetadataCache, ServerCacheEntry } from "./types.ts";

export function getMetadataCachePath(): string {
  return getAgentPath("mcp-cache.json");
}

export function loadMetadataCache(): MetadataCache | null {
  const cachePath = getMetadataCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    if (raw.version !== CACHE_VERSION) return null;
    if (!raw.servers || typeof raw.servers !== "object") return null;
    return raw as MetadataCache;
  } catch {
    return null;
  }
}

export function saveMetadataCache(cache: MetadataCache): void {
  const cachePath = getMetadataCachePath();
  const dir = dirname(cachePath);
  mkdirSync(dir, { recursive: true });

  let merged: MetadataCache = { version: CACHE_VERSION, servers: {} };
  try {
    if (existsSync(cachePath)) {
      const existing = JSON.parse(readFileSync(cachePath, "utf-8")) as MetadataCache;
      if (existing && existing.version === CACHE_VERSION && existing.servers) {
        merged.servers = { ...existing.servers };
      }
    }
  } catch {
    // Ignore parse errors and proceed with empty cache
  }

  merged.version = CACHE_VERSION;
  merged.servers = { ...merged.servers, ...cache.servers };

  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
  renameSync(tmpPath, cachePath);
}

export function computeServerHash(definition: ServerEntry): string {
  // Hash only fields that affect server identity and tool/resource output.
  // Exclude lifecycle, idleTimeout, requestTimeoutMs, debug — those are runtime behavior settings
  // that don't change which tools a server exposes.
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    socket: resolveConfigPath(definition.socket),
    env: interpolateEnvRecord(definition.env),
    cwd: resolveConfigPath(definition.cwd),
    url: resolveServerUrl(definition),
    headers: interpolateEnvRecord(definition.headers),
    auth: definition.auth,
    bearerToken: resolveBearerToken(definition),
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
    includeTools: definition.includeTools,
    excludeTools: definition.excludeTools,
  };
  const normalized = stableStringify(identity);
  return createHash("sha256").update(normalized).digest("hex");
}

export function isServerCacheValid(
  entry: ServerCacheEntry,
  definition: ServerEntry,
  maxAgeMs: number = CACHE_MAX_AGE_MS
): boolean {
  let configHash: string;
  try {
    configHash = computeServerHash(definition);
  } catch {
    return false;
  }
  if (!entry || entry.configHash !== configHash) return false;
  if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false;
  if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return false;
  return true;
}

export function parseDirectToolSelectors(selectors: string[]): {
  servers: Set<string>;
  tools: Map<string, Set<string>>;
} {
  const servers = new Set<string>();
  const tools = new Map<string, Set<string>>();

  for (let selector of selectors) {
    selector = selector.replace(/\/+$/, "");
    if (selector.includes("/")) {
      const [server, tool] = selector.split("/", 2);
      if (server && tool) {
        const serverTools = tools.get(server) ?? new Set<string>();
        serverTools.add(tool);
        tools.set(server, serverTools);
      } else if (server) {
        servers.add(server);
      }
    } else if (selector) {
      servers.add(selector);
    }
  }

  return { servers, tools };
}

export function getMissingConfiguredDirectToolServers(
  config: McpConfig,
  cache: MetadataCache | null,
  envOverride?: string[],
): string[] {
  const missing: string[] = [];
  const globalDirect = config.settings?.directTools;
  const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const hasDirectTools = envSelection
      ? envSelection.servers.has(serverName) || envSelection.tools.has(serverName)
      : definition.directTools !== undefined
        ? !!definition.directTools
        : !!globalDirect;

    if (!hasDirectTools) continue;

    const serverCache = cache?.servers?.[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) {
      missing.push(serverName);
    }
  }

  return missing;
}

export function reconstructToolMetadata(
  serverName: string,
  entry: ServerCacheEntry,
  prefix: ToolPrefix,
  definition: Pick<ServerEntry, "exposeResources" | "includeTools" | "excludeTools" | "toolPrefix">
): ToolMetadata[] {
  const metadata: ToolMetadata[] = [];
  const seenNames = new Set<string>();
  const effectivePrefix = resolveToolPrefix(definition, prefix);

  for (const tool of entry.tools ?? []) {
    if (!tool?.name) continue;
    if (!isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools)) {
      continue;
    }

    const name = formatToolName(tool.name, serverName, effectivePrefix);
    if (seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);

    metadata.push({
      name,
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      uiResourceUri: tool.uiResourceUri,
      uiStreamMode: tool.uiStreamMode,
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of entry.resources ?? []) {
      if (!resource?.name || !resource?.uri) continue;
      const baseName = `read_${resourceNameToToolName(resource.name)}`;
      if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools)) {
        continue;
      }

      const name = formatToolName(baseName, serverName, effectivePrefix);
      if (seenNames.has(name)) {
        continue;
      }
      seenNames.add(name);

      metadata.push({
        name,
        originalName: baseName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        resourceUri: resource.uri,
      });
    }
  }

  return metadata;
}

export function serializeTools(tools: McpTool[]): CachedTool[] {
  return tools
    .filter(t => t?.name)
    .map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      uiResourceUri: tryGetToolUiResourceUri(t),
      uiStreamMode: extractToolUiStreamMode(t._meta),
    }));
}

export function serializeResources(resources: McpResource[]): CachedResource[] {
  return resources
    .filter(r => r?.name && r?.uri)
    .map(r => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
    }));
}

export function serializePrompts(prompts: McpPrompt[]): CachedPrompt[] {
  return (prompts ?? [])
    .filter(prompt => prompt?.name)
    .map(prompt => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: Array.isArray(prompt.arguments)
        ? prompt.arguments.filter(argument => argument?.name).map(argument => ({
            name: argument.name,
            description: argument.description,
            required: argument.required,
          }))
        : undefined,
    }));
}

export function reconstructPromptMetadata(
  serverName: string,
  prompts: ReadonlyArray<McpPrompt | CachedPrompt>,
  prefix: ToolPrefix,
  definition?: Pick<ServerEntry, "toolPrefix">,
): PromptMetadata[] {
  const effectivePrefix = resolveToolPrefix(definition, prefix);
  return (prompts ?? []).filter(prompt => prompt?.name).map(prompt => {
    const args: McpPromptArgument[] = Array.isArray(prompt.arguments)
      ? prompt.arguments.filter(argument => argument?.name).map(argument => ({
          name: argument.name,
          description: argument.description,
          required: argument.required,
        }))
      : [];
    return {
      serverName,
      originalName: prompt.name,
      commandName: formatPromptCommandName(prompt.name, serverName, effectivePrefix),
      title: prompt.title,
      description: prompt.description ?? "",
      arguments: args,
    };
  });
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "undefined" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function tryGetToolUiResourceUri(tool: McpTool): string | undefined {
  try {
    return getToolUiResourceUri({ _meta: tool._meta });
  } catch {
    return undefined;
  }
}
