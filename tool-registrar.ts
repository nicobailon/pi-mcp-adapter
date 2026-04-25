// tool-registrar.ts - MCP content transformation
// NOTE: Tools are NOT registered with Pi - only the unified `mcp` proxy tool is registered.
// This keeps the LLM context small (1 tool instead of 100s).

import { formatSize, sanitizeMimeType } from "./mcp-content-formatting.js";
import type { McpContent, ContentBlock } from "./types.js";

/**
 * Transform MCP content types to Pi content blocks.
 */
export function transformMcpContent(content: McpContent[]): ContentBlock[] {
  return content.map(c => {
    if (c.type === "text") {
      return { type: "text" as const, text: c.text ?? "" };
    }
    if (c.type === "image") {
      return {
        type: "image" as const,
        data: c.data ?? "",
        mimeType: c.mimeType ?? "image/png",
      };
    }
    if (c.type === "resource") {
      const resourceUri = c.resource?.uri ?? "(no URI)";
      const resourceContent = formatResourceContent(c);
      return {
        type: "text" as const,
        text: `[Resource: ${resourceUri}]\n${resourceContent}`,
      };
    }
    if (c.type === "resource_link") {
      const linkName = c.name ?? c.uri ?? "unknown";
      const linkUri = c.uri ?? "(no URI)";
      return {
        type: "text" as const,
        text: `[Resource Link: ${linkName}]\nURI: ${linkUri}`,
      };
    }
    if (c.type === "audio") {
      return {
        type: "text" as const,
        text: `[Audio content: ${sanitizeMimeType(c.mimeType ?? "", "audio/*")}]`,
      };
    }
    return { type: "text" as const, text: JSON.stringify(c) };
  });
}

/**
 * Format MCP embedded resources without copying binary blob payloads into model-facing text.
 */
function formatResourceContent(content: McpContent): string {
  if (content.resource?.text !== undefined) {
    return content.resource.text;
  }
  if (content.resource?.blob !== undefined) {
    const mimeType = sanitizeMimeType(content.mimeType ?? "", "application/octet-stream");
    const bytes = Buffer.byteLength(content.resource.blob, "utf-8");
    return `[Binary data: ${mimeType}, ${formatSize(bytes)} base64 payload omitted]`;
  }
  return "(no content)";
}
