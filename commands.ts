import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import type { McpConfig, ServerEntry, McpPanelCallbacks, McpPanelResult } from "./types.js";
import { getServerProvenance, writeDirectToolsConfig } from "./config.js";
import { lazyConnect, updateMetadataCache, updateStatusBar, getFailureAgeSeconds } from "./init.js";
import { loadMetadataCache } from "./metadata-cache.js";
import { getStoredTokens } from "./oauth-handler.js";
import { buildToolMetadata } from "./tool-metadata.js";

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const lines: string[] = ["MCP Server Status:", ""];

  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
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
    } else if (metadata !== undefined) {
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

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
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

export async function reconnectServers(
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

  updateStatusBar(state);
}

export async function authenticateServer(
  serverName: string,
  config: McpConfig,
  ctx: ExtensionContext,
  state?: McpExtensionState,
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

  // If we have a state handle, kick off the real OAuth flow by asking the
  // server manager to (re)connect. The HTTP transport's OAuth helper will
  // start the loopback callback server, open the user's browser, do dynamic
  // client registration if needed, exchange the code for tokens, and persist
  // them under ~/.pi/agent/mcp-oauth/<server>/.
  if (state) {
    ctx.ui.notify(
      `OAuth: starting browser flow for "${serverName}"...\n` +
      `If your browser does not open automatically, watch the log for the URL.`,
      "info",
    );
    try {
      // Drop any existing connection so the manager re-runs createHttpTransport.
      await state.manager.close(serverName);
      const connection = await state.manager.connect(serverName, definition);
      const prefix = state.config.settings?.toolPrefix ?? "server";
      const { metadata } = buildToolMetadata(
        connection.tools,
        connection.resources,
        definition,
        serverName,
        prefix,
      );
      state.toolMetadata.set(serverName, metadata);
      updateMetadataCache(state, serverName);
      state.failureTracker.delete(serverName);
      updateStatusBar(state);
      ctx.ui.notify(
        `MCP: Authorized "${serverName}" — ${connection.tools.length} tools available`,
        "info",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.failureTracker.set(serverName, Date.now());
      ctx.ui.notify(
        `MCP: OAuth flow for "${serverName}" failed: ${message}\n\n` +
        `If your environment cannot open a browser, set PI_MCP_BROWSER=none and copy the URL from the log into a browser manually, ` +
        `or drop a pre-fetched access token into ~/.pi/agent/mcp-oauth/${serverName}/tokens.json and run /mcp reconnect ${serverName}.`,
        "error",
      );
    }
    return;
  }

  // Fallback (should not normally happen): just print the manual instructions.
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

export async function openMcpPanel(
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
