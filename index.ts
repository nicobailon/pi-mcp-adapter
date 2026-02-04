// index.ts - Full extension entry point with commands
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { loadMcpConfig, getServerProvenance, writeDirectToolsConfig } from "./config.js";
import { formatToolName, getServerPrefix, type McpConfig, type McpContent, type ToolMetadata, type McpTool, type McpResource, type ServerEntry, type DirectToolSpec, type McpPanelCallbacks, type McpPanelResult } from "./types.js";
import { McpServerManager } from "./server-manager.js";
import { McpLifecycleManager } from "./lifecycle.js";
import { transformMcpContent } from "./tool-registrar.js";
import { resourceNameToToolName } from "./resource-tools.js";
import { getStoredTokens } from "./oauth-handler.js";
import {
  computeServerHash,
  getMetadataCachePath,
  isServerCacheValid,
  loadMetadataCache,
  type MetadataCache,
  reconstructToolMetadata,
  saveMetadataCache,
  serializeResources,
  serializeTools,
  type ServerCacheEntry,
} from "./metadata-cache.js";

interface McpExtensionState {
  manager: McpServerManager;
  lifecycle: McpLifecycleManager;
  toolMetadata: Map<string, ToolMetadata[]>;  // server -> tool metadata for searching
  config: McpConfig;
  failureTracker: Map<string, number>;
  ui?: ExtensionContext["ui"];
}

const FAILURE_BACKOFF_MS = 60 * 1000;

/**
 * Find a tool by name with hyphen/underscore normalization fallback.
 * MCP tools often use hyphens (resolve-library-id) but the prefix separator
 * is underscore, so LLMs naturally guess all-underscores. Try exact match
 * first, then normalized match.
 */
function findToolByName(metadata: ToolMetadata[] | undefined, toolName: string): ToolMetadata | undefined {
  if (!metadata) return undefined;
  const exact = metadata.find(m => m.name === toolName);
  if (exact) return exact;
  const normalized = toolName.replace(/-/g, "_");
  return metadata.find(m => m.name.replace(/-/g, "_") === normalized);
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

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);

function getConfigPathFromArgv(): string | undefined {
  const idx = process.argv.indexOf("--mcp-config");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function resolveDirectTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: "server" | "none" | "short",
  envOverride?: string[],
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  if (!cache) return specs;

  const seenNames = new Set<string>();

  const envServers = new Set<string>();
  const envTools = new Map<string, Set<string>>();
  if (envOverride) {
    for (let item of envOverride) {
      item = item.replace(/\/+$/, "");
      if (item.includes("/")) {
        const [server, tool] = item.split("/", 2);
        if (server && tool) {
          if (!envTools.has(server)) envTools.set(server, new Set());
          envTools.get(server)!.add(tool);
        } else if (server) {
          envServers.add(server);
        }
      } else if (item) {
        envServers.add(item);
      }
    }
  }

  const globalDirect = config.settings?.directTools;

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) continue;

    let toolFilter: true | string[] | false = false;

    if (envOverride) {
      if (envServers.has(serverName)) {
        toolFilter = true;
      } else if (envTools.has(serverName)) {
        toolFilter = [...envTools.get(serverName)!];
      }
    } else {
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }
    }

    if (!toolFilter) continue;

    for (const tool of serverCache.tools ?? []) {
      if (toolFilter !== true && !toolFilter.includes(tool.name)) continue;
      const prefixedName = formatToolName(tool.name, serverName, prefix);
      if (BUILTIN_NAMES.has(prefixedName)) {
        console.warn(`MCP: skipping direct tool "${prefixedName}" (collides with builtin)`);
        continue;
      }
      if (seenNames.has(prefixedName)) {
        console.warn(`MCP: skipping duplicate direct tool "${prefixedName}" from "${serverName}"`);
        continue;
      }
      seenNames.add(prefixedName);
      specs.push({
        serverName,
        originalName: tool.name,
        prefixedName,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      });
    }

    if (definition.exposeResources !== false) {
      for (const resource of serverCache.resources ?? []) {
        const baseName = `get_${resourceNameToToolName(resource.name)}`;
        if (toolFilter !== true && !toolFilter.includes(baseName)) continue;
        const prefixedName = formatToolName(baseName, serverName, prefix);
        if (BUILTIN_NAMES.has(prefixedName)) {
          console.warn(`MCP: skipping direct resource tool "${prefixedName}" (collides with builtin)`);
          continue;
        }
        if (seenNames.has(prefixedName)) {
          console.warn(`MCP: skipping duplicate direct resource tool "${prefixedName}" from "${serverName}"`);
          continue;
        }
        seenNames.add(prefixedName);
        specs.push({
          serverName,
          originalName: baseName,
          prefixedName,
          description: resource.description ?? `Read resource: ${resource.uri}`,
          resourceUri: resource.uri,
        });
      }
    }
  }

  return specs;
}

function buildProxyDescription(
  config: McpConfig,
  cache: MetadataCache | null,
  directSpecs: DirectToolSpec[],
): string {
  let desc = `MCP gateway - connect to MCP servers and call their tools.\n`;

  const directByServer = new Map<string, number>();
  for (const spec of directSpecs) {
    directByServer.set(spec.serverName, (directByServer.get(spec.serverName) ?? 0) + 1);
  }
  if (directByServer.size > 0) {
    const parts = [...directByServer.entries()].map(
      ([server, count]) => `${server} (${count})`,
    );
    desc += `\nDirect tools available (call as normal tools): ${parts.join(", ")}\n`;
  }

  const serverSummaries: string[] = [];
  for (const serverName of Object.keys(config.mcpServers)) {
    const entry = cache?.servers?.[serverName];
    const definition = config.mcpServers[serverName];
    const toolCount = entry?.tools?.length ?? 0;
    const resourceCount = definition?.exposeResources !== false ? (entry?.resources?.length ?? 0) : 0;
    const totalItems = toolCount + resourceCount;
    if (totalItems === 0) continue;
    const directCount = directByServer.get(serverName) ?? 0;
    const proxyCount = totalItems - directCount;
    if (proxyCount > 0) {
      serverSummaries.push(`${serverName} (${proxyCount} tools)`);
    }
  }

  if (serverSummaries.length > 0) {
    desc += `\nServers: ${serverSummaries.join(", ")}\n`;
  }

  desc += `\nUsage:\n`;
  desc += `  mcp({ })                              → Show server status\n`;
  desc += `  mcp({ server: "name" })               → List tools from server\n`;
  desc += `  mcp({ search: "query" })              → Search for tools (MCP + pi, space-separated words OR'd)\n`;
  desc += `  mcp({ describe: "tool_name" })        → Show tool details and parameters\n`;
  desc += `  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n`;
  desc += `  mcp({ tool: "name", args: '{"key": "value"}' })    → Call a tool (args is JSON string)\n`;
  desc += `\nMode: tool (call) > connect > describe > search > server (list) > nothing (status)`;

  return desc;
}

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;

  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directSpecs = envRaw === "__none__"
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map(s => s.trim()).filter(Boolean),
      );

  for (const spec of directSpecs) {
    pi.registerTool({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      parameters: Type.Unsafe<Record<string, unknown>>(spec.inputSchema || { type: "object", properties: {} }),
      async execute(_toolCallId, params) {
        if (!state && initPromise) {
          try { state = await initPromise; } catch {
            return {
              content: [{ type: "text" as const, text: "MCP initialization failed" }],
              details: { error: "init_failed" },
            };
          }
        }
        if (!state) {
          return {
            content: [{ type: "text" as const, text: "MCP not initialized" }],
            details: { error: "not_initialized" },
          };
        }

        const s = state;
        const connected = await lazyConnect(s, spec.serverName);
        if (!connected) {
          const failedAgo = getFailureAgeSeconds(s, spec.serverName);
          return {
            content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not available${failedAgo !== null ? ` (failed ${failedAgo}s ago)` : ""}` }],
            details: { error: "server_unavailable", server: spec.serverName },
          };
        }

        const connection = s.manager.getConnection(spec.serverName);
        if (!connection || connection.status !== "connected") {
          return {
            content: [{ type: "text" as const, text: `MCP server "${spec.serverName}" not connected` }],
            details: { error: "not_connected", server: spec.serverName },
          };
        }

        try {
          s.manager.touch(spec.serverName);
          s.manager.incrementInFlight(spec.serverName);

          const requestTimeout = getEffectiveRequestTimeoutMs(s, spec.serverName);
          const requestOptions = typeof requestTimeout === "number" ? { timeout: requestTimeout } : undefined;

          if (spec.resourceUri) {
            const result = await connection.client.readResource({ uri: spec.resourceUri }, requestOptions);
            const content = (result.contents ?? []).map(c => ({
              type: "text" as const,
              text: "text" in c ? c.text : ("blob" in c ? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]` : JSON.stringify(c)),
            }));
            return {
              content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }],
              details: { server: spec.serverName, resourceUri: spec.resourceUri },
            };
          }

          const result = await connection.client.callTool({
            name: spec.originalName,
            arguments: params ?? {},
          }, undefined, requestOptions);

          const mcpContent = (result.content ?? []) as McpContent[];
          const content = transformMcpContent(mcpContent);

          if (result.isError) {
            let errorText = content.filter(c => c.type === "text").map(c => (c as { text: string }).text).join("\n") || "Tool execution failed";
            if (spec.inputSchema) {
              errorText += `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}`;
            }
            return {
              content: [{ type: "text" as const, text: `Error: ${errorText}` }],
              details: { error: "tool_error", server: spec.serverName },
            };
          }

          return {
            content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
            details: { server: spec.serverName, tool: spec.originalName },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          let errorText = `Failed to call tool: ${message}`;
          if (spec.inputSchema) {
            errorText += `\n\nExpected parameters:\n${formatSchema(spec.inputSchema)}`;
          }
          return {
            content: [{ type: "text" as const, text: errorText }],
            details: { error: "call_failed", server: spec.serverName },
          };
        } finally {
          s.manager.decrementInFlight(spec.serverName);
          s.manager.touch(spec.serverName);
        }
      },
    });
  }

  // Capture pi tool accessor (closure) for unified search
  const getPiTools = (): ToolInfo[] => pi.getAllTools();
  
  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });
  
  pi.on("session_start", async (_event, ctx) => {
    // Non-blocking init - Pi starts immediately, MCP connects in background
    initPromise = initializeMcp(pi, ctx);
    
    initPromise.then(s => {
      state = s;
      initPromise = null;
      updateStatusBar(s);
    }).catch(err => {
      console.error("MCP initialization failed:", err);
      initPromise = null;
    });
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
      flushMetadataCache(state);
      await state.lifecycle.gracefulShutdown();
      state = null;
    }
  });
  
  // /mcp command
  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      // Wait for init if still in progress
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          if (ctx.hasUI) ctx.ui.notify("MCP initialization failed", "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }
      
      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      
      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            await openMcpPanel(state, pi, ctx, earlyConfigPath);
          } else {
            await showStatus(state, ctx);
          }
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
      
      // Wait for init if still in progress
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          if (ctx.hasUI) ctx.ui.notify("MCP initialization failed", "error");
          return;
        }
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
    description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
    parameters: Type.Object({
      // Call mode
      tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
      args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
      connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
      // Describe mode
      describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
      // Search mode
      search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
      includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
      // Filter (works with search or list)
      server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
    }),
    async execute(_toolCallId, params: {
      tool?: string;
      args?: string;
      connect?: string;
      describe?: string;
      search?: string;
      regex?: boolean;
      includeSchemas?: boolean;
      server?: string;
    }, _signal, _onUpdate, _ctx) {
      // Parse args from JSON string if provided
      let parsedArgs: Record<string, unknown> | undefined;
      if (params.args) {
        try {
          parsedArgs = JSON.parse(params.args);
          if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
            const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
            return {
              content: [{ type: "text", text: `Invalid args: expected a JSON object, got ${gotType}` }],
              isError: true,
              details: { error: "invalid_args_type" },
            };
          }
        } catch (e) {
          return {
            content: [{ type: "text", text: `Invalid args JSON: ${e instanceof Error ? e.message : e}` }],
            isError: true,
            details: { error: "invalid_args" },
          };
        }
      }
      
      // Wait for init if still in progress
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          return {
            content: [{ type: "text", text: "MCP initialization failed" }],
            details: { error: "init_failed" },
          };
        }
      }
      if (!state) {
        return {
          content: [{ type: "text", text: "MCP not initialized" }],
          details: { error: "not_initialized" },
        };
      }
      
      // Mode resolution: tool > connect > describe > search > server > status
      if (params.tool) {
        return executeCall(state, params.tool, parsedArgs, params.server);
      }
      if (params.connect) {
        return executeConnect(state, params.connect);
      }
      if (params.describe) {
        return executeDescribe(state, params.describe);
      }
      if (params.search) {
        return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas, getPiTools);
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
    const toolCount = getToolNames(state, name).length;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    if (connection?.status === "connected") {
      status = "connected";
    } else if (failedAgo !== null) {
      status = "failed";
    } else if (state.toolMetadata.has(name)) {
      status = "cached";
    }

    servers.push({ name, status, toolCount });
  }

  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const connectedCount = servers.filter(s => s.status === "connected").length;

  let text = `MCP: ${connectedCount}/${servers.length} servers, ${totalTools} tools\n\n`;
  for (const server of servers) {
    if (server.status === "connected") {
      text += `✓ ${server.name} (${server.toolCount} tools)\n`;
      continue;
    }
    if (server.status === "cached") {
      text += `○ ${server.name} (${server.toolCount} tools, cached)\n`;
      continue;
    }
    if (server.status === "failed") {
      const failedAgo = getFailureAgeSeconds(state, server.name) ?? 0;
      text += `✗ ${server.name} (failed ${failedAgo}s ago)\n`;
      continue;
    }
    text += `○ ${server.name} (not connected)\n`;
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
    const found = findToolByName(metadata, toolName);
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
  includeSchemas?: boolean,
  getPiTools?: () => ToolInfo[]
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
  
  // Search pi tools (unless server filter is specified)
  const piMatches: Array<{ name: string; description: string }> = [];
  if (!server && getPiTools) {
    const piTools = getPiTools();
    for (const tool of piTools) {
      // Skip the mcp tool itself to avoid confusion
      if (tool.name === "mcp") continue;
      
      if (pattern.test(tool.name) || pattern.test(tool.description ?? "")) {
        piMatches.push({
          name: tool.name,
          description: tool.description ?? "",
        });
      }
    }
  }
  
  // Search MCP tools (existing logic)
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
  
  // Combine counts
  const totalCount = piMatches.length + matches.length;
  
  if (totalCount === 0) {
    const msg = server
      ? `No tools matching "${query}" in "${server}"`
      : `No tools matching "${query}"`;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "search", matches: [], count: 0, query },
    };
  }
  
  let text = `Found ${totalCount} tool${totalCount === 1 ? "" : "s"} matching "${query}":\n\n`;
  
  // Pi tools first (with [pi tool] prefix)
  for (const match of piMatches) {
    if (showSchemas) {
      // Full format (consistent with MCP tools)
      text += `[pi tool] ${match.name}\n`;
      text += `  ${match.description || "(no description)"}\n`;
      text += `  No parameters (call directly).\n`;
      text += "\n";
    } else {
      // Compact format
      text += `[pi tool] ${match.name}`;
      if (match.description) {
        text += ` - ${truncateAtWord(match.description, 50)}`;
      }
      text += "\n";
    }
  }
  
  // MCP tools (existing format, no prefix change for backwards compat)
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
    details: {
      mode: "search",
      matches: [
        ...piMatches.map(m => ({ server: "pi", tool: m.name })),
        ...matches.map(m => ({ server: m.server, tool: m.tool.name })),
      ],
      count: totalCount,
      query,
    },
  };
}

function executeList(state: McpExtensionState, server: string) {
  if (!state.config.mcpServers[server]) {
    return {
      content: [{ type: "text" as const, text: `Server "${server}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
    };
  }

  const metadata = state.toolMetadata.get(server);
  const toolNames = getToolNames(state, server);
  const hasMetadata = state.toolMetadata.has(server);
  const connection = state.manager.getConnection(server);

  if (toolNames.length === 0) {
    if (connection?.status === "connected") {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no tools.` }],
        details: { mode: "list", server, tools: [], count: 0 },
      };
    }
    if (hasMetadata) {
      return {
        content: [{ type: "text" as const, text: `Server "${server}" has no cached tools (not connected).` }],
        details: { mode: "list", server, tools: [], count: 0, cached: true },
      };
    }
    return {
      content: [{ type: "text" as const, text: `Server "${server}" is configured but not connected. Use mcp({ connect: "${server}" }) or /mcp reconnect ${server} to retry.` }],
      details: { mode: "list", server, tools: [], count: 0, error: "not_connected" },
    };
  }

  const cachedNote = connection?.status === "connected" ? "" : " (not connected, cached)";
  let text = `${server} (${toolNames.length} tools${cachedNote}):\n\n`;

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

async function executeConnect(state: McpExtensionState, serverName: string) {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "connect", error: "not_found", server: serverName },
    };
  }

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    const connection = await state.manager.connect(serverName, definition);
    const prefix = state.config.settings?.toolPrefix ?? "server";
    const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
    state.toolMetadata.set(serverName, metadata);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
    return executeList(state, serverName);
  } catch (error) {
    state.failureTracker.set(serverName, Date.now());
    updateStatusBar(state);
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
      details: { mode: "connect", error: "connect_failed", server: serverName, message },
    };
  }
}

async function executeCall(
  state: McpExtensionState,
  toolName: string,
  args?: Record<string, unknown>,
  serverOverride?: string
) {
  // Find the tool in metadata
  let serverName: string | undefined = serverOverride;
  let toolMeta: ToolMetadata | undefined;
  const prefixMode = state.config.settings?.toolPrefix ?? "server";

  if (serverName && !state.config.mcpServers[serverName]) {
    return {
      content: [{ type: "text" as const, text: `Server "${serverName}" not found. Use mcp({}) to see available servers.` }],
      details: { mode: "call", error: "server_not_found", server: serverName },
    };
  }

  if (serverName) {
    toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
  } else {
    for (const [server, metadata] of state.toolMetadata.entries()) {
      const found = findToolByName(metadata, toolName);
      if (found) {
        serverName = server;
        toolMeta = found;
        break;
      }
    }
  }

  if (serverName && !toolMeta) {
    const connected = await lazyConnect(state, serverName);
    if (connected) {
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
    } else {
      const failedAgo = getFailureAgeSeconds(state, serverName);
      if (failedAgo !== null) {
        return {
          content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
          details: { mode: "call", error: "server_backoff", server: serverName },
        };
      }
    }
  }

  let prefixMatchedServer: string | undefined;

  if (!serverName && !toolMeta && prefixMode !== "none") {
    const candidates = Object.keys(state.config.mcpServers)
      .map(name => ({ name, prefix: getServerPrefix(name, prefixMode) }))
      .filter(c => c.prefix && toolName.startsWith(c.prefix + "_"))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { name: configuredServer } of candidates) {
      const failedAgo = getFailureAgeSeconds(state, configuredServer);
      if (failedAgo !== null) continue;
      const connected = await lazyConnect(state, configuredServer);
      if (!connected) continue;
      if (!prefixMatchedServer) prefixMatchedServer = configuredServer;
      toolMeta = findToolByName(state.toolMetadata.get(configuredServer), toolName);
      if (toolMeta) {
        serverName = configuredServer;
        break;
      }
    }
  }

  if (!serverName || !toolMeta) {
    const hintServer = serverName ?? prefixMatchedServer;
    const available = hintServer ? getToolNames(state, hintServer) : [];
    let msg = `Tool "${toolName}" not found.`;
    if (available.length > 0) {
      msg += ` Server "${hintServer}" has: ${available.join(", ")}`;
    } else {
      msg += ` Use mcp({ search: "..." }) to search.`;
    }
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { mode: "call", error: "tool_not_found", requestedTool: toolName, hintServer },
    };
  }

  let connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") {
    const failedAgo = getFailureAgeSeconds(state, serverName);
    if (failedAgo !== null) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)` }],
        details: { mode: "call", error: "server_backoff", server: serverName },
      };
    }

    const definition = state.config.mcpServers[serverName];
    if (!definition) {
      return {
        content: [{ type: "text" as const, text: `Server "${serverName}" not connected` }],
        details: { mode: "call", error: "server_not_connected", server: serverName },
      };
    }

    try {
      if (state.ui) {
        state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
      }
      connection = await state.manager.connect(serverName, definition);
      state.failureTracker.delete(serverName);
      updateServerMetadata(state, serverName);
      updateMetadataCache(state, serverName);
      updateStatusBar(state);
      toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
      if (!toolMeta) {
        const available = getToolNames(state, serverName);
        const hint = available.length > 0
          ? `Available tools on "${serverName}": ${available.join(", ")}`
          : `Server "${serverName}" has no tools.`;
        return {
          content: [{ type: "text" as const, text: `Tool "${toolName}" not found on "${serverName}" after reconnect. ${hint}` }],
          details: { mode: "call", error: "tool_not_found_after_reconnect", requestedTool: toolName },
        };
      }
    } catch (error) {
      state.failureTracker.set(serverName, Date.now());
      updateStatusBar(state);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` }],
        details: { mode: "call", error: "connect_failed", message },
      };
    }
  }

  try {
    state.manager.touch(serverName);
    state.manager.incrementInFlight(serverName);

    // Get timeout: server-specific > global settings > SDK default (60s)
    const requestTimeout = getEffectiveRequestTimeoutMs(state, serverName);
    const requestOptions = typeof requestTimeout === "number" ? { timeout: requestTimeout } : undefined;

    // Resource tools use readResource, regular tools use callTool
    if (toolMeta.resourceUri) {
      const result = await connection.client.readResource({ uri: toolMeta.resourceUri }, requestOptions);
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
    }, undefined, requestOptions);

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
  } finally {
    state.manager.decrementInFlight(serverName);
    state.manager.touch(serverName);
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
  const toolMetadata = new Map<string, ToolMetadata[]>();
  const failureTracker = new Map<string, number>();
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const state: McpExtensionState = { manager, lifecycle, toolMetadata, config, failureTracker, ui };
  
  const serverEntries = Object.entries(config.mcpServers);
  if (serverEntries.length === 0) {
    return state;
  }

  const idleSetting = typeof config.settings?.idleTimeout === "number" ? config.settings.idleTimeout : 10;
  lifecycle.setGlobalIdleTimeout(idleSetting);

  const cachePath = getMetadataCachePath();
  const cacheFileExists = existsSync(cachePath);
  let cache = loadMetadataCache();
  let bootstrapAll = false;

  if (!cacheFileExists) {
    bootstrapAll = true;
    saveMetadataCache({ version: 1, servers: {} });
  } else if (!cache) {
    cache = { version: 1, servers: {} };
    saveMetadataCache(cache);
  }

  const prefix = config.settings?.toolPrefix ?? "server";

  // Register servers and hydrate metadata from cache if valid
  for (const [name, definition] of serverEntries) {
    const lifecycleMode = definition.lifecycle ?? "lazy";
    const idleOverride = definition.idleTimeout ?? (lifecycleMode === "eager" ? 0 : undefined);
    lifecycle.registerServer(
      name,
      definition,
      idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined
    );
    if (lifecycleMode === "keep-alive") {
      lifecycle.markKeepAlive(name, definition);
    }

    if (cache?.servers?.[name] && isServerCacheValid(cache.servers[name], definition)) {
      const metadata = reconstructToolMetadata(name, cache.servers[name], prefix, definition.exposeResources);
      toolMetadata.set(name, metadata);
    }
  }

  const startupServers = bootstrapAll
    ? serverEntries
    : serverEntries.filter(([, definition]) => {
        const mode = definition.lifecycle ?? "lazy";
        return mode === "keep-alive" || mode === "eager";
      });

  if (ctx.hasUI && startupServers.length > 0) {
    ctx.ui.setStatus("mcp", `MCP: connecting to ${startupServers.length} servers...`);
  }

  // Connect selected servers in parallel (max 10 concurrent)
  const results = await parallelLimit(startupServers, 10, async ([name, definition]) => {
    try {
      const connection = await manager.connect(name, definition);
      return { name, definition, connection, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name, definition, connection: null, error: message };
    }
  });

  // Process results
  for (const { name, definition, connection, error } of results) {
    if (error || !connection) {
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to connect to ${name}: ${error}`, "error");
      }
      console.error(`MCP: Failed to connect to ${name}: ${error}`);
      continue;
    }

    const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
    toolMetadata.set(name, metadata);
    updateMetadataCache(state, name);

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
    const totalTools = totalToolCount(state);
    const msg = failedCount > 0
      ? `MCP: ${connectedCount}/${startupServers.length} servers connected (${totalTools} tools)`
      : `MCP: ${connectedCount} servers connected (${totalTools} tools)`;
    ctx.ui.notify(msg, "info");
  }

  const envDirect = process.env.MCP_DIRECT_TOOLS;
  if (envDirect !== "__none__") {
    const missingCacheServers: string[] = [];
    const currentCache = loadMetadataCache();
    for (const [name, definition] of serverEntries) {
      const hasDirect = definition.directTools !== undefined
        ? !!definition.directTools
        : !!config.settings?.directTools;
      if (!hasDirect) continue;
      const entry = currentCache?.servers?.[name];
      if (!entry || !isServerCacheValid(entry, definition)) {
        missingCacheServers.push(name);
      }
    }

    if (missingCacheServers.length > 0) {
      const bootstrapResults = await parallelLimit(
        missingCacheServers.filter(name => !results.some(r => r.name === name && r.connection)),
        10,
        async (name) => {
          const definition = config.mcpServers[name];
          try {
            const connection = await manager.connect(name, definition);
            const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
            toolMetadata.set(name, metadata);
            updateMetadataCache(state, name);
            return { name, ok: true };
          } catch {
            return { name, ok: false };
          }
        },
      );
      const bootstrapped = bootstrapResults.filter(r => r.ok).map(r => r.name);
      if (bootstrapped.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`MCP: direct tools for ${bootstrapped.join(", ")} will be available after restart`, "info");
      }
    }
  }

  lifecycle.setReconnectCallback((serverName) => {
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
  });

  lifecycle.setIdleShutdownCallback((serverName) => {
    const idleMinutes = getEffectiveIdleTimeoutMinutes(state, serverName);
    console.log(`MCP: ${serverName} shut down (idle ${idleMinutes}m)`);
    updateStatusBar(state);
  });

  lifecycle.startHealthChecks();

  return state;
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

  const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
  state.toolMetadata.set(serverName, metadata);
}

async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  
  const lines: string[] = ["MCP Server Status:", ""];
  
  // Show all configured servers, not just connected ones
  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const toolCount = getToolNames(state, name).length;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    let statusIcon = "○";
    let failed = false;

    if (connection?.status === "connected") {
      status = "connected";
      statusIcon = "✓";
    } else if (failedAgo !== null) {
      status = `failed ${failedAgo}s ago`;
      statusIcon = "✗";
      failed = true;
    } else if (state.toolMetadata.has(name)) {
      status = "cached";
    }

    const toolSuffix = failed ? "" : ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`;
    lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`);
  }
  
  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
  }
  
  ctx.ui.notify(lines.join("\n"), "info");
}

async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  
  const allTools = [...state.toolMetadata.values()].flat().map(m => m.name);
  
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
  ctx: ExtensionContext,
  targetServer?: string
): Promise<void> {
  if (targetServer && !state.config.mcpServers[targetServer]) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    }
    return;
  }

  const entries = targetServer
    ? [[targetServer, state.config.mcpServers[targetServer]] as [string, ServerEntry]]
    : Object.entries(state.config.mcpServers);

  for (const [name, definition] of entries) {
    try {
      await state.manager.close(name);

      const connection = await state.manager.connect(name, definition);
      const prefix = state.config.settings?.toolPrefix ?? "server";

      const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
      state.toolMetadata.set(name, metadata);
      updateMetadataCache(state, name);
      state.failureTracker.delete(name);

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
      state.failureTracker.set(name, Date.now());
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error");
      }
    }
  }
  
  // Update status bar with server count
  updateStatusBar(state);
}

function buildToolMetadata(
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
    metadata.push({
      name: formatToolName(tool.name, serverName, prefix),
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of resources) {
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

function updateMetadataCache(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const configHash = computeServerHash(definition);
  const existing = loadMetadataCache();
  const existingEntry = existing?.servers?.[serverName];

  const tools = serializeTools(connection.tools);
  let resources = definition.exposeResources === false ? [] : serializeResources(connection.resources);

  if (
    definition.exposeResources !== false &&
    resources.length === 0 &&
    existingEntry?.resources?.length &&
    existingEntry.configHash === configHash
  ) {
    resources = existingEntry.resources;
  }

  const entry: ServerCacheEntry = {
    configHash,
    tools,
    resources,
    cachedAt: Date.now(),
  };

  saveMetadataCache({ version: 1, servers: { [serverName]: entry } });
}

function flushMetadataCache(state: McpExtensionState): void {
  for (const [name, connection] of state.manager.getAllConnections()) {
    if (connection.status === "connected") {
      updateMetadataCache(state, name);
    }
  }
}

function getToolNames(state: McpExtensionState, serverName: string): string[] {
  return state.toolMetadata.get(serverName)?.map(m => m.name) ?? [];
}

function totalToolCount(state: McpExtensionState): number {
  let count = 0;
  for (const metadata of state.toolMetadata.values()) {
    count += metadata.length;
  }
  return count;
}

function updateStatusBar(state: McpExtensionState): void {
  const ui = state.ui;
  if (!ui) return;
  const total = Object.keys(state.config.mcpServers).length;
  if (total === 0) {
    ui.setStatus("mcp", "");
    return;
  }
  const connectedCount = state.manager.getAllConnections().size;
  ui.setStatus("mcp", ui.theme.fg("accent", `MCP: ${connectedCount}/${total} servers`));
}

function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
  const failedAt = state.failureTracker.get(serverName);
  if (!failedAt) return null;
  const ageMs = Date.now() - failedAt;
  if (ageMs > FAILURE_BACKOFF_MS) return null;
  return Math.round(ageMs / 1000);
}

function getEffectiveIdleTimeoutMinutes(state: McpExtensionState, serverName: string): number {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
  }
  if (typeof definition.idleTimeout === "number") return definition.idleTimeout;
  const mode = definition.lifecycle ?? "lazy";
  if (mode === "eager") return 0;
  return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
}

function getEffectiveRequestTimeoutMs(state: McpExtensionState, serverName: string): number | undefined {
  const definition = state.config.mcpServers[serverName];
  if (definition && typeof definition.requestTimeout === "number") return definition.requestTimeout;
  if (typeof state.config.settings?.requestTimeout === "number") return state.config.settings.requestTimeout;
  return undefined;
}

async function lazyConnect(state: McpExtensionState, serverName: string): Promise<boolean> {
  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "connected") {
    updateServerMetadata(state, serverName);
    return true;
  }

  const failedAgo = getFailureAgeSeconds(state, serverName);
  if (failedAgo !== null) return false;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return false;

  try {
    if (state.ui) {
      state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
    }
    await state.manager.connect(serverName, definition);
    state.failureTracker.delete(serverName);
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    updateStatusBar(state);
    return true;
  } catch {
    state.failureTracker.set(serverName, Date.now());
    updateStatusBar(state);
    return false;
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

async function openMcpPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<void> {
  const config = state.config;
  const cache = loadMetadataCache();
  const provenanceMap = getServerProvenance(pi.getFlag("mcp-config") as string | undefined ?? configOverridePath);

  const callbacks: McpPanelCallbacks = {
    reconnect: async (serverName: string) => {
      return lazyConnect(state, serverName);
    },
    getConnectionStatus: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      if (definition?.auth === "oauth" && getStoredTokens(serverName) === undefined) {
        return "needs-auth";
      }
      const connection = state.manager.getConnection(serverName);
      if (connection?.status === "connected") return "connected";
      if (getFailureAgeSeconds(state, serverName) !== null) return "failed";
      return "idle";
    },
    refreshCacheAfterReconnect: (serverName: string) => {
      const freshCache = loadMetadataCache();
      return freshCache?.servers?.[serverName] ?? null;
    },
  };

  const { createMcpPanel } = await import("./mcp-panel.js");

  return new Promise<void>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, _keybindings, done) => {
        return createMcpPanel(config, cache, provenanceMap, callbacks, tui, (result: McpPanelResult) => {
          if (!result.cancelled && result.changes.size > 0) {
            writeDirectToolsConfig(result.changes, provenanceMap, config);
            ctx.ui.notify("Direct tools updated. Restart pi to apply.", "info");
          }
          done();
          resolve();
        });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: 82 } },
    );
  });
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
