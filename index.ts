import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { Type } from "typebox";
import { showStatus, showTools, reconnectServers, authenticateServer, logoutServer, openMcpAuthPanel, openMcpPanel, openMcpSetup } from "./commands.ts";
import { loadMcpConfig } from "./config.ts";
import { buildProxyDescription, createDirectToolExecutor, getMissingConfiguredDirectToolServers, resolveDirectTools } from "./direct-tools.ts";
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { executeCall, executeConnect, executeDescribe, executeList, executeSearch, executeStatus, executeUiMessages } from "./proxy-modes.ts";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.ts";
import { initializeOAuth, shutdownOAuth } from "./mcp-auth-flow.ts";
import { renderMcpToolResult } from "./tool-result-renderer.ts";

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let lifecycleGeneration = 0;

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;

    if (currentState.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    try {
      flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

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
  const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(earlyConfig, earlyCache);
  const shouldRegisterProxyTool =
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0;

  for (const spec of directSpecs) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: Type.Unsafe((spec.inputSchema || { type: "object", properties: {} }) as never),
      execute: createDirectToolExecutor(() => state, () => initPromise, spec),
      renderResult: renderMcpToolResult,
    });
  }

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;

    try {
      await Promise.all([
        shutdownState(previousState, "session_restart"),
        shutdownOAuth(),
      ]);
    } catch (error) {
      console.error("MCP: failed to shut down previous session state", error);
    }

    if (generation !== lifecycleGeneration) {
      return;
    }

    await initializeOAuth().catch(err => {
      console.error("MCP OAuth initialization failed:", err);
    });

    const promise = initializeMcp(pi, ctx);
    initPromise = promise;

    promise.then(async (nextState) => {
      if (generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, "stale_session_start");
        } catch (error) {
          console.error("MCP: failed to clean stale session state", error);
        }
        return;
      }

      state = nextState;
      updateStatusBar(nextState);
      initPromise = null;
    }).catch(err => {
      if (generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      console.error("MCP initialization failed:", err);
      initPromise = null;
    });
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    state = null;
    initPromise = null;

    try {
      await Promise.all([
        shutdownState(currentState, "session_shutdown"),
        shutdownOAuth(),
      ]);
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
  });

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
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
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "setup": {
          const result = await openMcpSetup(state, pi, ctx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          await logoutServer(serverName, state, ctx);
          break;
        }
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            const result = await openMcpPanel(state, pi, ctx, earlyConfigPath);
            if (result?.configChanged) {
              await ctx.reload();
              return;
            }
          } else {
            await showStatus(state, ctx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) {
        return;
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      if (!serverName) {
        await openMcpAuthPanel(state, pi, ctx, earlyConfigPath);
        return;
      }

      await authenticateServer(serverName, state.config, ctx);
    },
  });

  if (shouldRegisterProxyTool) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
        args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
        connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
        describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
        search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
        action: Type.Optional(Type.String({ description: "Action: 'ui-messages' to retrieve prompts/intents from UI sessions" })),
      }),
      renderResult: renderMcpToolResult,
      async execute(toolCallId, params: {
        tool?: string;
        args?: string;
        connect?: string;
        describe?: string;
        search?: string;
        regex?: boolean;
        includeSchemas?: boolean;
        server?: string;
        action?: string;
      }, _signal, _onUpdate, _ctx) {
        const mode = inferMcpMode(params);
        const id = `mcp:${String(toolCallId)}`;
        const label = params.tool ?? params.describe ?? params.search ?? params.connect ?? params.server ?? params.action ?? mode;
        const startedAt = Date.now();
        let parsedArgs: Record<string, unknown> | undefined;
        if (params.args) {
          try {
            parsedArgs = JSON.parse(params.args);
            if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
              const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
              throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
            }
            throw error;
          }
        }

        const metadataBase = { mode, server: params.server, tool: params.tool, label };
        pi.events.emit("workitem:start", {
          id,
          kind: "mcp",
          label: String(label),
          status: "running",
          started_at: startedAt,
          updated_at: startedAt,
          provenance: "mcp",
          surface_tier: "collapsed",
          triggered_by: "agent",
          controls: ["expand"],
          metadata: metadataBase,
        });

        const run = async () => {
          if (!state && initPromise) {
            try {
              state = await initPromise;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
                details: { error: "init_failed", message },
              };
            }
          }
          if (!state) {
            return {
              content: [{ type: "text" as const, text: "MCP not initialized" }],
              details: { error: "not_initialized" },
            };
          }

          if (params.action === "ui-messages") {
            return executeUiMessages(state);
          }
          if (params.tool) {
            return executeCall(state, params.tool, parsedArgs, params.server, getPiTools);
          }
          if (params.connect) {
            return executeConnect(state, params.connect);
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
        };

        try {
          const result = await run();
          const details = (result.details ?? {}) as any;
          const isError = Boolean(details.error);
          pi.events.emit("workitem:end", {
            id,
            status: isError ? "error" : "ok",
            ended_at: Date.now(),
            summary: summarizeMcp((details.mode as string | undefined) ?? mode, details),
            metadata: { ...metadataBase, ...details },
          });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          pi.events.emit("workitem:end", {
            id,
            status: "error",
            ended_at: Date.now(),
            summary: message,
            failure_action: "inspect MCP tool error",
            metadata: { ...metadataBase, error: message },
          });
          throw error;
        }
      },
    });
  }
}

/** Infer mode from mcp() params before executor sets details.mode. */
function inferMcpMode(args: { tool?: string; describe?: string; search?: string; connect?: string; action?: string; server?: string }): string {
  if (args.tool) return "call";
  if (args.describe) return "describe";
  if (args.search) return "search";
  if (args.connect) return "connect";
  if (args.action === "ui-messages") return "ui-messages";
  if (args.server) return "list";
  return "status";
}

/** One-line summary per mode. Reads loosely-typed details from proxy-modes returns. */
function summarizeMcp(mode: string, d: any): string {
  switch (mode) {
    case "list": {
      const server = d.server ?? "?";
      const count = d.count ?? d.tools?.length ?? 0;
      return d.error ? `${server} · ${d.error}` : `${server} · ${count} tools`;
    }
    case "describe": {
      const tool = d.tool?.name ?? d.requestedTool ?? "?";
      return d.error ? `${tool} · ${d.error}` : tool;
    }
    case "call": {
      const tool = d.tool ?? d.requestedTool ?? "?";
      if (d.error) return `${tool} · ${d.error}`;
      const routed = d.routedViaSubagent ? " [sub]" : "";
      return `${tool} → ok${routed}`;
    }
    case "search": {
      const q = d.query ?? "?";
      const matches = d.count ?? d.matches?.length ?? 0;
      return d.error ? `"${q}" · ${d.error}` : `"${q}" · ${matches} matches`;
    }
    case "status": {
      const conn = d.connectedCount ?? 0;
      const total = d.servers?.length ?? 0;
      const tools = d.totalTools ?? 0;
      return `${conn}/${total} servers · ${tools} tools`;
    }
    case "connect": {
      const server = d.server ?? "?";
      return d.error ? `${server} · ${d.error}` : `${server} → ok`;
    }
    case "ui-messages": {
      const sessions = d.sessions ?? 0;
      const intents = d.intents?.length ?? 0;
      return `${sessions} sessions · ${intents} intents`;
    }
    default:
      return "";
  }
}
