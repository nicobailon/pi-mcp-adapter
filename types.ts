// types.ts - Core type definitions
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";

// Transport type (stdio + HTTP)
export type Transport = 
  | StdioClientTransport 
  | SSEClientTransport 
  | StreamableHTTPClientTransport;

// Import sources for config
export type ImportKind = 
  | "cursor" 
  | "claude-code" 
  | "claude-desktop" 
  | "codex" 
  | "windsurf" 
  | "vscode";

// Tool definition from MCP server
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown; // JSON Schema
}

// Resource definition from MCP server
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// Content types from MCP
export interface McpContent {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    text?: string;
    blob?: string;
  };
  uri?: string;
  name?: string;
  description?: string;
}

// Pi content block type
export type ContentBlock = TextContent | ImageContent;

// Server configuration
export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // HTTP fields
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer";
  bearerToken?: string;
  bearerTokenEnv?: string;
  lifecycle?: "keep-alive" | "lazy" | "eager";
  idleTimeout?: number; // minutes, overrides global setting
  requestTimeout?: number; // milliseconds, timeout for tool/resource requests
  // Resource handling
  exposeResources?: boolean;
  // Direct tool registration
  directTools?: boolean | string[];
  // Debug
  debug?: boolean;  // Show server stderr (default: false)
}

// Settings
export interface McpSettings {
  toolPrefix?: "server" | "none" | "short";
  idleTimeout?: number; // minutes, default 10, 0 to disable
  requestTimeout?: number; // milliseconds, default 60000 (MCP SDK default)
  directTools?: boolean;
}

// Root config
export interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  imports?: ImportKind[];
  settings?: McpSettings;
}

// Alias for clarity
export type ServerDefinition = ServerEntry;

export interface ToolMetadata {
  name: string;           // Prefixed tool name (e.g., "xcodebuild_list_sims")
  originalName: string;   // Original MCP tool name (e.g., "list_sims")
  description: string;
  resourceUri?: string;   // For resource tools: the URI to read
  inputSchema?: unknown;  // JSON Schema for parameters (stored for describe/errors)
}

export interface DirectToolSpec {
  serverName: string;
  originalName: string;
  prefixedName: string;
  description: string;
  inputSchema?: unknown;
  resourceUri?: string;
}

export interface ServerProvenance {
  path: string;
  kind: "user" | "project" | "import";
  importKind?: string;
}

export interface McpPanelCallbacks {
  reconnect: (serverName: string) => Promise<boolean>;
  getConnectionStatus: (serverName: string) => "connected" | "idle" | "failed" | "needs-auth";
  refreshCacheAfterReconnect: (serverName: string) => import("./metadata-cache.js").ServerCacheEntry | null;
}

export interface McpPanelResult {
  changes: Map<string, true | string[] | false>;
  cancelled: boolean;
}

/**
 * Get server prefix based on tool prefix mode.
 */
export function getServerPrefix(
  serverName: string,
  mode: "server" | "none" | "short"
): string {
  if (mode === "none") return "";
  if (mode === "short") {
    let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    if (!short) short = "mcp";
    return short;
  }
  return serverName.replace(/-/g, "_");
}

/**
 * Format a tool name with server prefix.
 */
export function formatToolName(
  toolName: string,
  serverName: string,
  prefix: "server" | "none" | "short"
): string {
  const p = getServerPrefix(serverName, prefix);
  return p ? `${p}_${toolName}` : toolName;
}
