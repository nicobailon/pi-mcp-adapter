import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import type { McpConfig, ServerEntry, McpPanelCallbacks, McpPanelResult, ImportKind } from "./types.js";
import {
  ensureCompatibilityImports,
  getMcpDiscoverySummary,
  getServerProvenance,
  previewCompatibilityImports,
  previewSharedServerEntry,
  previewStarterProjectConfig,
  writeDirectToolsConfig,
  writeSharedServerEntry,
  writeStarterProjectConfig,
} from "./config.js";
import { lazyConnect, updateMetadataCache, updateStatusBar, getFailureAgeSeconds } from "./init.js";
import { executePause, executeResume } from "./proxy-modes.js";
import { loadMetadataCache } from "./metadata-cache.js";
import { buildToolMetadata } from "./tool-metadata.js";
import { supportsOAuth, authenticate } from "./mcp-auth-flow.js";
import { hasStoredTokens } from "./mcp-auth.js";
import { loadOnboardingState, markSetupCompleted as persistSetupCompleted, markSharedConfigHintShown } from "./onboarding-state.js";
import { openPath } from "./utils.js";

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
    } else if (connection?.status === "needs-auth") {
      status = "needs auth";
      statusIcon = "⚠";
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
    lines.push("Run /mcp setup to adopt imports or scaffold a starter .mcp.json");
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
      if (connection.status === "needs-auth") {
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP: ${name} requires OAuth. Run /mcp-auth ${name} first.`, "warning");
        }
        continue;
      }
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
  ctx: ExtensionContext
): Promise<void> {
  if (!ctx.hasUI) return;

  const definition = config.mcpServers[serverName];
  if (!definition) {
    ctx.ui.notify(`Server "${serverName}" not found in config`, "error");
    return;
  }

  if (!supportsOAuth(definition)) {
    ctx.ui.notify(
      `Server "${serverName}" does not use OAuth authentication.\n` +
      `Set "auth": "oauth" or omit auth for auto-detection.`,
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

  try {
    ctx.ui.setStatus("mcp-auth", `Authenticating ${serverName}...`);
    const status = await authenticate(serverName, definition.url, definition);

    if (status === "authenticated") {
      ctx.ui.notify(
        `OAuth authentication successful for "${serverName}"!\n` +
        `Run /mcp reconnect ${serverName} to connect with the new token.`,
        "success"
      );
    } else {
      ctx.ui.notify(
        `OAuth authentication failed for "${serverName}".`,
        "error"
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to authenticate "${serverName}": ${message}`, "error");
  } finally {
    ctx.ui.setStatus("mcp-auth", undefined);
  }
}

export interface PanelFlowResult {
  configChanged: boolean;
}

function buildSharedConfigNoticeLines(configOverridePath?: string): { lines: string[]; fingerprint: string | null } {
  const discovery = getMcpDiscoverySummary(configOverridePath);
  const onboardingState = loadOnboardingState();
  if (!discovery.hasSharedServers || onboardingState.sharedConfigHintShown) {
    return { lines: [], fingerprint: null };
  }

  const sharedSources = discovery.sources.filter((source) => source.kind === "shared" && source.serverCount > 0);
  const sourceList = sharedSources.map((source) => source.path).join(", ");
  return {
    lines: [
      `Using standard MCP config from ${sourceList}.`,
      "Pi only writes compatibility imports and adapter-specific overrides into Pi-owned files when needed.",
    ],
    fingerprint: discovery.fingerprint,
  };
}

export async function openMcpSetup(
  _state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
  mode: "empty" | "setup" = "setup",
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };

  const discovery = getMcpDiscoverySummary(configOverridePath);
  const onboardingState = loadOnboardingState();
  const { createMcpSetupPanel } = await import("./mcp-setup-panel.js");
  let configChanged = false;

  const callbacks = {
    previewImports: (imports: ImportKind[]) => previewCompatibilityImports(imports, configOverridePath),
    previewStarterProject: () => previewStarterProjectConfig(),
    previewRepoPrompt: () => {
      const repoPrompt = getMcpDiscoverySummary(configOverridePath).repoPrompt;
      if (!repoPrompt.entry || !repoPrompt.targetPath || !repoPrompt.serverName) return null;
      return previewSharedServerEntry(repoPrompt.targetPath, repoPrompt.serverName, repoPrompt.entry);
    },
    adoptImports: async (imports: ImportKind[]) => {
      const result = ensureCompatibilityImports(imports, configOverridePath);
      if (result.added.length > 0) configChanged = true;
      return result;
    },
    scaffoldProjectConfig: async () => {
      const path = writeStarterProjectConfig();
      configChanged = true;
      return { path };
    },
    addRepoPrompt: async () => {
      const repoPrompt = getMcpDiscoverySummary(configOverridePath).repoPrompt;
      if (!repoPrompt.entry || !repoPrompt.targetPath || !repoPrompt.serverName) {
        throw new Error("RepoPrompt is not available to add from this setup screen.");
      }
      const path = writeSharedServerEntry(repoPrompt.targetPath, repoPrompt.serverName, repoPrompt.entry);
      configChanged = true;
      return { path, serverName: repoPrompt.serverName };
    },
    openPath: async (targetPath: string) => {
      await openPath(pi, targetPath);
    },
    markSetupCompleted: () => {
      persistSetupCompleted(discovery.fingerprint);
    },
  };

  return new Promise<PanelFlowResult>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, _keybindings, done) => {
        return createMcpSetupPanel(discovery, callbacks, { mode, onboardingState }, tui, () => {
          done();
          resolve({ configChanged });
        });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: 92 } },
    );
  });
}

export async function openMcpPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<PanelFlowResult> {
  if (Object.keys(state.config.mcpServers).length === 0) {
    return openMcpSetup(state, pi, ctx, configOverridePath, "empty");
  }

  const config = state.config;
  const cache = loadMetadataCache();
  const provenanceMap = getServerProvenance(pi.getFlag("mcp-config") as string | undefined ?? configOverridePath);
  const { lines: noticeLines, fingerprint } = buildSharedConfigNoticeLines(pi.getFlag("mcp-config") as string | undefined ?? configOverridePath);

  const callbacks: McpPanelCallbacks = {
    reconnect: async (serverName: string) => {
      return lazyConnect(state, serverName);
    },
    getConnectionStatus: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      const connection = state.manager.getConnection(serverName);
      if (connection?.status === "needs-auth") {
        return "needs-auth";
      }
      if (
        definition?.auth === "oauth"
        && definition.oauth !== false
        && definition.oauth?.grantType !== "client_credentials"
        && !hasStoredTokens(serverName)
      ) {
        return "needs-auth";
      }
      if (connection?.status === "connected") return "connected";
      if (getFailureAgeSeconds(state, serverName) !== null) return "failed";
      return "idle";
    },
    refreshCacheAfterReconnect: (serverName: string) => {
      const freshCache = loadMetadataCache();
      return freshCache?.servers?.[serverName] ?? null;
    },
    isPaused: (serverName: string) => state.pausedServers.has(serverName),
    pause: async (serverName: string) => {
      await executePause(state, serverName);
    },
    // Panel resume only unpauses — no eager reconnect. Connection happens
    // lazily on the next tool call. (executeResume is used by the AI tool
    // and does reconnect eagerly, which is the right behaviour there.)
    resume: async (serverName: string) => {
      state.pausedServers.delete(serverName);
      state.failureTracker.delete(serverName);
      updateStatusBar(state);
    },
  };

  const { createMcpPanel } = await import("./mcp-panel.js");
  let configChanged = false;

  await new Promise<void>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, keybindings, done) => {
        return createMcpPanel(config, cache, provenanceMap, callbacks, tui, keybindings, (result: McpPanelResult) => {
          if (!result.cancelled && result.changes.size > 0) {
            writeDirectToolsConfig(result.changes, provenanceMap, config);
            configChanged = true;
            ctx.ui.notify("Direct tools updated. Pi will reload after this panel closes.", "info");
          }
          done();
          resolve();
        }, { noticeLines });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: 82 } },
    );
  });

  if (noticeLines.length > 0 && fingerprint) {
    markSharedConfigHintShown(fingerprint);
  }

  return { configChanged };
}
