import { getToolUiResourceUri } from "./ui-app-bridge-helpers.ts";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata, McpTool, McpResource, ServerCacheEntry, ServerEntry, ToolPrefix } from "./types.ts";
import { createToolSelectorCandidateIndex, EXECUTOR_APP_TOOL_CAP, formatToolName, getToolNameCandidates, isToolAllowed, resolveToolPrefix, resolveUniqueNameOwnership } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { extractToolAnnotations, extractToolUiStreamMode } from "./utils.ts";
import { extractUiToolVisibility, isUiToolVisibleToModel } from "./ui-tool-visibility.ts";
import { loadMetadataCache, type MetadataCache } from "./metadata-cache.ts";

export function buildToolMetadata(
  tools: McpTool[],
  resources: McpResource[],
  definition: ServerEntry,
  serverName: string,
  prefix: ToolPrefix,
  configuredServers?: Record<string, ServerEntry>,
  knownMetadata?: Map<string, ToolMetadata[]>,
  includeMissingConfiguredCandidates = false,
): { metadata: ToolMetadata[]; failedTools: string[] } {
  const metadata: ToolMetadata[] = [];
  const failedTools: string[] = [];
  const effectivePrefix = resolveToolPrefix(definition, prefix);
  const hasToolFilters =
    (Array.isArray(definition.includeTools) && definition.includeTools.length > 0) ||
    (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0);
  const selectorCandidateIndex = hasToolFilters && configuredServers ? (() => {
    const candidates = new Set<string>();
    const additionalCandidatesByToolName = new Map<string, Set<string>>();
    const evaluatedToolNames = new Set<string>();
    const addCandidates = (
      target: Set<string>,
      originalName: string,
      candidateServerName: string,
      candidatePrefix: ToolPrefix,
    ) => {
      for (const candidate of getToolNameCandidates(originalName, candidateServerName, candidatePrefix, false)) target.add(candidate);
    };

    for (const tool of tools) {
      if (!tool?.name) continue;
      evaluatedToolNames.add(tool.name);
      addCandidates(candidates, tool.name, serverName, effectivePrefix);
    }
    if (definition.exposeResources !== false) {
      for (const resource of resources) {
        const baseName = `read_${resourceNameToToolName(resource.name)}`;
        evaluatedToolNames.add(baseName);
        if (resource?.name && resource?.uri) addCandidates(candidates, baseName, serverName, effectivePrefix);
      }
    }
    for (const [otherServerName, otherDefinition] of Object.entries(configuredServers)) {
      if (otherServerName === serverName) continue;
      const otherPrefix = resolveToolPrefix(otherDefinition, prefix);
      const knownTools = knownMetadata?.get(otherServerName);
      if (knownTools) {
        for (const tool of knownTools) {
          candidates.add(tool.name);
          addCandidates(candidates, tool.originalName, otherServerName, otherPrefix);
        }
      } else if (!knownMetadata || includeMissingConfiguredCandidates) {
        for (const toolName of evaluatedToolNames) {
          let additionalCandidates = additionalCandidatesByToolName.get(toolName);
          if (!additionalCandidates) {
            additionalCandidates = new Set<string>();
            additionalCandidatesByToolName.set(toolName, additionalCandidates);
          }
          addCandidates(additionalCandidates, toolName, otherServerName, otherPrefix);
          if (includeMissingConfiguredCandidates) {
            for (const candidate of getToolNameCandidates(toolName, otherServerName, otherPrefix, false)) {
              additionalCandidates.add(candidate.replace(/-/g, "_"));
            }
          }
        }
      }
    }
    return createToolSelectorCandidateIndex(candidates, additionalCandidatesByToolName);
  })() : undefined;

  for (const tool of tools) {
    if (!tool?.name) {
      failedTools.push("(unnamed)");
      continue;
    }
    if (!isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) {
      continue;
    }

    const name = formatToolName(tool.name, serverName, effectivePrefix);
    const uiVisibility = extractUiToolVisibility(tool._meta);
    if (!isUiToolVisibleToModel(uiVisibility)) {
      continue;
    }
    let uiResourceUri: string | undefined;
    try {
      uiResourceUri = getToolUiResourceUri({ _meta: tool._meta });
    } catch {
      failedTools.push(tool.name);
    }
    const uiStreamMode = extractToolUiStreamMode(tool._meta);
    const annotations = extractToolAnnotations(tool.annotations);
    metadata.push({
      name,
      originalName: tool.name,
      description: tool.description ?? "",
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(uiResourceUri !== undefined ? { uiResourceUri } : {}),
      ...(uiVisibility !== undefined ? { uiVisibility } : {}),
      ...(uiStreamMode !== undefined ? { uiStreamMode } : {}),
      ...(annotations !== undefined ? { annotations } : {}),
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of resources) {
      const baseName = `read_${resourceNameToToolName(resource.name)}`;
      if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) {
        continue;
      }

      const name = formatToolName(baseName, serverName, effectivePrefix);
      metadata.push({
        name,
        originalName: baseName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        resourceUri: resource.uri,
      });
    }
  }

  const ownership = resolveUniqueNameOwnership(metadata, (tool) => tool.name);
  for (const colliding of ownership.collisions.values()) {
    failedTools.push(...colliding.map((tool) => tool.originalName));
  }
  return { metadata: ownership.unique, failedTools };
}

/**
 * A server's own tools: its metadata without Executor app tools. Every tool count and name list
 * uses this; app tools are counted only in the +N Executor app tools line and the cap line.
 */
export function ownTools(metadata: readonly ToolMetadata[] | undefined): ToolMetadata[] {
  return metadata?.filter(tool => tool.executorPath === undefined) ?? [];
}

export function getToolNames(state: McpExtensionState, serverName: string): string[] {
  return ownTools(state.toolMetadata.get(serverName)).map(m => m.name);
}

/**
 * The one line that stands for an Executor server's app tools wherever its tools are listed by
 * name, since there can be a thousand of them; undefined for any other server.
 */
export function executorAppToolsLine(state: McpExtensionState, serverName: string, readCache?: () => MetadataCache | null): string | undefined {
  const { count, catalog, cap, capped } = executorAppToolCounts(state, serverName, readCache);
  if (count === 0) return undefined;
  const scope = !catalog
    ? "in Executor's catalog"
    : capped
      ? `${catalog.total} in Executor's catalog, capped at ${cap}`
      : `${catalog.total} in Executor's catalog`;
  return `+${count} Executor app tools (${scope}); find them with mcp({ search: "..." }).`;
}

/** The `/mcp-adapter` status line for an Executor server's app tools; undefined for any other server. */
export function executorAppToolsStatus(state: McpExtensionState, serverName: string, readCache?: () => MetadataCache | null): string | undefined {
  const { count, catalog, capped } = executorAppToolCounts(state, serverName, readCache);
  if (!catalog && count === 0) return undefined;
  return capped
    ? `${serverName}: ${count} of ${catalog!.total} Executor app tools registered (cap)`
    : `${serverName}: ${count} Executor app tools`;
}

/**
 * A server's Executor app catalog: this session's, or the cache file's. `readCache` lets a caller
 * that asks about many servers read the cache file once.
 */
export function executorCatalogOf(state: McpExtensionState, serverName: string, readCache: () => MetadataCache | null = loadMetadataCache) {
  return (state.sessionMetadata?.get(serverName) ?? readCache()?.servers[serverName])?.executorApps;
}

/** Reads the metadata cache file on first use only. */
export function cacheReader(): () => MetadataCache | null {
  let cache: MetadataCache | null | undefined;
  return () => cache === undefined ? (cache = loadMetadataCache()) : cache;
}

/** The ⚠ line for each app an Executor server's catalog couldn't list. */
export function unavailableAppNotes(serverName: string, unavailableApps: NonNullable<ServerCacheEntry["executorApps"]>["unavailableApps"]): string[] {
  return (unavailableApps ?? []).filter(app => typeof app?.name === "string").map(app =>
    `${serverName}: Executor could not list the app ${app.name}, so its tools are missing${typeof app.reason === "string" ? ` — ${app.reason}` : "."}`);
}

/**
 * The Executor catalog notes `/mcp-adapter` shows: this session's for a server whose catalog was
 * refreshed or failed, else the unavailable apps of its cached catalog, so a lazy server that
 * hasn't connected yet still shows them.
 */
export function executorCatalogNotes(state: McpExtensionState, readCache?: () => MetadataCache | null): string[] {
  return Object.keys(state.config.mcpServers).flatMap(serverName => {
    const notes = state.executorCatalogNotes?.get(serverName);
    if (notes) return notes;
    const { catalog } = executorAppToolCounts(state, serverName, readCache);
    return unavailableAppNotes(serverName, catalog?.unavailableApps);
  });
}

function executorAppToolCounts(state: McpExtensionState, serverName: string, readCache?: () => MetadataCache | null) {
  const metadata = state.toolMetadata.get(serverName) ?? [];
  const count = metadata.length - ownTools(metadata).length;
  // Only an Executor server can have a catalog, so any other server skips the cache file.
  const catalog = count === 0 && !state.sessionMetadata?.get(serverName)?.executorApps ? undefined : executorCatalogOf(state, serverName, readCache);
  // A catalog cached under a larger cap is still read only up to this one.
  const cap = catalog ? Math.min(catalog.cap, EXECUTOR_APP_TOOL_CAP) : EXECUTOR_APP_TOOL_CAP;
  const capped = catalog !== undefined && catalog.total > cap;
  return { count, catalog, cap, capped };
}

export function totalToolCount(state: McpExtensionState): number {
  let count = 0;
  for (const metadata of state.toolMetadata.values()) {
    count += ownTools(metadata).length;
  }
  return count;
}

export function findToolByName(metadata: ToolMetadata[] | undefined, toolName: string): ToolMetadata | undefined {
  if (!metadata) return undefined;
  const exact = metadata.find(m => m.name === toolName);
  if (exact) return exact;
  const normalized = toolName.replace(/-/g, "_");
  return metadata.find(m => m.name.replace(/-/g, "_") === normalized);
}

/** Keep only plain structural schemas compact; preserve everything else as original JSON. */
export function isPlainTypeSchema(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  if (Object.keys(s).some(key => !["type", "properties", "required", "items"].includes(key))) return false;
  if (s.type === "integer" || Array.isArray(s.type)) return false;

  const properties = s.properties;
  if (properties !== undefined) {
    if (s.type !== "object" || !properties || typeof properties !== "object" || Array.isArray(properties)) return false;
    if (!Object.values(properties).every(isPlainTypeSchema)) return false;
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some(name => typeof name !== "string" || !Object.hasOwn(properties ?? {}, name))) return false;
  }
  if (s.items !== undefined && (s.type !== "array" || !isPlainTypeSchema(s.items))) return false;
  return true;
}

/** Whether the schema formatter has field descriptions worth showing beside a compact shape. */
export function hasSchemaDescriptions(schema: unknown, includeRoot = false): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  if (includeRoot && typeof s.description === "string" && s.description.length > 0) return true;
  const hasNestedDescription = (child: unknown) => hasSchemaDescriptions(child, true);
  if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)
    && Object.values(s.properties).some(hasNestedDescription)) return true;
  return hasNestedDescription(s.items)
    || (Array.isArray(s.anyOf) && s.anyOf.some(hasNestedDescription))
    || (Array.isArray(s.oneOf) && s.oneOf.some(hasNestedDescription));
}

export function formatSchema(schema: unknown, indent = "  "): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return `${indent}(no schema)`;
  }

  const s = schema as Record<string, unknown>;

  if (s.type === "object" && s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
    const props = s.properties as Record<string, unknown>;
    const required = Array.isArray(s.required) ? s.required.filter((name): name is string => typeof name === "string") : [];

    if (Object.keys(props).length === 0) {
      return `${indent}(no parameters)`;
    }

    const lines: string[] = [];
    for (const [name, propSchema] of Object.entries(props)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
    }
    return lines.join("\n");
  }

  const lines = formatNestedSchema(s, indent);
  if (lines.length > 0) {
    return lines.join("\n");
  }

  const typeStr = formatType(s);
  if (typeStr) {
    return `${indent}(${typeStr})`;
  }

  return `${indent}(complex schema)`;
}

function formatProperty(name: string, schema: unknown, required: boolean, indent: string): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [`${indent}${name}${required ? " *required*" : ""}`];
  }

  const s = schema as Record<string, unknown>;
  const parts = [`${indent}${name}`];
  const typeStr = formatType(s);
  if (typeStr) parts.push(`(${typeStr})`);
  if (required) parts.push("*required*");
  appendSchemaAnnotations(parts, s);

  return [parts.join(" "), ...formatNestedSchema(s, `${indent}  `)];
}

function formatNestedSchema(schema: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];

  if (Array.isArray(schema.anyOf)) {
    lines.push(...formatVariants("anyOf", schema.anyOf, indent));
  }
  if (Array.isArray(schema.oneOf)) {
    lines.push(...formatVariants("oneOf", schema.oneOf, indent));
  }
  if (schema.items !== undefined) {
    lines.push(...formatProperty("items", schema.items, false, indent));
  }
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
    for (const [name, propSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
    }
  }

  return lines;
}

function formatVariants(keyword: "anyOf" | "oneOf", variants: unknown[], indent: string): string[] {
  const lines = [`${indent}${keyword}:`];

  for (const variant of variants) {
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
      lines.push(`${indent}  - ${JSON.stringify(variant)}`);
      continue;
    }

    const s = variant as Record<string, unknown>;
    const typeStr = formatType(s) || "schema";
    const parts = [`${indent}  - ${typeStr}`];
    appendSchemaAnnotations(parts, s);
    lines.push(parts.join(" "));
    lines.push(...formatNestedSchema(s, `${indent}    `));
  }

  return lines;
}

function formatType(schema: Record<string, unknown>): string {
  if (Object.hasOwn(schema, "const")) {
    return `const ${JSON.stringify(schema.const)}`;
  }

  if (Array.isArray(schema.enum)) {
    return `enum: ${schema.enum.map(v => JSON.stringify(v)).join(", ")}`;
  }

  if (Array.isArray(schema.type)) {
    return schema.type.map(type => String(type)).join(" | ");
  }

  if (schema.type) {
    return String(schema.type);
  }

  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    return "object";
  }

  if (schema.items !== undefined) {
    return "array";
  }

  return "";
}

function appendSchemaAnnotations(parts: string[], schema: Record<string, unknown>): void {
  if (schema.description && typeof schema.description === "string") {
    parts.push(`- ${schema.description}`);
  }

  for (const key of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "format", "pattern"] as const) {
    if (schema[key] !== undefined) {
      parts.push(`[${key}: ${JSON.stringify(schema[key])}]`);
    }
  }

  if (schema.default !== undefined) {
    parts.push(`[default: ${JSON.stringify(schema.default)}]`);
  }
}
