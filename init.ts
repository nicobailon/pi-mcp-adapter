import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { formatToolName, isServerDisabled, resolveToolPrefix, type McpAdapterOptions, type PromptMetadata, type ToolMetadata, type ToolSelectorCandidateIndex } from "./types.ts";
import { existsSync } from "node:fs";
import { cloneMcpConfig, loadMcpConfig } from "./config.ts";
import { ConsentManager } from "./consent-manager.ts";
import { McpLifecycleManager } from "./lifecycle.ts";
import {
  computeServerHash,
  createCachedToolSelectorCandidateIndex,
  getMetadataCachePath,
  getMissingConfiguredDirectToolServers,
  isServerCacheValid,
  loadMetadataCache,
  reconstructPromptMetadata,
  reconstructToolMetadata,
  saveMetadataCache,
  serializePrompts,
  serializeResources,
  serializeTools,
  type ServerCacheEntry,
} from "./metadata-cache.ts";
import { McpServerManager, isTransientHttpConnectError } from "./server-manager.ts";
import { buildToolMetadata, totalToolCount } from "./tool-metadata.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { UiResourceHandler } from "./ui-resource-handler.ts";
import { formatMcpStatus, openUrl, parallelLimit, sanitizeTerminalText } from "./utils.ts";
import { logger } from "./logger.ts";
import { throwIfAborted } from "./abort.ts";
import { getAuthStorageOptions } from "./mcp-auth.ts";
import { createOAuthRuntime, hasPendingAuth, shutdownOAuth, type McpOAuthRuntime } from "./mcp-auth-flow.ts";
import {
  combineAbortSignals,
  createMcpRuntimeOwner,
  createOwnedUi,
  isAbortError,
  type McpRuntimeOwner,
} from "./runtime-owner.ts";
import { publishMcpStatusSnapshot } from "./mcp-status.ts";
import { FAILURE_BACKOFF_MS, getFailureAgeSeconds } from "./failure-backoff.ts";
export { getFailureAgeSeconds, getFailureMessage, isServerInActiveFailureBackoff } from "./failure-backoff.ts";

const MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
const failureExpiryTimers = new WeakMap<McpExtensionState, Map<string, ReturnType<typeof setTimeout>>>();

function getFailureExpiryTimers(state: McpExtensionState): Map<string, ReturnType<typeof setTimeout>> {
  let timers = failureExpiryTimers.get(state);
  if (!timers) {
    timers = new Map();
    failureExpiryTimers.set(state, timers);
  }
  return timers;
}

export function clearFailure(state: McpExtensionState, serverName: string, restoredReason?: string): boolean {
  const wasActive = getFailureAgeSeconds(state, serverName) !== null;
  state.failureTracker.delete(serverName);
  state.failureMessages?.delete(serverName);
  const timers = failureExpiryTimers.get(state);
  const timer = timers?.get(serverName);
  if (timer) clearTimeout(timer);
  timers?.delete(serverName);
  if (restoredReason && wasActive) {
    notifyToolMetadataUpdated(state, serverName, restoredReason);
    publishMcpStatusSnapshot(state);
  }
  return wasActive;
}

export function recordFailure(state: McpExtensionState, serverName: string, message: string): void {
  clearFailure(state, serverName);
  const failedAt = Date.now();
  state.failureTracker.set(serverName, failedAt);
  state.failureMessages?.set(serverName, message.slice(0, MAX_FAILURE_MESSAGE_CHARS));
  const timer = setTimeout(() => {
    if (!state.owner.isActive()) {
      getFailureExpiryTimers(state).delete(serverName);
      return;
    }
    if (state.failureTracker.get(serverName) === failedAt) {
      state.failureTracker.delete(serverName);
      state.failureMessages?.delete(serverName);
      notifyToolMetadataUpdated(state, serverName, "failure-backoff-expired");
      publishMcpStatusSnapshot(state);
    }
    getFailureExpiryTimers(state).delete(serverName);
  }, FAILURE_BACKOFF_MS);
  timer.unref?.();
  getFailureExpiryTimers(state).set(serverName, timer);
  notifyToolMetadataUpdated(state, serverName, "failure-backoff-started");
  publishMcpStatusSnapshot(state);
}

export function isTuiMode(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

type McpInitializationOptions = McpAdapterOptions & {
  oauthRuntime?: McpOAuthRuntime;
  statusEvents?: McpExtensionState["statusEvents"];
};

export async function initializeMcp(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  owner: McpRuntimeOwner = createMcpRuntimeOwner(),
  options: McpInitializationOptions = {},
): Promise<McpExtensionState> {
  // Pi guards ExtensionContext getters after reload. Snapshot all values that
  // can be used by asynchronous work before the first await.
  const configPath = options.config !== undefined
    ? undefined
    : options.configPath ?? (pi.getFlag("mcp-config") as string | undefined);
  const cwd = ctx.cwd;
  const hasUI = ctx.hasUI;
  const mode = ctx.mode;
  const rawUi = hasUI ? ctx.ui : undefined;
  const modelRegistry = ctx.modelRegistry;
  const initialSignal = ctx.signal;
  const ui = rawUi ? createOwnedUi(rawUi, owner) : undefined;
  const runtimeSignal = combineAbortSignals(owner.signal, initialSignal);
  const config = options.config !== undefined
    ? cloneMcpConfig(options.config)
    : loadMcpConfig(configPath, cwd);
  const authStorageOptions = getAuthStorageOptions(config.settings?.oauthDir, cwd);

  const ownsOAuthRuntime = options.oauthRuntime === undefined;
  const oauthRuntime = options.oauthRuntime ?? createOAuthRuntime(owner.signal);
  const manager = new McpServerManager(cwd);
  manager.setRuntimeSignal?.(owner.signal);
  manager.setOAuthRuntime?.(oauthRuntime);
  manager.setDefaultRequestTimeoutMs(config.settings?.requestTimeoutMs);
  manager.setTraceConfig?.(config.settings?.trace);
  manager.setAuthStorageOptions(authStorageOptions);
  const samplingAutoApprove = config.settings?.samplingAutoApprove === true;
  if (config.settings?.sampling !== false && (hasUI || samplingAutoApprove)) {
    manager.setSamplingConfig({
      autoApprove: samplingAutoApprove,
      ...(ui !== undefined ? { ui } : {}),
      modelRegistry,
      getCurrentModel: () => owner.isActive() ? ctx.model : undefined,
      getSignal: () => owner.isActive()
        ? combineAbortSignals(owner.signal, ctx.signal)
        : owner.signal,
    });
  }
  const elicitationEnabled = config.settings?.elicitation !== false && hasUI;
  if (elicitationEnabled && ui) {
    manager.setElicitationConfig({
      ui,
      allowUrl: mode === "tui",
    });
  }
  const lifecycle = new McpLifecycleManager(manager, (serverName) => hasPendingAuth(serverName, undefined, oauthRuntime));
  const toolMetadata = new Map<string, ToolMetadata[]>();
  const resourceCounts = new Map<string, number>();
  const promptMetadata = new Map<string, PromptMetadata[]>();
  const promptMetadataLive = new Set<string>();
  const serverInstructions = new Map<string, string>();
  const failureTracker = new Map<string, number>();
  const failureMessages = new Map<string, string>();
  const approvedToolCalls = new Map<string, true>();
  const uiResourceHandler = new UiResourceHandler(manager, config);
  const consentManager = new ConsentManager("once-per-server");
  const state: McpExtensionState = {
    owner,
    manager,
    lifecycle,
    toolMetadata,
    resourceCounts,
    promptMetadata,
    promptMetadataLive,
    serverInstructions,
    config,
    programmaticConfig: options.config !== undefined,
    oauthRuntime,
    authStorageOptions,
    failureTracker,
    failureMessages,
    approvedToolCalls,
    approvalEvents: pi.events,
    uiResourceHandler,
    consentManager,
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async (url: string) => {
      owner.throwIfInactive();
      await openUrl(pi, url, process.env.BROWSER, owner.signal);
      owner.throwIfInactive();
    },
    ...(ui !== undefined ? { ui } : {}),
    sendMessage: (message, options) => {
      const deliver = () => {
        if (!owner.isActive()) return;
        pi.sendMessage(message as unknown as Parameters<typeof pi.sendMessage>[0], options);
      };
      if (!options?.triggerTurn) {
        deliver();
        return;
      }
      void lifecycle.ensureConverged(owner.signal).then(deliver, error => {
        if (!owner.isActive() || isAbortError(error, owner.signal)) return;
        const detail = error instanceof Error ? error.message : String(error);
        logger.debug(`MCP: pre-turn keep-alive convergence failed: ${sanitizeTerminalText(detail)}`);
        deliver();
      });
    },
    ...(options.statusEvents !== undefined ? { statusEvents: options.statusEvents } : {}),
  };
  if (ownsOAuthRuntime) owner.addCleanup(() => shutdownOAuth(oauthRuntime));
  manager.setMetadataListChangedListener?.((serverName, reason) => {
    if (!owner.isActive()) return;
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName, { preserveEmptyResources: false });
    notifyToolMetadataUpdated(state, serverName, reason);
    updateStatusBar(state);
  });
  owner.addCleanup(() => lifecycle.gracefulShutdown());
  owner.addCleanup(() => {
    if (state.uiServer) {
      state.uiServer.close("runtime_owner_stopped");
      state.uiServer = null;
    }
  });

  const allServerEntries = Object.entries(config.mcpServers);
  const serverEntries = allServerEntries.filter(([, definition]) => !isServerDisabled(definition));
  if (serverEntries.length === 0) {
    if (allServerEntries.length > 0 && hasUI) {
      ui?.notify(`MCP: All ${allServerEntries.length} server(s) are disabled`, "info");
    }
    publishMcpStatusSnapshot(state);
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
  let cachedSelectorCandidateIndex: ToolSelectorCandidateIndex | undefined;

  for (const [name, definition] of serverEntries) {
    const lifecycleMode = definition.lifecycle ?? "lazy";
    const persistsAfterFirstSpawn = lifecycleMode === "eager" || lifecycleMode === "lazy-keep-alive";
    const idleOverride = definition.idleTimeout ?? (persistsAfterFirstSpawn ? 0 : undefined);
    lifecycle.registerServer(
      name,
      definition,
      idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined
    );
    if (lifecycleMode === "keep-alive") {
      lifecycle.markKeepAlive(name, definition);
    }

    const cachedEntry = cache?.servers?.[name];
    if (cachedEntry && isServerCacheValid(cachedEntry, definition)) {
      const hasToolFilters =
        (Array.isArray(definition.includeTools) && definition.includeTools.length > 0) ||
        (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0);
      if (hasToolFilters && !cachedSelectorCandidateIndex && cache) {
        cachedSelectorCandidateIndex = createCachedToolSelectorCandidateIndex(config.mcpServers, cache, prefix);
      }
      const metadata = reconstructToolMetadata(name, cachedEntry, prefix, definition, config.mcpServers, cache ?? undefined, cachedSelectorCandidateIndex);
      toolMetadata.set(name, metadata);
      if (Array.isArray(cachedEntry.resources)) {
        resourceCounts.set(name, cachedEntry.resources.length);
      }
      if (cachedEntry.prompts?.length) {
        promptMetadata.set(name, reconstructPromptMetadata(name, cachedEntry.prompts ?? [], prefix, definition));
      }
      if (cachedEntry.instructions) {
        serverInstructions.set(name, cachedEntry.instructions);
      }
    }
  }

  const startupServers = bootstrapAll
    ? serverEntries
    : serverEntries.filter(([, definition]) => {
        const mode = definition.lifecycle ?? "lazy";
        return mode === "keep-alive" || mode === "eager";
      });

  if (ui && startupServers.length > 0) {
    const status = formatMcpStatus(state.config, `connecting to ${startupServers.length} servers...`);
    ui.setStatus("mcp", status);
  }

  const results = await parallelLimit(startupServers, 10, async ([name, definition]) => {
    try {
      const connection = await manager.connect(name, definition, runtimeSignal);
      if (connection.status === "needs-auth") {
        return { name, definition, connection: null, error: `OAuth authentication required. Run /mcp-auth ${name}.`, transient: false };
      }
      return { name, definition, connection, error: null, transient: false };
    } catch (error) {
      if (isAbortError(error, runtimeSignal)) {
        if (owner.signal.aborted) throw error;
        return { name, definition, connection: null, error: null, transient: false };
      }
      const transient = isTransientHttpConnectError(error);
      const message = error instanceof Error ? error.message : String(error);
      return { name, definition, connection: null, error: message, transient };
    }
  });

  if (initialSignal?.aborted) return state;
  owner.throwIfInactive();

  const startupKnownMetadata = new Map<string, ToolMetadata[]>();
  for (const { name, definition, connection } of results) {
    if (!connection) continue;
    const effectivePrefix = resolveToolPrefix(definition, prefix);
    const metadata: ToolMetadata[] = [
      ...connection.tools.filter(tool => tool?.name).map(tool => ({
        name: formatToolName(tool.name, name, effectivePrefix),
        originalName: tool.name,
        description: tool.description ?? "",
      })),
      ...(definition.exposeResources !== false ? connection.resources.filter(resource => resource?.name && resource?.uri).map(resource => {
        const originalName = `read_${resourceNameToToolName(resource.name)}`;
        return {
          name: formatToolName(originalName, name, effectivePrefix),
          originalName,
          description: resource.description ?? `Read resource: ${resource.uri}`,
          resourceUri: resource.uri,
        };
      }) : []),
    ];
    startupKnownMetadata.set(name, metadata);
  }

  for (const { name, definition, connection, error, transient } of results) {
    owner.throwIfInactive();
    if (error || !connection) {
      if (initialSignal?.aborted) continue;
      if (error) recordFailure(state, name, error);
      if (transient) {
        const notice = `MCP: ${name} temporarily unavailable (HTTP 503); retry later`;
        logger.debug(`MCP: startup connect hit transient upstream outage for ${name}; will retry`);
        if (ui) ui.notify(notice, "warning");
        else console.error(notice);
        continue;
      }
      const displayError = sanitizeTerminalText(error ?? "Unknown connection failure");
      if (ui) {
        ui.notify(`MCP: Failed to connect to ${name}: ${displayError}`, "error");
      }
      console.error(`MCP: Failed to connect to ${name}: ${displayError}`);
      continue;
    }

    const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix, config.mcpServers, startupKnownMetadata, true);
    toolMetadata.set(name, metadata);
    resourceCounts.set(name, connection.resources.length);
    if (!connection.promptDiscoveryFailed) {
      promptMetadata.set(name, reconstructPromptMetadata(name, connection.prompts ?? [], prefix, definition));
      promptMetadataLive.add(name);
    }
    if (connection.instructions) {
      serverInstructions.set(name, connection.instructions);
    } else {
      serverInstructions.delete(name);
    }
    updateMetadataCache(state, name);
    notifyToolMetadataUpdated(state, name, "startup");
    markKeepAliveAfterConnect(state, name);

    if (failedTools.length > 0 && ui) {
      ui.notify(
        `MCP: ${name} - ${failedTools.length} tools skipped`,
        "warning"
      );
    }
  }

  const connectedCount = results.filter(r => r.connection).length;
  const failedCount = results.filter(r => r.error).length;
  if (ui && connectedCount > 0 && config.settings?.notifyOnStartupConnect !== false) {
    const totalTools = totalToolCount(state);
    const msg = failedCount > 0
      ? `MCP: ${connectedCount}/${startupServers.length} servers connected (${totalTools} tools)`
      : `MCP: ${connectedCount} servers connected (${totalTools} tools)`;
    ui.notify(msg, "info");
  }

  const envDirect = process.env.MCP_DIRECT_TOOLS;
  if (envDirect !== "__none__") {
    const currentCache = loadMetadataCache();
    const envDirectToolOverride = envDirect?.split(",").map(selector => selector.trim()).filter(Boolean);
    const missingCacheServers = getMissingConfiguredDirectToolServers(config, currentCache, envDirectToolOverride);

    if (missingCacheServers.length > 0) {
      const bootstrapResults = await parallelLimit(
        missingCacheServers.filter(name => !results.some(r => r.name === name && r.connection)),
        10,
        async (name) => {
          try {
            const definition = config.mcpServers[name];
            if (!definition) throw new Error(`MCP server "${name}" is not configured`);
            const connection = await manager.connect(name, definition, runtimeSignal);
            if (connection.status === "needs-auth") {
              return { name, ok: false };
            }
            updateServerMetadata(state, name);
            updateMetadataCache(state, name);
            const restored = clearFailure(state, name, "direct-tools-bootstrap");
            if (!restored) notifyToolMetadataUpdated(state, name, "direct-tools-bootstrap");
            markKeepAliveAfterConnect(state, name);
            return { name, ok: true };
          } catch (error) {
            if (isAbortError(error, runtimeSignal)) {
              if (owner.signal.aborted) throw error;
              return { name, ok: false };
            }
            const message = error instanceof Error ? error.message : String(error);
            recordFailure(state, name, message);
            logger.debug(`MCP: direct-tools bootstrap failed for ${name}: ${sanitizeTerminalText(message)}`);
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
    const restored = clearFailure(state, serverName, "lifecycle-reconnect");
    if (!restored) notifyToolMetadataUpdated(state, serverName, "lifecycle-reconnect");
    updateStatusBar(state);
  });

  lifecycle.setReconnectFailureCallback((serverName, error) => {
    if (!owner.isActive()) return;
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(state, serverName, message);
    updateStatusBar(state);
  });

  lifecycle.setHealthRestoredCallback((serverName) => {
    if (!owner.isActive()) return;
    clearFailure(state, serverName, "health-restored");
    updateStatusBar(state);
  });

  lifecycle.setAuthRequiredCallback((serverName) => {
    if (!owner.isActive()) return;
    clearFailure(state, serverName, "auth-required");
    updateStatusBar(state);
  });

  lifecycle.setIdleShutdownCallback((serverName) => {
    if (!owner.isActive()) return;
    const idleMinutes = getEffectiveIdleTimeoutMinutes(state, serverName);
    logger.debug(`${serverName} shut down (idle ${idleMinutes}m)`);
    updateStatusBar(state);
  });

  owner.throwIfInactive();
  lifecycle.startHealthChecks(runtimeSignal);
  if (config.settings?.mcpFooterStatus === "off") {
    ui?.setStatus("mcp", undefined);
  }
  publishMcpStatusSnapshot(state);

  return state;
}

export function markKeepAliveAfterConnect(state: McpExtensionState, serverName: string): void {
  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) return;
  if ((definition.lifecycle ?? "lazy") === "lazy-keep-alive") {
    state.lifecycle.markKeepAlive(serverName, definition);
  }
}

export function updateServerMetadata(state: McpExtensionState, serverName: string): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition) return;
  if (isServerDisabled(definition)) {
    state.toolMetadata.delete(serverName);
    state.resourceCounts?.delete(serverName);
    state.promptMetadata?.delete(serverName);
    state.promptMetadataLive?.delete(serverName);
    state.serverInstructions.delete(serverName);
    return;
  }

  const prefix = state.config.settings?.toolPrefix ?? "server";

  const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix, state.config.mcpServers, state.toolMetadata);
  state.toolMetadata.set(serverName, metadata);
  state.resourceCounts?.set(serverName, connection.resources.length);
  if (!connection.promptDiscoveryFailed) {
    state.promptMetadata?.set(serverName, reconstructPromptMetadata(serverName, connection.prompts ?? [], prefix, definition));
    state.promptMetadataLive?.add(serverName);
  }
  if (connection.instructions) {
    state.serverInstructions?.set(serverName, connection.instructions);
  } else {
    state.serverInstructions?.delete(serverName);
  }
}

export function updateMetadataCache(
  state: McpExtensionState,
  serverName: string,
  options: { preserveEmptyResources?: boolean } = {},
): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;

  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) return;

  const configHash = computeServerHash(definition);
  const existing = loadMetadataCache();
  const existingEntry = existing?.servers?.[serverName];

  const tools = serializeTools(connection.tools);
  let resources = definition.exposeResources === false ? [] : serializeResources(connection.resources);
  const prompts = connection.promptDiscoveryFailed
    ? existingEntry?.configHash === configHash ? existingEntry.prompts : undefined
    : serializePrompts(connection.prompts ?? []);

  if (
    definition.exposeResources !== false &&
    resources.length === 0 &&
    existingEntry?.resources?.length &&
    existingEntry.configHash === configHash &&
    options.preserveEmptyResources !== false
  ) {
    resources = existingEntry.resources;
  }

  const entry: ServerCacheEntry = {
    configHash,
    tools,
    resources,
    ...(prompts !== undefined ? { prompts } : {}),
    ...(connection.instructions !== undefined ? { instructions: connection.instructions } : {}),
    ...(connection.toolListHints?.ttlMs !== undefined ? { ttlMs: connection.toolListHints.ttlMs } : {}),
    ...(connection.toolListHints?.cacheScope !== undefined ? { cacheScope: connection.toolListHints.cacheScope } : {}),
    cachedAt: Date.now(),
  };

  saveMetadataCache({ version: 1, servers: { [serverName]: entry } });
}

export function notifyToolMetadataUpdated(state: McpExtensionState, serverName: string, reason: string): void {
  try {
    const result = state.onToolMetadataUpdated?.(serverName, reason);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug(`MCP: metadata update hook failed for ${serverName}: ${message}`);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`MCP: metadata update hook failed for ${serverName}: ${message}`);
  }
}

export function flushMetadataCache(state: McpExtensionState): void {
  for (const [name, connection] of state.manager.getAllConnections()) {
    if (connection.status === "connected") {
      updateMetadataCache(state, name);
    }
  }
}

export function updateStatusBar(state: McpExtensionState): void {
  publishMcpStatusSnapshot(state);
  const ui = state.ui;
  if (!ui) return;
  const entries = Object.entries(state.config.mcpServers);
  const disabledCount = entries.filter(([, definition]) => isServerDisabled(definition)).length;
  const enabledCount = entries.length - disabledCount;
  if (entries.length === 0) {
    ui.setStatus("mcp", undefined);
    return;
  }
  const connectedCount = [...state.manager.getAllConnections()].filter(([name, connection]) => {
    const definition = state.config.mcpServers[name];
    return connection.status === "connected" && definition !== undefined && !isServerDisabled(definition);
  }).length;
  const footerStatus = state.config.settings?.mcpFooterStatus ?? "full";
  if (footerStatus === "off") {
    ui.setStatus("mcp", undefined);
    return;
  }

  let status = footerStatus === "compact"
    ? `MCP ${connectedCount}/${enabledCount}`
    : `${enabledCount} ${enabledCount === 1 ? "server" : "servers"} enabled`;
  if (footerStatus === "full") {
    if (connectedCount > 0) status += ` (${connectedCount} connected)`;
    if (disabledCount > 0) status += ` (${disabledCount} disabled)`;
  }
  const formattedStatus = footerStatus === "compact" ? status : formatMcpStatus(state.config, status);
  if (formattedStatus === undefined) {
    ui.setStatus("mcp", undefined);
    return;
  }
  const theme = ui.theme;
  const styledStatus = typeof theme?.fg === "function"
    ? theme.fg("accent", formattedStatus)
    : formattedStatus;
  ui.setStatus("mcp", styledStatus);
}

export async function lazyConnect(state: McpExtensionState, serverName: string, signal?: AbortSignal): Promise<boolean> {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  throwIfAborted(ownedSignal);
  const connection = state.manager.getConnection(serverName);
  if (connection?.status === "needs-auth") {
    return false;
  }
  if (connection?.status === "connected") {
    updateServerMetadata(state, serverName);
    markKeepAliveAfterConnect(state, serverName);
    return true;
  }

  const failedAgo = getFailureAgeSeconds(state, serverName);
  if (failedAgo !== null) return false;

  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) return false;

  try {
    if (state.ui) {
      const status = formatMcpStatus(state.config, `connecting to ${serverName}...`);
      state.ui.setStatus("mcp", status);
    }
    const newConnection = await state.manager.connect(serverName, definition, ownedSignal);
    if (newConnection.status === "needs-auth") {
      return false;
    }
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    const restored = clearFailure(state, serverName, "lazy-connect");
    if (!restored) notifyToolMetadataUpdated(state, serverName, "lazy-connect");
    markKeepAliveAfterConnect(state, serverName);
    updateStatusBar(state);
    return true;
  } catch (error) {
    if (isAbortError(error, ownedSignal)) {
      throwIfAborted(ownedSignal);
    }
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(state, serverName, message);
    logger.debug(`MCP: lazy connect failed for ${serverName}: ${sanitizeTerminalText(message)}`);
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
  if (mode === "eager" || mode === "lazy-keep-alive") return 0;
  return typeof state.config.settings?.idleTimeout === "number" ? state.config.settings.idleTimeout : 10;
}
