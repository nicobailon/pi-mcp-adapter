import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata, McpTool, McpResource, ServerEntry } from "./types.ts";
import { formatToolName, isToolExcluded } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { extractToolUiStreamMode } from "./utils.ts";

export function buildToolMetadata(
  tools: McpTool[],
  resources: McpResource[],
  definition: ServerEntry,
  serverName: string,
  prefix: "server" | "none" | "short"
): { metadata: ToolMetadata[]; failedTools: string[] } {
  const metadata: ToolMetadata[] = [];
  const failedTools: string[] = [];

  for (const tool of tools) {
    if (!tool?.name) {
      failedTools.push("(unnamed)");
      continue;
    }
    if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) {
      continue;
    }

    let uiResourceUri: string | undefined;
    try {
      uiResourceUri = getToolUiResourceUri({ _meta: tool._meta });
    } catch {
      failedTools.push(tool.name);
    }
    metadata.push({
      name: formatToolName(tool.name, serverName, prefix),
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      uiResourceUri,
      uiStreamMode: extractToolUiStreamMode(tool._meta),
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of resources) {
      const baseName = `get_${resourceNameToToolName(resource.name)}`;
      if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) {
        continue;
      }

      metadata.push({
        name: formatToolName(baseName, serverName, prefix),
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

type JsonSchemaObject = Record<string, unknown>;

function isSchemaObject(schema: unknown): schema is JsonSchemaObject {
  return !!schema && typeof schema === "object";
}

function getRequiredProperties(schema: JsonSchemaObject): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
}

function getSchemaProperties(schema: JsonSchemaObject): Record<string, unknown> | undefined {
  return schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, unknown>
    : undefined;
}

export function formatSchema(schema: unknown, indent = "  "): string {
  if (!isSchemaObject(schema)) {
    return `${indent}(no schema)`;
  }

  const props = getSchemaProperties(schema);
  if (schema.type === "object" && props) {
    if (Object.keys(props).length === 0) {
      return `${indent}(no parameters)`;
    }
    return formatProperties(props, getRequiredProperties(schema), indent).join("\n");
  }

  return formatSchemaNode(schema, indent).join("\n");
}

function formatProperties(props: Record<string, unknown>, required: string[], indent: string): string[] {
  const lines: string[] = [];
  for (const [name, propSchema] of Object.entries(props)) {
    lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
  }
  return lines;
}

function formatProperty(name: string, schema: unknown, required: boolean, indent: string): string[] {
  if (!isSchemaObject(schema)) {
    return [`${indent}${name}${required ? " *required*" : ""}`];
  }

  const lines = [formatHeader(`${indent}${name}`, schema, required)];
  lines.push(...formatSchemaChildren(schema, `${indent}  `));
  return lines;
}

function formatSchemaNode(schema: JsonSchemaObject, indent: string): string[] {
  const summary = getSchemaSummary(schema);
  const lines = [`${indent}${summary ? `(${summary})` : "(complex schema)"}`];
  lines.push(...formatSchemaChildren(schema, `${indent}  `));
  return lines;
}

function formatSchemaVariant(schema: unknown, indent: string): string[] {
  if (!isSchemaObject(schema)) {
    return [`${indent}- (no schema)`];
  }

  const summary = getSchemaSummary(schema) || "schema";
  const lines = [`${indent}- ${summary}`];
  lines.push(...formatSchemaChildren(schema, `${indent}  `));
  return lines;
}

function formatSchemaChildren(schema: JsonSchemaObject, indent: string): string[] {
  const lines: string[] = [];
  const unionEntries = getUnionEntries(schema);

  if (unionEntries) {
    lines.push(`${indent}${unionEntries.label}:`);
    for (const variant of unionEntries.schemas) {
      lines.push(...formatSchemaVariant(variant, `${indent}  `));
    }
  }

  const props = getSchemaProperties(schema);
  if (props && Object.keys(props).length > 0) {
    lines.push(...formatProperties(props, getRequiredProperties(schema), indent));
  }

  if (schema.type === "array" && schema.items !== undefined) {
    lines.push(`${indent}items:`);
    if (Array.isArray(schema.items)) {
      for (const item of schema.items) {
        lines.push(...formatSchemaVariant(item, `${indent}  `));
      }
    } else {
      lines.push(...formatSchemaVariant(schema.items, `${indent}  `));
    }
  }

  return lines;
}

function getUnionEntries(schema: JsonSchemaObject): { label: string; schemas: unknown[] } | undefined {
  if (Array.isArray(schema.anyOf)) {
    return { label: "anyOf", schemas: schema.anyOf };
  }
  if (Array.isArray(schema.oneOf)) {
    return { label: "oneOf", schemas: schema.oneOf };
  }
  if (Array.isArray(schema.allOf)) {
    return { label: "allOf", schemas: schema.allOf };
  }
  return undefined;
}

function getSchemaSummary(schema: JsonSchemaObject): string {
  if (schema.const !== undefined) {
    return `const: ${JSON.stringify(schema.const)}`;
  }

  if (Array.isArray(schema.enum)) {
    return `enum: ${schema.enum.map(v => JSON.stringify(v)).join(", ")}`;
  }

  if (schema.type) {
    if (Array.isArray(schema.type)) {
      return schema.type.join(" | ");
    }
    return String(schema.type);
  }

  if (schema.anyOf || schema.oneOf) {
    return "union";
  }

  if (schema.allOf) {
    return "intersection";
  }

  return "";
}

function formatHeader(prefix: string, schema: JsonSchemaObject, required: boolean): string {
  const parts: string[] = [prefix];
  const typeStr = getSchemaSummary(schema);

  if (typeStr) parts.push(`(${typeStr})`);
  if (required) parts.push("*required*");

  const constraints = formatConstraints(schema);
  if (constraints.length > 0) {
    parts.push(`[${constraints.join(", ")}]`);
  }

  if (schema.default !== undefined) {
    parts.push(`[default: ${JSON.stringify(schema.default)}]`);
  }

  if (schema.description && typeof schema.description === "string") {
    parts.push(`- ${schema.description}`);
  }

  return parts.join(" ");
}

function formatConstraints(schema: JsonSchemaObject): string[] {
  const keys = ["minLength", "maxLength", "minimum", "maximum", "pattern"];
  return keys
    .filter(key => schema[key] !== undefined)
    .map(key => `${key}: ${JSON.stringify(schema[key])}`);
}
