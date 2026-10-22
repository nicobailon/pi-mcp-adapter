import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { formatToolName, isServerDisabled, resolveToolPrefix, type McpAdapterOptions, type PromptMetadata, type ServerEntry, type ToolMetadata, type ToolSelectorCandidateIndex } from "./types.ts";
import { cloneMcpConfig, loadMcpConfig, resolveConfiguredClaudePluginMcp } from "./config.ts";
import { applyProjectServerTrustToConfig, describeBlockedScriptTool, describeProjectServerBlock, excludeProjectServersAtLoadTime, loadedScriptToolIssues, type ProjectTrustResult } from "./project-server-trust.ts";
import { ConsentManager } from "./consent-manager.ts";
import { McpLifecycleManager } from "./lifecycle.ts";
import {
  computeServerHash,
  createCachedToolSelectorCandidateIndex,
  executorAppToolMetadata,
  getMissingConfiguredDirectToolServers,
  isExecutorAppToolAllowed,
  isServerCacheValid,
  keepOutputShapes,
  loadMetadataCache,
  reconstructPromptMetadata,
  reconstructToolMetadata,
  saveExecutorCatalog,
  saveExecutorSignature,
  saveMetadataCache,
  serializePrompts,
  serializeResources,
  serializeTools,
  withSessionMetadata,
  type MetadataCache,
  type ServerCacheEntry,
} from "./metadata-cache.ts";
import { McpServerManager, isTransientHttpConnectError, type ServerConnection } from "./server-manager.ts";
import { buildToolMetadata, ownTools, totalToolCount, unavailableAppNotes } from "./tool-metadata.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { UiResourceHandler } from "./ui-resource-handler.ts";
import { formatMcpFooterStatus, formatMcpStatus, openUrl, parallelLimit, providerSignInMessage, sanitizeTerminalText } from "./utils.ts";
import { logger } from "./logger.ts";
import { abortable, throwIfAborted } from "./abort.ts";
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
import {
  createSessionApprovalWriter,
  restoreSessionApprovalState,
} from "./session-approvals.ts";
import { seedObservedOutputs } from "./output-shape.ts";
import { EXECUTOR_CATALOG_TTL_MS, fetchExecutorCatalog, isExecutorCatalogConnection, isExecutorCatalogEntry, type ExecutorCatalog } from "./executor-catalog.ts";
export { getFailureAgeSeconds, getFailureMessage } from "./failure-backoff.ts";

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
  onProjectTrustResolved?: () => void;
  /** Load-time runs have no Pi context, so project trust is unknown; session_start decides later. */
  excludeProjectServers?: boolean;
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
  const projectServersFlag = options.config !== undefined ? undefined : pi.getFlag("mcp-project-servers");
  if (projectServersFlag !== undefined && projectServersFlag !== "allow") {
    console.warn(`Ignoring --mcp-project-servers ${JSON.stringify(projectServersFlag)}; the only accepted value is "allow"`);
  }
  const cwd = ctx.cwd;
  const hasUI = ctx.hasUI;
  const mode = ctx.mode;
  const rawUi = hasUI ? ctx.ui : undefined;
  const modelRegistry = ctx.modelRegistry;
  const initialSignal = ctx.signal;
  let sessionManager: ExtensionContext["sessionManager"] | undefined;
  try {
    sessionManager = ctx.sessionManager;
  } catch {
    // Synthetic/load-time contexts may not expose a session manager.
  }
  let sessionBranch: readonly unknown[] = [];
  if (sessionManager) {
    try {
      sessionBranch = sessionManager.getBranch();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.debug(`MCP: could not read the active session branch for approval restore: ${detail}`);
    }
  }
  const ui = rawUi ? createOwnedUi(rawUi, owner) : undefined;
  const runtimeSignal = combineAbortSignals(owner.signal, initialSignal);
  const loadedConfig = options.config === undefined ? loadMcpConfig(configPath, cwd) : undefined;
  const trustResult: ProjectTrustResult = loadedConfig === undefined
    ? { config: resolveConfiguredClaudePluginMcp(cloneMcpConfig(options.config!), cwd), blockedServers: new Map() }
    : options.excludeProjectServers
      ? { config: excludeProjectServersAtLoadTime(loadedConfig), blockedServers: new Map() }
      : await applyProjectServerTrustToConfig(loadedConfig, ctx, { allowUnapproved: projectServersFlag === "allow" });
  options.onProjectTrustResolved?.();
  const config = trustResult.config;
  const authStorageOptions = getAuthStorageOptions(config.settings?.oauthDir, cwd, config.settings?.oauthCredentialStore);

  const ownsOAuthRuntime = options.oauthRuntime === undefined;
  const oauthRuntime = options.oauthRuntime ?? createOAuthRuntime(owner.signal);
  const manager = new McpServerManager(cwd);
  manager.setRuntimeSignal?.(owner.signal);
  manager.setOAuthRuntime?.(oauthRuntime);
  manager.setDefaultRequestTimeoutMs(config.settings?.requestTimeoutMs);
  manager.setTraceConfig?.(config.settings?.trace);
  manager.setAuthStorageOptions(authStorageOptions);
  // Pi before 0.99.2 has no getApiKeyForProvider; auth.provider servers then fail to connect with a notice.
  if (typeof modelRegistry?.getApiKeyForProvider === "function") {
    manager.setProviderToken(provider => modelRegistry.getApiKeyForProvider(provider));
  }
  const samplingAutoApprove = config.settings?.samplingAutoApprove === true;
  if (config.settings?.sampling !== false && (hasUI || samplingAutoApprove)) {
    manager.setSamplingConfig({
      autoApprove: samplingAutoApprove,
      ...(ui !== undefined ? { ui } : {}),
      modelRegistry,
      getCurrentModel: () => owner.isActive() ? ctx.model : undefined,
      getThinkingLevel: () => owner.isActive() ? pi.getThinkingLevel() : "off",
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
  const directToolCounts = new Map<string, number>();
  const resourceCounts = new Map<string, number>();
  const promptMetadata = new Map<string, PromptMetadata[]>();
  const promptMetadataLive = new Set<string>();
  const serverInstructions = new Map<string, string>();
  const failureTracker = new Map<string, number>();
  const failureMessages = new Map<string, string>();
  const approvedToolCalls = new Map<string, true>();
  const uiResourceHandler = new UiResourceHandler(manager, config);
  let appendEntry: ((customType: string, data?: unknown) => void) | undefined;
  try {
    const candidate = pi.appendEntry;
    appendEntry = typeof candidate === "function" ? candidate.bind(pi) : undefined;
  } catch {
    // Load-time or synthetic APIs may not expose appendEntry yet.
  }
  const persistSessionApproval = sessionManager && appendEntry
    ? createSessionApprovalWriter(appendEntry, () => owner.isActive())
    : undefined;
  const consentManager = new ConsentManager("once-per-server", persistSessionApproval);
  const state: McpExtensionState = {
    owner,
    manager,
    lifecycle,
    toolMetadata,
    directToolCounts,
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
    blockedProjectServers: trustResult.blockedServers,
    blockedScriptTools: trustResult.blockedScriptTools ?? new Map(),
    ...(loadedConfig !== undefined ? { scriptToolLoadIssues: loadedScriptToolIssues(loadedConfig) } : {}),
    approvedServers: new Map(),
    ...(persistSessionApproval !== undefined ? { persistSessionApproval } : {}),
    ...(sessionManager !== undefined ? { sessionManager } : {}),
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
  if (sessionManager) restoreSessionApprovalState(state, sessionBranch);
  if (ownsOAuthRuntime) owner.addCleanup(() => shutdownOAuth(oauthRuntime));
  manager.setMetadataListChangedListener?.((serverName, reason) => {
    if (!owner.isActive()) return;
    updateServerMetadata(state, serverName);
    updateMetadataCache(state, serverName);
    notifyToolMetadataUpdated(state, serverName, reason);
    updateStatusBar(state);
  });
  manager.setListenStateChangedListener?.(() => {
    if (!owner.isActive()) return;
    updateStatusBar(state);
  });
  owner.addCleanup(() => {
    state.approvedServers = new Map();
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
  if (serverEntries.length === 0 && allServerEntries.length > 0 && hasUI) {
    ui?.notify(`MCP: All ${allServerEntries.length} server(s) are disabled`, "info");
  }
  if (trustResult.blockedServers.size > 0) {
    const summary = [...trustResult.blockedServers].map(([name, entry]) => `${name} (${describeProjectServerBlock(entry.reason)})`).join(", ");
    if (hasUI) ui?.notify(`MCP: Project servers blocked: ${summary}`, "warning");
    else console.warn(`MCP: Project servers blocked: ${summary}`);
  }
  for (const [name, block] of trustResult.blockedScriptTools ?? []) {
    const line = describeBlockedScriptTool(name, block);
    if (hasUI) ui?.notify(line, "warning");
    else console.warn(`MCP: ${line}`);
  }

  const idleSetting = typeof config.settings?.idleTimeout === "number" ? config.settings.idleTimeout : 10;
  lifecycle.setGlobalIdleTimeout(idleSetting);

  const cache = serverEntries.length > 0 ? loadMetadataCache() : null;
  const needsDiscovery = new Set<string>();
  // Servers in needsDiscovery only for their Executor app catalog: their cached listing is valid.
  const catalogDiscovery = new Set<string>();
  const failedDiscovery = new Set<string>();

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
      seedObservedOutputs(state, name, cachedEntry);
      // A cached Executor listing without its app catalog connects at startup so the catalog pass can
      // run; keep-alive and eager servers connect anyway.
      if (lifecycleMode !== "keep-alive" && lifecycleMode !== "eager" && !cachedEntry.executorApps
        && process.env.MCP_DIRECT_TOOLS !== "__none__" && isExecutorCatalogEntry(cachedEntry)) {
        needsDiscovery.add(name);
        catalogDiscovery.add(name);
      }
    } else if (cachedEntry?.discoveryFailed && cachedEntry.configHash === tryComputeServerHash(definition)) {
      // Startup tries a config once; a server that failed is tried again on first use.
      failedDiscovery.add(name);
    } else if (cachedEntry?.cacheScope !== "private") {
      needsDiscovery.add(name);
    }
  }

  const startupServers = serverEntries
    .filter(([name, definition]) => {
      const mode = definition.lifecycle ?? "lazy";
      return mode === "keep-alive" || mode === "eager" || needsDiscovery.has(name);
    })
    // Load-time runs have no model registry for auth.provider; session_start connects those servers.
    .filter(([, definition]) => !(options.excludeProjectServers && typeof definition.auth === "object"));

  if (ui && startupServers.length > 0) {
    const status = formatMcpStatus(state.config, `connecting to ${startupServers.length} servers...`);
    ui.setStatus("mcp", status);
  }

  const results = await parallelLimit(startupServers, 10, async ([name, definition]) => {
    const resident = (definition.lifecycle ?? "lazy") !== "lazy" || getEffectiveIdleTimeoutMinutes(state, name) === 0;
    try {
      const connection = await manager.connect(name, definition, runtimeSignal);
      if (connection.status === "needs-auth") {
        const error = typeof definition.auth === "object"
          ? providerSignInMessage(name, definition.auth.provider)
          : `OAuth authentication required. Run /mcp-auth ${name}.`;
        return { name, definition, resident, connection: null, error, transient: false };
      }
      // Capture before closing; the closed connection keeps its catalog for publication below.
      captureMetadata(state, name, connection, () => cache);
      // An Executor catalog pass keeps a non-resident connection open until the pass settles.
      const pass = refreshExecutorCatalog(state, name);
      if (!resident && pass) {
        const usedAt = connection.lastUsedAt;
        void pass.finally(() => {
          // A connection used meanwhile is left to the idle timeout.
          if (manager.getConnection(name) !== connection || connection.lastUsedAt !== usedAt || connection.inFlight > 0) return;
          return manager.close(name).catch(() => {});
        });
      } else if (!resident) {
        await manager.close(name);
      }
      return { name, definition, resident, connection, error: null, transient: false };
    } catch (error) {
      if (isAbortError(error, runtimeSignal)) {
        if (owner.signal.aborted) throw error;
        return { name, definition, resident, connection: null, error: null, transient: false };
      }
      const transient = isTransientHttpConnectError(error);
      const message = error instanceof Error ? error.message : String(error);
      return { name, definition, resident, connection: null, error: message, transient };
    }
  });

  if (initialSignal?.aborted) return state;
  owner.throwIfInactive();

  // One merged write for the whole pass; rewriting the file per server is slow with large catalogs.
  const captured = results.flatMap(({ name, definition, connection, error, transient }): [string, ServerCacheEntry][] => {
    if (connection) {
      const entry = state.sessionMetadata?.get(name);
      return entry ? [[name, entry]] : [];
    }
    // Mark a failed discovery so later sessions skip this config; transient outages stay unmarked.
    if (!error || transient || !needsDiscovery.has(name) || catalogDiscovery.has(name)) return [];
    const configHash = tryComputeServerHash(definition);
    return configHash ? [[name, { configHash, tools: [], resources: [], discoveryFailed: true, cachedAt: Date.now() }]] : [];
  });
  if (captured.length > 0) saveMetadataCache({ version: 1, servers: Object.fromEntries(captured) }, { startupSnapshot: cache?.servers ?? {} });

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
      // Its cached listing still serves; the server is tried again on first use, as before.
      if (catalogDiscovery.has(name)) {
        logger.debug(`MCP: startup connect for ${name}'s Executor app catalog failed: ${sanitizeTerminalText(error ?? "no connection")}`);
        continue;
      }
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
    toolMetadata.set(name, withExecutorAppMetadata(state, name, metadata));
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
    notifyToolMetadataUpdated(state, name, "startup");
    markKeepAliveAfterConnect(state, name);

    if (failedTools.length > 0 && ui) {
      ui.notify(
        `MCP: ${name} - ${failedTools.length} tools skipped`,
        "warning"
      );
    }
  }

  const residentResults = results.filter(r => r.resident);
  const connectedCount = residentResults.filter(r => r.connection).length;
  const failedCount = residentResults.filter(r => r.error).length;
  if (ui && connectedCount > 0 && config.settings?.notifyOnStartupConnect !== false) {
    const totalTools = totalToolCount(state);
    const msg = failedCount > 0
      ? `MCP: ${connectedCount}/${residentResults.length} servers connected (${totalTools} tools)`
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
        // Startup already attempted these servers, in this session or in an earlier one that failed.
        missingCacheServers.filter(name => !failedDiscovery.has(name) && !results.some(r => r.name === name)),
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
  if (!connection || connection.status !== "connected") {
    state.toolMetadata.delete(serverName);
    state.resourceCounts?.delete(serverName);
    state.directToolCounts?.delete(serverName);
    return;
  }

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
  state.toolMetadata.set(serverName, withExecutorAppMetadata(state, serverName, metadata));
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
): void {
  const connection = state.manager.getConnection(serverName);
  if (!connection || connection.status !== "connected") return;
  const entry = captureMetadata(state, serverName, connection, loadMetadataCache);
  if (entry) saveMetadataCache({ version: 1, servers: { [serverName]: entry } });
  const metadata = state.toolMetadata?.get(serverName);
  if (metadata) state.toolMetadata.set(serverName, withExecutorAppMetadata(state, serverName, metadata));
}

/** A connected server's tool metadata with this session's cached Executor app tools in place of any earlier ones. */
function withExecutorAppMetadata(state: McpExtensionState, serverName: string, metadata: ToolMetadata[]): ToolMetadata[] {
  const serverTools = ownTools(metadata);
  const entry = state.sessionMetadata?.get(serverName);
  const definition = state.config.mcpServers[serverName];
  if (!entry?.executorApps || !definition) return serverTools;
  const prefix = resolveToolPrefix(definition, state.config.settings?.toolPrefix ?? "server");
  const takenNames = new Set(serverTools.map((tool) => tool.name));
  // The cross-server selector index the cached path uses, so both keep the same app tools.
  const hasToolFilters = (Array.isArray(definition.includeTools) && definition.includeTools.length > 0)
    || (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0);
  const cache = hasToolFilters ? withSessionMetadata(loadMetadataCache(), state.config, state.sessionMetadata) : null;
  const selectorIndex = cache
    ? createCachedToolSelectorCandidateIndex(state.config.mcpServers, cache, state.config.settings?.toolPrefix ?? "server")
    : undefined;
  return [...serverTools, ...executorAppToolMetadata(serverName, entry, prefix, definition, selectorIndex, takenNames)];
}

/** Builds a server's cache entry from a connection's catalog and records it as this session's metadata. */
function captureMetadata(
  state: McpExtensionState,
  serverName: string,
  connection: ServerConnection,
  loadCache: () => MetadataCache | null,
): ServerCacheEntry | undefined {
  if (state.provisionalInstalls?.has(serverName)) return undefined;
  const definition = state.config.mcpServers[serverName];
  if (!definition || isServerDisabled(definition)) return undefined;

  const configHash = computeServerHash(definition);
  if (connection.definition && computeServerHash(connection.definition) !== configHash) return undefined;
  const existingEntry = loadCache()?.servers?.[serverName];

  const tools = serializeTools(connection.tools);
  let resources = definition.exposeResources === false ? [] : serializeResources(connection.resources);
  const sessionEntry = state.sessionMetadata?.get(serverName);
  const cacheScope = connection.toolListHints?.cacheScope;
  // Metadata from a private listing is tied to that authorization context; it may only fill an entry that is private too.
  const sessionFallback = sessionEntry?.configHash === configHash && (sessionEntry.cacheScope !== "private" || cacheScope === "private")
    ? sessionEntry
    : undefined;
  const prompts = connection.promptDiscoveryFailed
    ? sessionFallback
      ? sessionFallback.prompts
      : existingEntry?.configHash === configHash && isServerCacheValid(existingEntry, definition)
        ? existingEntry.prompts
        : undefined
    : serializePrompts(connection.prompts ?? []);

  if (definition.exposeResources !== false && connection.resourceDiscoveryFailed === true) {
    if (sessionFallback) {
      resources = sessionFallback.resources ?? [];
    } else if (existingEntry?.resources?.length && isServerCacheValid(existingEntry, definition)) {
      resources = existingEntry.resources;
    }
  }

  const outputShapes = keepOutputShapes(existingEntry, configHash, tools);
  // A reconnect keeps the Executor app catalog this session or a valid cache entry already has.
  const executorApps = sessionFallback?.executorApps
    ?? (existingEntry && isServerCacheValid(existingEntry, definition) ? existingEntry.executorApps : undefined);
  const entry: ServerCacheEntry = {
    configHash,
    tools,
    resources,
    ...(prompts !== undefined ? { prompts } : {}),
    ...(connection.instructions !== undefined ? { instructions: connection.instructions } : {}),
    ...(connection.toolListHints?.ttlMs !== undefined ? { ttlMs: connection.toolListHints.ttlMs } : {}),
    ...(cacheScope !== undefined ? { cacheScope } : {}),
    ...(outputShapes !== undefined ? { outputShapes } : {}),
    ...(executorApps !== undefined ? { executorApps } : {}),
    cachedAt: Date.now(),
  };

  (state.sessionMetadata ??= new Map()).set(serverName, entry);
  seedObservedOutputs(state, serverName, entry);
  return entry;
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

const executorCatalogPasses = new WeakMap<McpExtensionState, Map<string, Promise<void>>>();
// When each server's catalog was last paged again unasked, for a stale catalog or an unknown path.
const executorCatalogRepages = new WeakMap<McpExtensionState, Map<string, number>>();
const EXECUTOR_CATALOG_REPAGE_INTERVAL_MS = 60_000;
// Metadata update reasons where the user or Executor asked for the current catalog.
const FORCED_CATALOG_REASONS = new Set(["proxy-connect", "command-reconnect", "tools-list-changed"]);
/** The `refreshExecutorCatalog` reason for a call naming a path the cached catalog doesn't have. */
const EXECUTOR_UNKNOWN_PATH_REASON = "executor-unknown-path";

function setExecutorCatalogNotes(state: McpExtensionState, serverName: string, notes: string[]): void {
  if (notes.length > 0) (state.executorCatalogNotes ??= new Map()).set(serverName, notes);
  else state.executorCatalogNotes?.delete(serverName);
}

function takeRepageSlot(state: McpExtensionState, serverName: string): boolean {
  let repages = executorCatalogRepages.get(state);
  if (!repages) executorCatalogRepages.set(state, repages = new Map());
  const last = repages.get(serverName);
  if (last !== undefined && Date.now() - last < EXECUTOR_CATALOG_REPAGE_INTERVAL_MS) return false;
  repages.set(serverName, Date.now());
  return true;
}

/**
 * After a connect or another metadata update (`reason`), pages a connected Executor server's app
 * catalog into its cache entry in the background, inside the runtime owner, while the catalog it
 * replaces keeps serving. It pages when this session's entry has no catalog; when `reason` is an
 * explicit connect, reconnect or Executor's tools/list_changed; and, at most once per server a
 * minute, when the catalog is older than `EXECUTOR_CATALOG_TTL_MS` or the reason is
 * `EXECUTOR_UNKNOWN_PATH_REASON`. Does nothing for any other server. A private or zero-TTL
 * listing's catalog stays in this session. Returns the pass it started or the one already running,
 * or undefined. MCP_DIRECT_TOOLS=__none__ turns it off.
 */
export function refreshExecutorCatalog(state: McpExtensionState, serverName: string, reason?: string): Promise<void> | undefined {
  if (process.env.MCP_DIRECT_TOOLS === "__none__") return undefined;
  const connection = state.manager.getConnection(serverName);
  const definition = state.config.mcpServers[serverName];
  if (!definition || connection?.status !== "connected" || !isExecutorCatalogConnection(connection)) return undefined;
  const entry = state.sessionMetadata?.get(serverName);
  if (!entry) return undefined;
  let running = executorCatalogPasses.get(state);
  if (!running) executorCatalogPasses.set(state, running = new Map());
  const inFlight = running.get(serverName);
  if (inFlight) return inFlight;
  const cached = entry.executorApps;
  const forced = reason !== undefined && FORCED_CATALOG_REASONS.has(reason);
  const unasked = reason === EXECUTOR_UNKNOWN_PATH_REASON || (cached !== undefined && Date.now() - cached.fetchedAt >= EXECUTOR_CATALOG_TTL_MS);
  if (!forced && (unasked ? !takeRepageSlot(state, serverName) : cached !== undefined)) {
    if (cached) setExecutorCatalogNotes(state, serverName, unavailableAppNotes(serverName, cached.unavailableApps));
    return undefined;
  }
  const signal = state.owner.signal;
  const prefix = resolveToolPrefix(definition, state.config.settings?.toolPrefix ?? "server");
  const timeout = definition.requestTimeoutMs;
  const pass = (async () => {
    let landed = false;
    // Counts as a call in progress, so the idle check doesn't close the connection mid-pass.
    state.manager.incrementInFlight(serverName);
    try {
      const catalog = await fetchExecutorCatalog({
        client: connection.client,
        signal,
        ...(timeout !== undefined && Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
        isAppTool: tool => isExecutorAppToolAllowed(tool, serverName, prefix, definition),
      });
      if (signal.aborted) return;
      const current = state.sessionMetadata?.get(serverName);
      if (!current || current.configHash !== entry.configHash) return;
      if (current.cacheScope !== "private" && current.ttlMs !== 0) saveExecutorCatalog(serverName, current.configHash, catalog);
      state.sessionMetadata!.set(serverName, { ...current, executorApps: catalog });
      setExecutorCatalogNotes(state, serverName, unavailableAppNotes(serverName, catalog.unavailableApps));
      const metadata = state.toolMetadata.get(serverName);
      if (metadata) state.toolMetadata.set(serverName, withExecutorAppMetadata(state, serverName, metadata));
      landed = true;
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`MCP: Executor app catalog for ${serverName} is unavailable: ${sanitizeTerminalText(message)}`);
      setExecutorCatalogNotes(state, serverName, [`${serverName}: Executor app catalog unavailable — ${message}`.slice(0, MAX_FAILURE_MESSAGE_CHARS)]);
    } finally {
      running.delete(serverName);
      state.manager.decrementInFlight(serverName);
    }
    // Outside the try, so a failure to sync the tool surface is never reported as the catalog being unavailable.
    if (landed) notifyToolMetadataUpdated(state, serverName, "executor-catalog");
  })();
  running.set(serverName, pass);
  return pass;
}

/**
 * Pages an Executor server's catalog again for a call naming a path it may not have (at most once
 * a minute, see `refreshExecutorCatalog`), and waits for the pass until `signal` aborts. Other
 * calls can share the pass, so an abort ends only this wait, never the pass.
 */
export async function repageExecutorCatalog(state: McpExtensionState, serverName: string, signal?: AbortSignal): Promise<void> {
  const pass = refreshExecutorCatalog(state, serverName, EXECUTOR_UNKNOWN_PATH_REASON);
  if (pass) await abortable(pass, signal);
}

/**
 * Keeps the full signature Executor's `describe` gave for one app tool on this session's catalog,
 * and in the cache file when the catalog is cached there.
 */
export function cacheExecutorSignature(state: McpExtensionState, serverName: string, path: string, signature: string): void {
  const entry = state.sessionMetadata?.get(serverName);
  const catalog = entry?.executorApps;
  if (!entry || !catalog) return;
  const next = { ...catalog, tools: catalog.tools.map(tool => tool.path === path ? { ...tool, signature } : tool) };
  state.sessionMetadata!.set(serverName, { ...entry, executorApps: next });
  if (entry.cacheScope !== "private" && entry.ttlMs !== 0) saveExecutorSignature(serverName, entry.configHash, path, signature);
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
  const connectedCount = [...state.manager.getAllConnections()].filter(([name, connection]) => {
    const definition = state.config.mcpServers[name];
    return connection.status === "connected" && definition !== undefined && !isServerDisabled(definition);
  }).length;
  const formattedStatus = state.blockedProjectServers?.size
    ? formatMcpStatus(state.config, `${enabledCount} ${enabledCount === 1 ? "server" : "servers"} enabled (${state.blockedProjectServers.size} blocked by project trust)`)
    : formatMcpFooterStatus(state.config, enabledCount, disabledCount, connectedCount);
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
    await state.manager.ensureListen?.(serverName, connection);
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

/** The config hash, or undefined when the config can't be resolved yet (for example a missing env var in the URL). */
function tryComputeServerHash(definition: ServerEntry): string | undefined {
  try {
    return computeServerHash(definition);
  } catch {
    return undefined;
  }
}
