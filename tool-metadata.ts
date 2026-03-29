import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import { filterAllowedTools, filterAllowedResources } from "./policy.js";
import type { ServerPolicy } from "./policy.js";
import type { McpExtensionState } from "./state.js";
import type { ToolMetadata, McpTool, McpResource, ServerEntry } from "./types.js";
import { formatToolName } from "./types.js";
import { resourceNameToToolName } from "./resource-tools.js";
import { extractToolUiStreamMode } from "./utils.js";

export function checkPolicyAllowlistWarnings(
  policy: ServerPolicy,
  tools: Array<{ name: string }>,
  resources: Array<{ uri: string }>,
  prompts: Array<{ name: string }> | undefined,
  serverName: string
): void {
  const toolNames = new Set(tools.map(t => t.name));
  const resourceUris = new Set(resources.map(r => r.uri));

  for (const name of policy.allowedTools ?? []) {
    if (!toolNames.has(name)) {
      console.warn(`MCP [${serverName}]: allowedTools entry "${name}" not found on server`);
    }
  }
  for (const uri of policy.allowedResources ?? []) {
    if (!resourceUris.has(uri)) {
      console.warn(`MCP [${serverName}]: allowedResources entry "${uri}" not found on server`);
    }
  }
  if (prompts !== undefined) {
    const promptNames = new Set(prompts.map(p => p.name));
    for (const name of policy.allowedPrompts ?? []) {
      if (!promptNames.has(name)) {
        console.warn(`MCP [${serverName}]: allowedPrompts entry "${name}" not found on server`);
      }
    }
  }
}

export function buildToolMetadata(
  tools: McpTool[],
  resources: McpResource[],
  definition: ServerEntry,
  serverName: string,
  prefix: "server" | "none" | "short"
): { metadata: ToolMetadata[]; failedTools: string[] } {
  const metadata: ToolMetadata[] = [];
  const failedTools: string[] = [];

  const filteredTools = definition.policy ? filterAllowedTools(definition.policy, tools) : tools;
  if (definition.policy) {
    checkPolicyAllowlistWarnings(definition.policy, tools, resources, undefined, serverName);
  }
  const filteredResources = definition.policy ? filterAllowedResources(definition.policy, resources) : resources;

  for (const tool of filteredTools) {
    if (!tool?.name) {
      failedTools.push("(unnamed)");
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
    for (const resource of filteredResources) {
      const baseName = `get_${resourceNameToToolName(resource.name)}`;
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

export function formatSchema(schema: unknown, indent = "  "): string {
  if (!schema || typeof schema !== "object") {
    return `${indent}(no schema)`;
  }

  const s = schema as Record<string, unknown>;

  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, unknown>;
    const required = Array.isArray(s.required) ? s.required as string[] : [];

    if (Object.keys(props).length === 0) {
      return `${indent}(no parameters)`;
    }

    const lines: string[] = [];
    for (const [name, propSchema] of Object.entries(props)) {
      const isRequired = required.includes(name);
      const propLine = formatProperty(name, propSchema, isRequired, indent);
      lines.push(propLine);
    }
    return lines.join("\n");
  }

  if (s.type) {
    return `${indent}(${s.type})`;
  }

  return `${indent}(complex schema)`;
}

function formatProperty(name: string, schema: unknown, required: boolean, indent: string): string {
  if (!schema || typeof schema !== "object") {
    return `${indent}${name}${required ? " *required*" : ""}`;
  }

  const s = schema as Record<string, unknown>;
  const parts: string[] = [];

  let typeStr = "";
  if (s.type) {
    if (Array.isArray(s.type)) {
      typeStr = s.type.join(" | ");
    } else {
      typeStr = String(s.type);
    }
  } else if (s.enum) {
    typeStr = "enum";
  } else if (s.anyOf || s.oneOf) {
    typeStr = "union";
  }

  if (Array.isArray(s.enum)) {
    const enumVals = s.enum.map(v => JSON.stringify(v)).join(", ");
    typeStr = `enum: ${enumVals}`;
  }

  parts.push(`${indent}${name}`);
  if (typeStr) parts.push(`(${typeStr})`);
  if (required) parts.push("*required*");

  if (s.description && typeof s.description === "string") {
    parts.push(`- ${s.description}`);
  }

  if (s.default !== undefined) {
    parts.push(`[default: ${JSON.stringify(s.default)}]`);
  }

  return parts.join(" ");
}
