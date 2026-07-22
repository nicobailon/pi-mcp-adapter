import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { existsSync } from "node:fs";
import { loadMcpConfig } from "./config.ts";
import { ConsentManager } from "./consent-manager.ts";
import { McpLifecycleManager } from "./lifecycle.ts";
import {
  computeServerHash,
  getMetadataCachePath,
  isServerCacheValid,
  loadMetadataCache,
  reconstructToolMetadata,
  saveMetadataCache,
  serializeResources,
  serializeTools,
  type ServerCacheEntry,
} from "./metadata-cache.ts";
import { McpServerManager } from "./server-manager.ts";
import { buildToolMetadata, totalToolCount } from "./tool-metadata.ts";
import { UiResourceHandler } from "./ui-resource-handler.ts";
import { openUrl, parallelLimit } from "./utils.ts";
import { logger } from "./logger.ts";
import { getMissingConfiguredDirectToolServers } from "./direct-tools.ts";
import { throwIfAborted } from "./abort.ts";
import {
  combineAbortSignals,
  createMcpRuntimeOwner,
  createOwnedUi,
  isAbortError,
  type McpRuntimeOwner,
} from "./runtime-owner.ts";

const FAILURE_BACKOFF_MS = 60 * 1000;

export function isTuiMode(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

export async function initializeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  owner: McpRuntimeOwner = createMcpRuntimeOwner(),
): Promise<McpExtensionState> {
  // ExtensionContext getters are guarded and become invalid after reload. Read
  // every session-bound value exactly once before the first await, then retain
  // only owner-fenced values in callbacks.
  const configPath = pi.getFlag("mcp-config") as string | undefined;
  const cwd = ctx.cwd;
  const hasUI = ctx.hasUI;
  const mode = ctx.mode;
  const rawUi = hasUI ? ctx.ui : undefined;
  const ui = rawUi ? createOwnedUi(rawUi, owner) : undefined;
  const modelRegistry = ctx.modelRegistry;
  const initialModel = ctx.model;
  const initialSignal = ctx.signal;
  const config = loadMcpConfig(configPath, cwd);

  const manager = new McpServerManager(cwd);
  manager.setRuntimeSignal(owner.signal);
  manager.setDefaultRequestTimeoutMs(config.settings?.requestTimeoutMs);
  const samplingAutoApprove = config.settings?.samplingAutoApprove === true;
  if (config.settings?.sampling !== false && (hasUI || samplingAutoApprove)) {
    manager.setSamplingConfig({
      autoApprove: samplingAutoApprove,
      ui,
      modelRegistry,
      // Never retain the guarded ExtensionContext in server callbacks. Pi marks
      // that context stale after reload, while the runtime owner remains the
      // authoritative cancellation fence for this extension instance.
      getCurrentModel: () => owner.isActive() ? initialModel : undefined,
      getSignal: () => combineAbortSignals(owner.signal, initialSignal),
    });
  }
  const elicitationEnabled = config.settings?.elicitation !== false && hasUI;
  if (elicitationEnabled && ui) {
    manager.setElicitationConfig({
      ui,
      allowUrl: mode === "tui",
    });
  }
  const lifecycle = new McpLifecycleManager(manager);
  const toolMetadata = new Map<string, ToolMetadata[]>();
  const failureTracker = new Map<string, number>();
  const uiResourceHandler = new UiResourceHandler(manager);
  const consentManager = new ConsentManager("once-per-server");
  const state: McpExtensionState = {
    owner,
    manager,
    lifecycle,
    toolMetadata,
    config,
    failureTracker,
    uiResourceHandler,
    consentManager,
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async (url: string) => {
      owner.throwIfInactive();
      await openUrl(pi, url, process.env.BROWSER, owner.signal);
      owner.throwIfInactive();
    },
    ui,
    sendMessage: (message, options) => {
      if (!owner.isActive()) return;
      pi.sendMessage(message as unknown as Parameters<typeof pi.sendMessage>[0], options);
    },
  };
  owner.addCleanup(() => lifecycle.gracefulShutdown());
  owner.addCleanup(() => {
    if (state.uiServer) {
      state.uiServer.close("runtime_owner_stopped");
      state.uiServer = null;
    }
  });

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
      const metadata = reconstructToolMetadata(name, cache.servers[name], prefix, definition);
      toolMetadata.set(name, metadata);
    }
  }

  const startupServers = bootstrapAll
    ? serverEntries
    : serverEntries.filter(([, definition]) => {
        const mode = definition.lifecycle ?? "lazy";
        return mode === "keep-alive" || mode === "eager";
      });

  if (ui && startupServers.length > 0) {
    ui.setStatus("mcp", `MCP: connecting to ${startupServers.length} servers...`);
  }

  const results = await parallelLimit(startupServers, 10, async ([name, definition]) => {
    try {
      const connection = await manager.connect(name, definition, owner.signal);
      if (connection.status === "needs-auth") {
        return { name, definition, connection: null, error: `OAuth authentication required. Run /mcp-auth ${name}.` };
      }
      return { name, definition, connection, error: null };
    } catch (error) {
      if (isAbortError(error, owner.signal)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return { name, definition, connection: null, error: message };
    }
  });

  owner.throwIfInactive();
  for (const { name, definition, connection, error } of results) {
    owner.throwIfInactive();
    if (error || !connection) {
      if (ui) {
        ui.notify(`MCP: Failed to connect to ${name}: ${error}`, "error");
      }
      console.error(`MCP: Failed to connect to ${name}: ${error}`);
      continue;
    }

    const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
    toolMetadata.set(name, metadata);
    updateMetadataCache(state, name);

    if (failedTools.length > 0 && ui) {
      ui.notify(
        `MCP: ${name} - ${failedTools.length} tools skipped`,
        "warning"
      );
    }
  }

  const connectedCount = results.filter(r => r.connection).length;
  const failedCount = results.filter(r => r.error).length;
  if (ui && connectedCount > 0) {
    const totalTools = totalToolCount(state);
    const msg = failedCount > 0
      ? `MCP: ${connectedCount}/${startupServers.length} servers connected (${totalTools} tools)`
      : `MCP: ${connectedCount} servers connected (${totalTools} tools)`;
    ui.notify(msg, "info");
  }

  const envDirect = process.env.MCP_DIRECT_TOOLS;
  if (envDirect !== "__none__") {
    const currentCache = loadMetadataCache();
    const missingCacheServers = getMissingConfiguredDirectToolServers(config, currentCache);

    if (missingCacheServers.length > 0) {
      const bootstrapResults = await parallelLimit(
        missingCacheServers.filter(name => !results.some(r => r.name === name && r.connection)),
        10,
        async (name) => {
          const definition = config.mcpServers[name];
          try {
            const connection = await manager.connect(name, definition, owner.signal);
            if (connection.status === "needs-auth") {
              return { name, ok: false };
            }
            const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
            toolMetadata.set(name, metadata);
            updateMetadataCache(state, name);
            return { name, ok: true };
          } catch (error) {
            if (isAbortError(error, owner.signal)) throw error;
            const message = error instanceof Error ? error.message : String(error);
            logger.debug(`MCP: direct-tools bootstrap failed for ${name}: ${message}`);
            return { name, ok: false };
          }
        },
      );
      const bootstrapped = bootstrapResults.filter(r => r.ok).map(r => r.name);
      owner.throwIfInactive();
      if (bootstrapped.length > 0 && ui) {
        ui.notify(`MCP: direct tools for ${bootstrapped.join(", ")} will be available after restart`, "info");
      }
    }
  }

  lifecycle.setReconnectCallback((serverName) => {
    if (!owner.isActive()) return;
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    state.failureTracker.delete(serverName);
    updateStatusBar(state);
  });

  lifecycle.setIdleShutdownCallback((serverName) => {
    if (!owner.isActive()) return;
    const idleMinutes = getEffectiveIdleTimeoutMinutes(state, serverName);
    logger.debug(`${serverName} shut down (idle ${idleMinutes}m)`);
    updateStatusBar(state);
  });

  owner.throwIfInactive();
  lifecycle.startHealthChecks(owner.signal);

  return state;
}

export function updateServerMetadata(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;

  const prefix = state.config.settings?.toolPrefix ?? "server";

  const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
  state.toolMetadata.set(serverName, metadata);
}

export function updateMetadataCache(state: McpExtensionState, serverName: string): void {
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

export function flushMetadataCache(state: McpExtensionState): void {
  for (const [name, connection] of state.manager.getAllConnections()) {
    if (connection.status === "connected") {
      updateMetadataCache(state, name);
    }
  }
}

export function updateStatusBar(state: McpExtensionState): void {
  const ui = state.ui;
  if (!ui) return;
  const total = Object.keys(state.config.mcpServers).length;
  if (total === 0) {
    ui.setStatus("mcp", undefined);
    return;
  }
  const connectedCount = state.manager.getAllConnections().size;
  ui.setStatus("mcp", ui.theme.fg("accent", `MCP: ${connectedCount}/${total} servers`));
}

export function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
  const failedAt = state.failureTracker.get(serverName);
  if (!failedAt) return null;
  const ageMs = Date.now() - failedAt;
  if (ageMs > FAILURE_BACKOFF_MS) return null;
  return Math.round(ageMs / 1000);
}

export async function lazyConnect(state: McpExtensionState, serverName: string, signal?: AbortSignal): Promise<boolean> {
  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    return false;
  }
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
    const newConnection = await state.manager.connect(serverName, definition, signal);
    if (newConnection.status === "needs-auth") {
      return false;
    }
    state.failureTracker.delete(serverName);
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    updateStatusBar(state);
    return true;
  } catch (error) {
    if (signal?.aborted) {
      throwIfAborted(signal);
    }
    state.failureTracker.set(serverName, Date.now());
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`MCP: lazy connect failed for ${serverName}: ${message}`);
    updateStatusBar(state);
    return false;
  }
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
