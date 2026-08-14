import { getToolUiResourceUri } from "./ui-app-bridge-helpers.ts";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata, McpTool, McpResource, ServerEntry, ToolPrefix } from "./types.ts";
import { createToolSelectorCandidateIndex, formatToolName, getToolNameCandidates, isToolAllowed, resolveToolPrefix } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { extractToolUiStreamMode } from "./utils.ts";
import { extractUiToolVisibility, isUiToolVisibleToModel } from "./ui-tool-visibility.ts";

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
  const seenNames = new Set<string>();
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
    if (seenNames.has(name)) {
      continue;
    }

    const uiVisibility = extractUiToolVisibility(tool._meta);
    if (!isUiToolVisibleToModel(uiVisibility)) {
      continue;
    }
    seenNames.add(name);

    let uiResourceUri: string | undefined;
    try {
      uiResourceUri = getToolUiResourceUri({ _meta: tool._meta });
    } catch {
      failedTools.push(tool.name);
    }
    const uiStreamMode = extractToolUiStreamMode(tool._meta);
    metadata.push({
      name,
      originalName: tool.name,
      description: tool.description ?? "",
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(uiResourceUri !== undefined ? { uiResourceUri } : {}),
      ...(uiVisibility !== undefined ? { uiVisibility } : {}),
      ...(uiStreamMode !== undefined ? { uiStreamMode } : {}),
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of resources) {
      const baseName = `read_${resourceNameToToolName(resource.name)}`;
      if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) {
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

  return { metadata, failedTools };
}

export function getToolNames(state: McpExtensionState, serverName: string): string[] {
  return state.toolMetadata.get(serverName)?.map(m => m.name) ?? [];
}

export function totalToolCount(state: McpExtensionState): number {
  let count = 0;
  for (const metadata of state.toolMetadata.values()) {
    count += metadata.length;
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
