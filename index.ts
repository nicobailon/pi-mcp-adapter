// index.ts - Full extension entry point with commands
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadMcpConfig } from "./config.js";
import { formatToolName, type McpConfig, type McpContent } from "./types.js";
import { McpServerManager } from "./server-manager.js";
import { McpLifecycleManager } from "./lifecycle.js";
import { collectToolNames, transformMcpContent } from "./tool-registrar.js";
import { collectResourceToolNames, resourceNameToToolName } from "./resource-tools.js";

interface ToolMetadata {
  name: string;           // Prefixed tool name (e.g., "xcodebuild_list_sims")
  originalName: string;   // Original MCP tool name (e.g., "list_sims")
  description: string;
  resourceUri?: string;   // For resource tools: the URI to read
  inputSchema?: unknown;  // JSON Schema for parameters (stored for describe/errors)
}

interface McpExtensionState {
  manager: McpServerManager;
  lifecycle: McpLifecycleManager;
  registeredTools: Map<string, string[]>;
  toolMetadata: Map<string, ToolMetadata[]>;  // server -> tool metadata for searching
  config: McpConfig;
}

/** Run async tasks with concurrency limit */
async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  
  const workers = Array(Math.min(limit, items.length)).fill(null).map(() => worker());
  await Promise.all(workers);
  return results;
}

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  
  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });
  
  pi.on("session_start", async (_event, ctx) => {
    initPromise = initializeMcp(pi, ctx);
    state = await initPromise;
    initPromise = null;
    
    // Set up callback for auto-reconnect to update metadata
    state.lifecycle.setReconnectCallback((serverName) => {
      if (state) {
        updateServerMetadata(state, serverName);
      }
    });
    
    if (ctx.hasUI) {
      const totalTools = [...state.registeredTools.values()].flat().length;
      if (totalTools > 0) {
        ctx.ui.setStatus("mcp", ctx.ui.theme.fg("accent", `MCP: ${totalTools} tools`));
      } else {
        ctx.ui.setStatus("mcp", "");
      }
    }
  });
  
  pi.on("session_shutdown", async () => {
    if (initPromise) {
      try {
        state = await initPromise;
      } catch {
        // Initialization failed, nothing to clean up
      }
    }
    
    if (state) {
      await state.lifecycle.gracefulShutdown();
      state = null;
    }
  });
  
  // /mcp command
  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }
      
      const subcommand = args?.trim()?.split(/\s+/)?.[0] ?? "";
      
      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "status":
        case "":
        default:
          await showStatus(state, ctx);
          break;
      }
    },
  });
  
  // /mcp-auth command
  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /mcp-auth <server-name>", "error");
        return;
      }
      
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }
      
      await authenticateServer(serverName, state.config, ctx);
    },
  });
  
  // Single unified MCP tool - mode determined by parameters
  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description: `MCP gateway - connect to MCP servers and call their tools.

Usage:
  mcp({ })                              → Show server status
  mcp({ server: "name" })               → List tools from server
  mcp({ search: "query" })              → Search for tools (includes schemas, space-separated words OR'd)
  mcp({ describe: "tool_name" })        → Show tool details and parameters
  mcp({ tool: "name", args: {...} })    → Call a tool

Mode: tool (call) > describe > search > server (list) > nothing (status)`,
    parameters: Type.Object({
      // Call mode
      tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments for tool call" })),
      // Describe mode
      describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
      // Search mode
      search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
      includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
      // Filter (works with search or list)
      server: Type.Optional(Type.String({ description: "Filter to specific server" })),
    }),
    async execute(_toolCallId, params: {
      tool?: string;
      args?: Record<string, unknown>;
      describe?: string;
      search?: string;
      regex?: boolean;
      includeSchemas?: boolean;
      server?: string;
    }) {
      if (!state) {
        return {
          content: [{ type: "text", text: "MCP not initialized" }],
          details: { error: "not_initialized" },
        };
      }
      
      // Mode resolution: tool > describe > search > server > status
      if (params.tool) {
        return executeCall(state, params.tool, params.args);
      }
      if (params.describe) {
        return executeDescribe(state, params.describe);
      }
      if (params.search) {
        return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas);
      }
      if (params.server) {
        return executeList(state, params.server);
      }
      return executeStatus(state);
    },
  });
}

// --- Mode implementations ---

function executeStatus(state: McpExtensionState) {
  const servers: Array<{ name: string; status: string; toolCount: number }> = [];
  
  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const toolNames = state.registeredTools.get(name) ?? [];
    servers.push({
      name,
      status: connection?.status ?? "not connected",
      toolCount: toolNames.length,
    });
  }
  
  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const connectedCount = servers.filter(s => s.status === "connected").length;
  
  let text = `MCP: ${connectedCount}/${servers.length} servers, ${totalTools} tools\n\n`;
  for (const server of servers) {
    const icon = server.status === "connected" ? "✓" : "○";
    text += `${icon} ${server.name} (${server.toolCount} tools)\n`;
  }
  
  if (servers.length > 0) {
    text += `\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search`;
  }
  
  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "status", servers, totalTools, connectedCount },
  };
}

function executeDescribe(state: McpExtensionState, toolName: string) {
  // Find the tool in metadata
  let serverName: string | undefined;
  let toolMeta: ToolMetadata | undefined;
  
  for (const [server, metadata] of state.toolMetadata.entries()) {
    const found = metadata.find(m => m.name === toolName);
    if (found) {
      serverName = server;
      toolMeta = found;
      break;
    }
  }
  
  if (!serverName || !toolMeta) {
    return {
      content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.` }],
      details: { mode: "describe", error: "tool_not_found", requestedTool: toolName },
    };
  }
  
  let text = `${toolMeta.name}\n`;
  text += `Server: ${serverName}\n`;
  if (toolMeta.resourceUri) {
    text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`;
  }
  text += `\n${toolMeta.description || "(no description)"}\n`;
  
  // Format parameters from schema
  if (toolMeta.inputSchema && !toolMeta.resourceUri) {
    text += `\nParameters:\n${formatSchema(toolMeta.inputSchema)}`;
  } else if (toolMeta.resourceUri) {
    text += `\nNo parameters required (resource tool).`;
  } else {
    text += `\nNo parameters defined.`;
  }
  
  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "describe", tool: toolMeta, server: serverName },
  };
}

/**
 * Format JSON Schema to human-readable parameter documentation.
 */
function formatSchema(schema: unknown, indent = "  "): string {
  if (!schema || typeof schema !== "object") {
    return `${indent}(no schema)`;
  }
  
  const s = schema as Record<string, unknown>;
  
  // Handle object type with properties
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
  
  // Fallback: just show the schema type
  if (s.type) {
    return `${indent}(${s.type})`;
  }
  
  return `${indent}(complex schema)`;
}

/**
 * Format a single property from JSON Schema.
 */
function formatProperty(name: string, schema: unknown, required: boolean, indent: string): string {
  if (!schema || typeof schema !== "object") {
    return `${indent}${name}${required ? " *required*" : ""}`;
  }
  
  const s = schema as Record<string, unknown>;
  const parts: string[] = [];
  
  // Type info
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
  
  // Enum values
  if (Array.isArray(s.enum)) {
    const enumVals = s.enum.map(v => JSON.stringify(v)).join(", ");
    typeStr = `enum: ${enumVals}`;
  }
  
  // Build the line
  parts.push(`${indent}${name}`);
  if (typeStr) parts.push(`(${typeStr})`);
  if (required) parts.push("*required*");
  
  // Description
  if (s.description && typeof s.description === "string") {
    parts.push(`- ${s.description}`);
  }
  
  // Default value
  if (s.default !== undefined) {
    parts.push(`[default: ${JSON.stringify(s.default)}]`);
  }
  
  return parts.join(" ");
}

function executeSearch(
  state: McpExtensionState,
  query: string,
  regex?: boolean,
  server?: string,
  includeSchemas?: boolean
) {
  // Default to including schemas
  const showSchemas = includeSchemas !== false;
  
  const matches: Array<{ server: string; tool: ToolMetadata }> = [];
  
  let pattern: RegExp;
  try {
    if (regex) {
      pattern = new RegExp(query, "i");
    } else {
      // Split on whitespace and OR the terms (like most search engines)
      const terms = query.trim().split(/\s+/).filter(t => t.length > 0);
      if (terms.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Search query cannot be empty" }],
          details: { mode: "search", error: "empty_query" },
        };
      }
      const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      pattern = new RegExp(escaped.join("|"), "i");
    }
  } catch {
    return {
      content: [{ type: "text" as const, text: `Invalid regex: ${query}` }],
      details: { mode: "search", error: "invalid_pattern", query },
    };
  }
  
  for (const [serverName, metadata] of state.toolMetadata.entries()) {
    if (server && serverName !== server) continue;
    for (const tool of metadata) {
      if (pattern.test(tool.name) || pattern.test(tool.description)) {
        matches.push({
          server: serverName,
          tool,
        });
      }
    }
  }
  
  if (matches.length === 0) {
    const msg = server
      ? `No tools matching "${query}" in "${server}"`
      : `No tools matching "${query}"`;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "search", matches: [], count: 0, query },
    };
  }
  
  let text = `Found ${matches.length} tool${matches.length === 1 ? "" : "s"} matching "${query}":\n\n`;
  
  for (const match of matches) {
    if (showSchemas) {
      // Full format with schema
      text += `${match.tool.name}\n`;
      text += `  ${match.tool.description || "(no description)"}\n`;
      if (match.tool.inputSchema && !match.tool.resourceUri) {
        text += `\n  Parameters:\n${formatSchema(match.tool.inputSchema, "    ")}\n`;
      } else if (match.tool.resourceUri) {
        text += `  No parameters (resource tool).\n`;
      }
      text += "\n";
    } else {
      // Compact format without schema
      text += `- ${match.tool.name}`;
      if (match.tool.description) {
        text += ` - ${truncateAtWord(match.tool.description, 50)}`;
      }
      text += "\n";
    }
  }
  
  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "search", matches: matches.map(m => ({ server: m.server, tool: m.tool.name })), count: matches.length, query },
  };
}

function executeList(state: McpExtensionState, server: string) {
  const toolNames = state.registeredTools.get(server);
  const metadata = state.toolMetadata.get(server);
  
  if (!toolNames || toolNames.length === 0) {
    // Server exists in registeredTools (even if empty) means it connected
    if (state.registeredTools.has(server)) {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no tools.` }],
        details: { mode: "list", server, tools: [], count: 0 },
      };
    }
    // Server in config but not in registeredTools means connection failed
    if (state.config.mcpServers[server]) {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" is configured but not connected. Use /mcp reconnect to retry.` }],
        details: { mode: "list", server, tools: [], count: 0, error: "not_connected" },
      };
    }
    // Server not in config at all
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
    };
  }
  
  let text = `${server} (${toolNames.length} tools):\n\n`;
  
  // Build a map of tool name -> description for quick lookup
  const descMap = new Map<string, string>();
  if (metadata) {
    for (const m of metadata) {
      descMap.set(m.name, m.description);
    }
  }
  
  for (const tool of toolNames) {
    const desc = descMap.get(tool) ?? "";
    const truncated = truncateAtWord(desc, 50);
    text += `- ${tool}`;
    if (truncated) text += ` - ${truncated}`;
    text += "\n";
  }
  
  return {
    content: [{ type: "text" as const, text: text.trim() }],
    details: { mode: "list", server, tools: toolNames, count: toolNames.length },
  };
}

async function executeCall(
  state: McpExtensionState,
  toolName: string,
  args?: Record<string, unknown>
) {
  // Find the tool in metadata
  let serverName: string | undefined;
  let toolMeta: ToolMetadata | undefined;
  
  for (const [server, metadata] of state.toolMetadata.entries()) {
    const found = metadata.find(m => m.name === toolName);
    if (found) {
      serverName = server;
      toolMeta = found;
      break;
    }
  }
  
  if (!serverName || !toolMeta) {
    return {
      content: [{ type: "text" as const, text: `Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.` }],
      details: { mode: "call", error: "tool_not_found", requestedTool: toolName },
    };
  }
  
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not connected` }],
      details: { mode: "call", error: "server_not_connected", server: serverName },
    };
  }
  
  try {
    // Resource tools use readResource, regular tools use callTool
    if (toolMeta.resourceUri) {
      const result = await connection.client.readResource({ uri: toolMeta.resourceUri });
      const content = (result.contents ?? []).map(c => ({
        type: "text" as const,
        text: "text" in c ? c.text : ("blob" in c ? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]` : JSON.stringify(c)),
      }));
      return {
        content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }],
        details: { mode: "call", resourceUri: toolMeta.resourceUri, server: serverName },
      };
    }
    
    // Regular tool call
    const result = await connection.client.callTool({
      name: toolMeta.originalName,
      arguments: args ?? {},
    });
    
    const mcpContent = (result.content ?? []) as McpContent[];
    const content = transformMcpContent(mcpContent);
    
    if (result.isError) {
      const errorText = content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n") || "Tool execution failed";
      
      // Include schema in error to help LLM self-correct
      let errorWithSchema = `Error: ${errorText}`;
      if (toolMeta.inputSchema) {
        errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`;
      }
      
      return {
        content: [{ type: "text" as const, text: errorWithSchema }],
        details: { mode: "call", error: "tool_error", mcpResult: result },
      };
    }
    
    return {
      content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
      details: { mode: "call", mcpResult: result, server: serverName, tool: toolMeta.originalName },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    
    // Include schema in error to help LLM self-correct
    let errorWithSchema = `Failed to call tool: ${message}`;
    if (toolMeta.inputSchema) {
      errorWithSchema += `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`;
    }
    
    return {
      content: [{ type: "text" as const, text: errorWithSchema }],
      details: { mode: "call", error: "call_failed", message },
    };
  }
}

async function initializeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext
): Promise<McpExtensionState> {
  const configPath = pi.getFlag("mcp-config") as string | undefined;
  const config = loadMcpConfig(configPath);
  
  const manager = new McpServerManager();
  const lifecycle = new McpLifecycleManager(manager);
  const registeredTools = new Map<string, string[]>();
  const toolMetadata = new Map<string, ToolMetadata[]>();
  
  const serverEntries = Object.entries(config.mcpServers);
  if (serverEntries.length === 0) {
    return { manager, lifecycle, registeredTools, toolMetadata, config };
  }
  
  if (ctx.hasUI) {
    ctx.ui.setStatus("mcp", `Connecting to ${serverEntries.length} servers...`);
  }
  
  // Connect to all servers in parallel (max 10 concurrent)
  const results = await parallelLimit(serverEntries, 10, async ([name, definition]) => {
    try {
      const connection = await manager.connect(name, definition);
      return { name, definition, connection, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name, definition, connection: null, error: message };
    }
  });
  const prefix = config.settings?.toolPrefix ?? "server";
  
  // Process results
  for (const { name, definition, connection, error } of results) {
    if (error || !connection) {
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to connect to ${name}: ${error}`, "error");
      }
      console.error(`MCP: Failed to connect to ${name}: ${error}`);
      continue;
    }
    
    // Collect tool names (NOT registered with Pi - only mcp proxy is registered)
    const { collected: toolNames, failed: failedTools } = collectToolNames(
      connection.tools,
      { serverName: name, prefix }
    );
    
    // Collect resource tool names (if enabled)
    if (definition.exposeResources !== false && connection.resources.length > 0) {
      const resourceToolNames = collectResourceToolNames(
        connection.resources,
        { serverName: name, prefix }
      );
      toolNames.push(...resourceToolNames);
    }
    
    registeredTools.set(name, toolNames);
    
    // Build tool metadata for searching (include inputSchema for describe/errors)
    const metadata: ToolMetadata[] = connection.tools.map(tool => ({
      name: formatToolName(tool.name, name, prefix),
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }));
    // Add resource tools to metadata
    for (const resource of connection.resources) {
      if (definition.exposeResources !== false) {
        const baseName = `get_${resourceNameToToolName(resource.name)}`;
        metadata.push({
          name: formatToolName(baseName, name, prefix),
          originalName: baseName,
          description: resource.description ?? `Read resource: ${resource.uri}`,
          resourceUri: resource.uri,
        });
      }
    }
    toolMetadata.set(name, metadata);
    
    // Mark keep-alive servers
    if (definition.lifecycle === "keep-alive") {
      lifecycle.markKeepAlive(name, definition);
    }
    
    if (failedTools.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `MCP: ${name} - ${failedTools.length} tools skipped`,
        "warning"
      );
    }
  }
  
  // Summary notification
  const connectedCount = results.filter(r => r.connection).length;
  const failedCount = results.filter(r => r.error).length;
  if (ctx.hasUI && connectedCount > 0) {
    const totalTools = [...registeredTools.values()].flat().length;
    const msg = failedCount > 0 
      ? `MCP: ${connectedCount}/${serverEntries.length} servers connected (${totalTools} tools)`
      : `MCP: ${connectedCount} servers connected (${totalTools} tools)`;
    ctx.ui.notify(msg, "info");
  }
  
  // Start health checks for keep-alive servers
  lifecycle.startHealthChecks();
  
  return { manager, lifecycle, registeredTools, toolMetadata, config };
}

/**
 * Update tool metadata for a single server after reconnection.
 * Called by lifecycle manager when a keep-alive server reconnects.
 */
function updateServerMetadata(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;
  
  const definition = state.config.mcpServers[serverName];
  if (!definition) return;
  
  const prefix = state.config.settings?.toolPrefix ?? "server";
  
  // Collect tool names
  const { collected: toolNames } = collectToolNames(
    connection.tools,
    { serverName, prefix }
  );
  
  // Collect resource tool names if enabled
  if (definition.exposeResources !== false && connection.resources.length > 0) {
    const resourceToolNames = collectResourceToolNames(
      connection.resources,
      { serverName, prefix }
    );
    toolNames.push(...resourceToolNames);
  }
  
  state.registeredTools.set(serverName, toolNames);
  
  // Update tool metadata (include inputSchema for describe/errors)
  const metadata: ToolMetadata[] = connection.tools.map(tool => ({
    name: formatToolName(tool.name, serverName, prefix),
    originalName: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
  }));
  for (const resource of connection.resources) {
    if (definition.exposeResources !== false) {
      const baseName = `get_${resourceNameToToolName(resource.name)}`;
      metadata.push({
        name: formatToolName(baseName, serverName, prefix),
        originalName: baseName,
        description: resource.description ?? `Read resource: ${resource.uri}`,
        resourceUri: resource.uri,
      });
    }
  }
  state.toolMetadata.set(serverName, metadata);
}

async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  
  const lines: string[] = ["MCP Server Status:", ""];
  
  // Show all configured servers, not just connected ones
  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const toolNames = state.registeredTools.get(name) ?? [];
    const status = connection?.status ?? "not connected";
    const statusIcon = status === "connected" ? "✓" : "○";
    
    lines.push(`${statusIcon} ${name}: ${status} (${toolNames.length} tools)`);
  }
  
  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
  }
  
  ctx.ui.notify(lines.join("\n"), "info");
}

async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  
  const allTools = [...state.registeredTools.values()].flat();
  
  if (allTools.length === 0) {
    ctx.ui.notify("No MCP tools available", "info");
    return;
  }
  
  const lines = [
    "MCP Tools:",
    "",
    ...allTools.map(t => `  ${t}`),
    "",
    `Total: ${allTools.length} tools`,
  ];
  
  ctx.ui.notify(lines.join("\n"), "info");
}

async function reconnectServers(
  state: McpExtensionState,
  ctx: ExtensionContext
): Promise<void> {
  for (const [name, definition] of Object.entries(state.config.mcpServers)) {
    try {
      await state.manager.close(name);
      
      // Clear old entries before reconnecting (in case reconnection fails)
      state.registeredTools.delete(name);
      state.toolMetadata.delete(name);
      
      const connection = await state.manager.connect(name, definition);
      const prefix = state.config.settings?.toolPrefix ?? "server";
      
      // Collect tool names (NOT registered with Pi)
      const { collected: toolNames, failed: failedTools } = collectToolNames(
        connection.tools,
        { serverName: name, prefix }
      );
      
      // Collect resource tool names if enabled
      if (definition.exposeResources !== false && connection.resources.length > 0) {
        const resourceToolNames = collectResourceToolNames(
          connection.resources,
          { serverName: name, prefix }
        );
        toolNames.push(...resourceToolNames);
      }
      
      state.registeredTools.set(name, toolNames);
      
      // Update tool metadata for searching
      const metadata: ToolMetadata[] = connection.tools.map(tool => ({
        name: formatToolName(tool.name, name, prefix),
        originalName: tool.name,
        description: tool.description ?? "",
      }));
      for (const resource of connection.resources) {
        if (definition.exposeResources !== false) {
          const baseName = `get_${resourceNameToToolName(resource.name)}`;
          metadata.push({
            name: formatToolName(baseName, name, prefix),
            originalName: baseName,
            description: resource.description ?? `Read resource: ${resource.uri}`,
            resourceUri: resource.uri,
          });
        }
      }
      state.toolMetadata.set(name, metadata);
      
      if (ctx.hasUI) {
        ctx.ui.notify(
          `MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
          "info"
        );
        if (failedTools.length > 0) {
          ctx.ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error");
      }
    }
  }
  
  // Update status bar with new tool count
  if (ctx.hasUI) {
    const totalTools = [...state.registeredTools.values()].flat().length;
    if (totalTools > 0) {
      ctx.ui.setStatus("mcp", ctx.ui.theme.fg("accent", `MCP: ${totalTools} tools`));
    } else {
      ctx.ui.setStatus("mcp", "");
    }
  }
}

async function authenticateServer(
  serverName: string,
  config: McpConfig,
  ctx: ExtensionContext
): Promise<void> {
  if (!ctx.hasUI) return;
  
  const definition = config.mcpServers[serverName];
  if (!definition) {
    ctx.ui.notify(`Server "${serverName}" not found in config`, "error");
    return;
  }
  
  if (definition.auth !== "oauth") {
    ctx.ui.notify(
      `Server "${serverName}" does not use OAuth authentication.\n` +
      `Current auth mode: ${definition.auth ?? "none"}`,
      "error"
    );
    return;
  }
  
  if (!definition.url) {
    ctx.ui.notify(
      `Server "${serverName}" has no URL configured (OAuth requires HTTP transport)`,
      "error"
    );
    return;
  }
  
  // Show instructions for obtaining OAuth tokens
  const tokenPath = `~/.pi/agent/mcp-oauth/${serverName}/tokens.json`;
  
  ctx.ui.notify(
    `OAuth setup for "${serverName}":\n\n` +
    `1. Obtain an access token from your OAuth provider\n` +
    `2. Create the token file:\n` +
    `   ${tokenPath}\n\n` +
    `3. Add your token:\n` +
    `   {\n` +
    `     "access_token": "your-token-here",\n` +
    `     "token_type": "bearer"\n` +
    `   }\n\n` +
    `4. Run /mcp reconnect to connect with the token`,
    "info"
  );
}

/**
 * Truncate text at word boundary, aiming for target length.
 */
function truncateAtWord(text: string, target: number): string {
  if (!text || text.length <= target) return text;
  
  // Find last space before or at target
  const truncated = text.slice(0, target);
  const lastSpace = truncated.lastIndexOf(" ");
  
  if (lastSpace > target * 0.6) {
    // Found a reasonable break point
    return truncated.slice(0, lastSpace) + "...";
  }
  
  // No good break point, just cut at target
  return truncated + "...";
}
