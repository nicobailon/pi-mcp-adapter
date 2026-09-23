import { withFileMutationQueue, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type DirectToolSpec, type McpAdapterOptions, type McpConfig, type PromptMetadata, type ServerEntry } from "./types.ts";
import type { McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { cloneMcpConfig, discoverConfiguredClaudePluginSkills, getPiGlobalConfigPath, getProjectConfigPath, loadMcpConfig, resolveConfiguredClaudePluginMcp, writeProjectServerDisabledOverride, writeSharedServerEntry } from "./config.ts";
import { buildProxyDescription, getLargeDirectToolsAdvisory, getMissingConfiguredDirectToolServers, prepareDirectToolArguments, resolveDirectTools } from "./direct-tool-surface.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";
import { computeServerHash, isServerCacheValid, loadMetadataCache, parseDirectToolSelectors, type MetadataCache } from "./metadata-cache.ts";
import { createPromptCommand, resolveCachedPrompts } from "./prompts.ts";
import { logger } from "./logger.ts";
import { formatMcpFooterStatus, formatTerminalError, getConfigPathFromArgv, normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";
import { createMcpDirectToolCallRenderer, createMcpProxyToolCallRenderer, createMcpScriptToolCallRenderer, createMcpToolResultRenderer, resolveMcpToolRenderOptions } from "./tool-result-renderer.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { createMcpRuntimeOwner, createOwnedUi, isAbortError, type McpRuntimeOwner } from "./runtime-owner.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";
import { syncNamespaceProxyTools } from "./namespace-tools.ts";
import { restoreSessionApprovalState } from "./session-approvals.ts";
import { createRetryableLoader } from "./lazy-loader.ts";

export type { McpAdapterOptions } from "./types.ts";
export type { ServerEntry } from "./types.ts";
export {
  namespaceProxyName,
  parseMcpReference,
  resolveMcpToolReferences,
  type McpReferenceResolution,
  type ParsedMcpReference,
} from "./mcp-references.ts";
export {
  MCP_STATUS_EVENT,
  MCP_STATUS_SNAPSHOT_VERSION,
  MCP_TOOL_APPROVAL_REQUEST_EVENT,
  type McpServerRuntimeStatus,
  type McpServerStatusSnapshot,
  type McpStatusSnapshot,
  type McpToolApprovalDecision,
  type McpToolApprovalHandler,
  type McpToolApprovalOrigin,
  type McpToolApprovalRequest,
} from "./types.ts";

const loadCoreRuntime = createRetryableLoader(() => import("./init.ts"));
const loadOAuthRuntime = createRetryableLoader(() => import("./mcp-auth-flow.ts"));
const loadProxyModes = createRetryableLoader(() => import("./proxy-modes.ts"));
const loadDirectExecution = createRetryableLoader(() => import("./direct-tools.ts"));
const loadCommands = createRetryableLoader(() => import("./commands.ts"));
const loadCodeMode = createRetryableLoader(() => import("./mcp-code.ts"));
const loadInstallParsing = createRetryableLoader(() => import("./mcp-install.ts"));

const INIT_WAIT_TIMEOUT_MS = 30_000;
const INIT_FAILURE_MESSAGE_MAX_CHARS = 1_000;
const INIT_WAIT_TIMED_OUT: unique symbol = Symbol("init-wait-timed-out");

function hasEnabledServerWithoutValidMetadata(
  config: McpConfig,
  cache: MetadataCache | null,
  directSpecs: readonly DirectToolSpec[] = [],
): boolean {
  return Object.entries(config.mcpServers).some(([serverName, definition]) => {
    if (isServerDisabled(definition) || directSpecs.some((spec) => spec.serverName === serverName)) return false;
    const entry = cache?.servers[serverName];
    return entry === undefined || !isServerCacheValid(entry, definition);
  });
}

export interface McpServerRegistration {
  dispose(): Promise<void>;
}

export const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1" as const;
export const MCP_RUNTIME_REGISTER_VERSION = 1 as const;

export const MCP_RUNTIME_SNAPSHOT_EVENT = "pi-mcp-adapter:runtime-snapshot:v1" as const;
export const MCP_RUNTIME_SNAPSHOT_VERSION = 1 as const;

export type McpRuntimeRegistrationResult =
  | { ok: true; registration: McpServerRegistration }
  | { ok: false; error: Error };

export interface McpRuntimeRegistrationRequest {
  version: typeof MCP_RUNTIME_REGISTER_VERSION;
  name: string;
  definition: ServerEntry;
  result?: McpRuntimeRegistrationResult;
}

export interface McpRuntimeServerSnapshot {
  readonly name: string;
  readonly definition: ServerEntry;
  readonly runtime: true;
  readonly persisted: false;
}

export type McpRuntimeSnapshotResult =
  | { ok: true; snapshot: McpRuntimeServerSnapshot }
  | { ok: false; error: Error };

export interface McpRuntimeSnapshotRequest {
  version: typeof MCP_RUNTIME_SNAPSHOT_VERSION;
  name: string;
  result?: McpRuntimeSnapshotResult;
}

// Fast path for callers that share the adapter's module and ExtensionAPI.
const runtimeRegistrars = new WeakMap<ExtensionAPI, (name: string, definition: ServerEntry) => McpServerRegistration>();
const runtimeSnapshotters = new WeakMap<ExtensionAPI, (name: string) => McpRuntimeServerSnapshot>();

function resolveProgrammaticClaudePluginPath(path: string, cwd: string): string {
  if (path === "~") return resolve(process.env.HOME ?? "", ".");
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? "", path.slice(2));
  return resolve(cwd, path);
}

function normalizeProgrammaticConfig(config: McpConfig): McpConfig {
  if (!config.claudePlugins) return config;
  const cwd = process.cwd();
  return {
    ...config,
    claudePlugins: config.claudePlugins.map(plugin => ({
      ...plugin,
      path: resolveProgrammaticClaudePluginPath(plugin.path, cwd),
    })),
  };
}

async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof INIT_WAIT_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof INIT_WAIT_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(INIT_WAIT_TIMED_OUT), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// TypeBox 1.x annotates raw objects passed to Type.Optional with an enumerable
// "~optional" key that survives serialization into provider tool schemas (Gemini
// rejects it with 400 INVALID_ARGUMENT). Prefer a real Type.Number schema; fall
// back to a plain raw schema for host TypeBox shims that omit Type.Number, since
// a property left out of `required` is optional by default.
function optionalNumber(options: { minimum?: number; description: string }): TSchema {
  const number = (Type as { Number?: (opts: typeof options) => TSchema }).Number;
  return typeof number === "function"
    ? Type.Optional(number(options))
    : ({ type: "number", ...options } as unknown as TSchema);
}

function parseEnvDirectToolOverride(raw: string | undefined): string[] | undefined {
  return raw?.split(",").map(s => s.trim()).filter(Boolean);
}

function resolveNamespaceEnvOverride(
  raw: string | undefined,
  selectors: string[] | undefined,
): ReturnType<typeof parseDirectToolSelectors> | null {
  if (raw === "__none__") return { servers: new Set<string>(), tools: new Map<string, Set<string>>() };
  return selectors ? parseDirectToolSelectors(selectors) : null;
}

function installMcpAdapter(pi: ExtensionAPI, options: McpAdapterOptions) {
  const sessionConfig = options.config !== undefined ? cloneMcpConfig(options.config) : undefined;
  const programmaticConfig = sessionConfig !== undefined;
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let initStartedPromise: Promise<void> | null = null;
  let currentOwner: McpRuntimeOwner | null = null;
  let currentOAuthRuntime: McpOAuthRuntime | null = null;
  let lifecycleGeneration = 0;
  let retainedInitFailure: string | null = null;
  let finalizationGuard: (() => void) | null = null;
  let finalizationRegistrations: Set<string> | null = null;

  function callReentrant<T>(callback: () => T): T {
    finalizationGuard?.();
    const result = callback();
    finalizationGuard?.();
    return result;
  }

  function retainInitFailure(error: unknown): string {
    const message = truncateAtWord(formatTerminalError(error), INIT_FAILURE_MESSAGE_MAX_CHARS);
    retainedInitFailure = message;
    return message;
  }

  function clearRetainedInitFailure(): void {
    retainedInitFailure = null;
  }

  function buildInitRetryInstruction(prefix: string, failure: string | null = retainedInitFailure): string {
    const retry = "Fix the MCP server configuration or startup failure, then call mcp(...) again to retry initialization.";
    return failure ? `${prefix}: ${failure}. ${retry}` : `${prefix}. ${retry}`;
  }

  function isOwnerAbortError(error: unknown, owner: McpRuntimeOwner): boolean {
    if (!owner.signal.aborted) return isAbortError(error);
    const reason = owner.signal.reason;
    if (reason instanceof Error && reason.message === "MCP initialization failed" && error !== reason) {
      return isAbortError(error);
    }
    return true;
  }

  interface RuntimeGuard {
    generation: number;
    owner: McpRuntimeOwner | null;
    state: McpExtensionState | null;
  }

  function captureRuntimeGuard(expectedState: McpExtensionState | null = state): RuntimeGuard {
    return { generation: lifecycleGeneration, owner: currentOwner, state: expectedState };
  }

  function assertRuntimeGuard(guard: RuntimeGuard): void {
    guard.owner?.throwIfInactive();
    if (
      lifecycleGeneration !== guard.generation
      || currentOwner !== guard.owner
      || state !== guard.state
    ) {
      throw guard.owner?.signal.reason ?? new Error("MCP operation belongs to a stale session");
    }
  }

  function isRuntimeGuardStale(guard: RuntimeGuard): boolean {
    return guard.owner?.isActive() === false
      || lifecycleGeneration !== guard.generation
      || currentOwner !== guard.owner
      || state !== guard.state;
  }

  async function loadForRuntime<T>(loader: () => Promise<T>, guard: RuntimeGuard): Promise<T> {
    const loaded = await loader();
    assertRuntimeGuard(guard);
    return loaded;
  }

  function createCommandContext(ctx: ExtensionContext, owner: McpRuntimeOwner | null): ExtensionContext {
    const commandCtx = Object.create(ctx) as ExtensionContext;
    const hasUI = ctx.hasUI;
    Object.defineProperties(commandCtx, {
      hasUI: { value: hasUI, enumerable: true },
      ui: {
        value: hasUI ? owner ? createOwnedUi(ctx.ui, owner) : ctx.ui : undefined,
        enumerable: true,
      },
      signal: { value: owner?.signal ?? ctx.signal, enumerable: true },
    });
    return commandCtx;
  }

  function startGatewayRetryInitialization(ctx: ExtensionContext): void {
    const generation = ++lifecycleGeneration;
    const owner = createMcpRuntimeOwner();
    currentOwner = owner;
    currentOAuthRuntime = null;
    state = null;
    startInitialization(ctx, owner, generation, "stale_gateway_retry_initialization");
  }

  async function shutdownState(currentState: McpExtensionState | null, reason: string, publishStatus = true): Promise<void> {
    if (!currentState) {
      if (publishStatus) publishMcpStatusShutdown(pi.events);
      return;
    }

    if (publishStatus) publishMcpStatusShutdown(currentState.statusEvents);

    if (currentState.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    try {
      const { flushMetadataCache } = await loadCoreRuntime();
      flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      if (currentState.owner) {
        await currentState.owner.stop(reason);
      } else {
        await currentState.lifecycle.gracefulShutdown();
      }
    } catch (error) {
      if (flushError) {
        console.error(`MCP: graceful shutdown failed after metadata flush error: ${formatTerminalError(error)}`);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  function restoreCurrentSessionApprovals(targetState: McpExtensionState): void {
    const sessionManager = targetState.sessionManager;
    if (!sessionManager) return;

    let branch: readonly unknown[] = [];
    try {
      branch = sessionManager.getBranch();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.debug(`MCP: could not read the active session branch for approval restore: ${detail}`);
    }
    restoreSessionApprovalState(targetState, branch);
  }

  const earlyConfigPath = programmaticConfig
    ? undefined
    : options.configPath ?? getConfigPathFromArgv();
  const earlyConfig = programmaticConfig
    ? resolveConfiguredClaudePluginMcp(cloneMcpConfig(sessionConfig), process.cwd())
    : loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const envDirectToolOverride = parseEnvDirectToolOverride(envRaw);
  const namespaceEnvOverride = resolveNamespaceEnvOverride(envRaw, envDirectToolOverride);
  const hasStartupServer = Object.values(earlyConfig.mcpServers).some((definition) =>
    !isServerDisabled(definition) && (definition.lifecycle === "eager" || definition.lifecycle === "keep-alive"));
  const registeredDirectTools = new Map<string, string>();
  const registeredDirectToolServers = new Map<string, string>();
  const registeredDirectToolVersions = new Map<string, number>();
  // Overlapping connect results consume each server's discovery names once.
  // Removal clears the record so stale/fallback reactivation is reportable.
  const reportedDirectToolNamesByServer = new Map<string, Set<string>>();
  const registeredNamespaceProxyTools = new Set<string>();
  const fallbackDeactivatedTools = new Set<string>();
  // directTools: "search" — registered inactive, activated by mcp({ search }).
  const lazyDirectTools = new Set<string>();
  const searchActivatedTools = new Set<string>();
  const toolRenderOptions = resolveMcpToolRenderOptions(earlyConfig.settings);
  const toolRenderShell = toolRenderOptions.resultRendering === "compact" ? "self" : "default";
  const renderMcpToolResult = createMcpToolResultRenderer(toolRenderOptions);
  let proxyToolRegistered = false;
  let proxyToolDescription: string | null = null;
  let directToolsFrozen = false;
  let largeDirectToolsAdvisoryDelivered = false;
  // Session/runtime scoped server registrations from other extensions. They
  // survive session restarts within this install and die with the process.
  const runtimeServers = new Map<string, { definition: ServerEntry; entry: ServerEntry }>();

  // Mirrors init's per-server lifecycle registration so runtime servers get
  // idle cleanup and keep-alive health recovery like configured servers.
  function attachRuntimeServerLifecycle(targetState: McpExtensionState, name: string, definition: ServerEntry): void {
    const lifecycleMode = definition.lifecycle ?? "lazy";
    const persistsAfterFirstSpawn = lifecycleMode === "eager" || lifecycleMode === "lazy-keep-alive";
    const idleOverride = definition.idleTimeout ?? (persistsAfterFirstSpawn ? 0 : undefined);
    targetState.lifecycle.registerServer(name, definition, idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined);
    if (lifecycleMode === "keep-alive") targetState.lifecycle.markKeepAlive(name, definition);
  }

  // OMP remaps `typebox` to a host shim that historically lacked Type.Unsafe.
  // Prefer Unsafe when present (real TypeBox / fixed OMP shim); otherwise pass
  // the normalized JSON Schema through as a plain object so toolWireSchema and
  // validateToolArguments still treat it as JSON Schema.
  const toToolParameters = (schema: Record<string, unknown>) =>
    typeof (Type as { Unsafe?: (value: never) => unknown }).Unsafe === "function"
      ? (Type as { Unsafe: (value: never) => unknown }).Unsafe(schema as never)
      : schema;

  function directToolFingerprint(spec: DirectToolSpec): string {
    return JSON.stringify({
      serverName: spec.serverName,
      originalName: spec.originalName,
      prefixedName: spec.prefixedName,
      description: spec.description,
      inputSchema: spec.inputSchema,
      resourceUri: spec.resourceUri,
      uiResourceUri: spec.uiResourceUri,
      uiStreamMode: spec.uiStreamMode,
      // A mode-only change (search ↔ eager) must re-register, or the tool
      // keeps the activation behavior of the mode it was registered under.
      lazy: spec.lazy === true,
    });
  }

  function forgetReportedDirectToolName(serverName: string | undefined, toolName: string): void {
    if (!serverName) return;
    const reportedNames = reportedDirectToolNamesByServer.get(serverName);
    if (!reportedNames) return;
    reportedNames.delete(toolName);
    if (reportedNames.size === 0) reportedDirectToolNamesByServer.delete(serverName);
  }

  function registerDirectTool(spec: DirectToolSpec, config: McpConfig): void {
    finalizationRegistrations?.add(spec.prefixedName);
    callReentrant(() => (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: toToolParameters(normalizeDirectToolInputSchema(spec.inputSchema)),
      ...(config.settings?.strictDirectToolArguments === true
        ? { prepareArguments: (args: unknown) => prepareDirectToolArguments(spec.inputSchema, args) }
        : {}),
      async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, ctx: ExtensionContext) {
        let executor: ReturnType<(typeof import("./direct-tools.ts"))["createDirectToolExecutor"]>;
        let guard: RuntimeGuard | undefined;
        try {
          const targetState = await ensureSessionRuntime(ctx);
          if (!targetState) throw new Error("MCP not initialized");
          guard = captureRuntimeGuard(targetState);
          const executionGuard = guard;
          const { createDirectToolExecutor } = await loadForRuntime(loadDirectExecution, executionGuard);
          executor = createDirectToolExecutor(() => executionGuard.state, () => initPromise, spec);
        } catch (error) {
          if (guard && (isRuntimeGuardStale(guard) || (guard.owner && isOwnerAbortError(error, guard.owner)))) throw error;
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed for ${spec.serverName}: ${message}` }],
            details: { error: "init_failed", server: spec.serverName, message },
          };
        }
        if (!guard) throw new Error("MCP runtime guard unavailable");
        assertRuntimeGuard(guard);
        return executor(toolCallId, params, signal, onUpdate, ctx);
      },
      renderShell: toolRenderShell,
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName, toolRenderOptions),
      renderResult: renderMcpToolResult,
    }));
  }

  // Pi registers a tool active. A lazy tool must not stay that way: hold every
  // lazy tool that search has not activated out of the active set. Safe to call
  // repeatedly; a no-op until Pi's action methods are available.
  function holdLazyToolsInactive(): void {
    if (lazyDirectTools.size === 0) return;
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return;
    const next = activeTools.filter((name) => !lazyDirectTools.has(name) || searchActivatedTools.has(name));
    if (next.length !== activeTools.length) pi.setActiveTools(next);
  }

  /**
   * Activate the lazy direct tools a search matched, additively. This is the
   * one place a search-mode tool becomes active; nothing is ever deactivated
   * here. Returns the names that actually changed state so the result can
   * report only real additions.
   */
  function activateSearchMatches(matches: ReadonlyArray<{ server: string; tool: string }>): string[] {
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return [];
    const activeSet = new Set(activeTools);
    // executeSearch reports ToolMetadata.name, which is the prefixed name a
    // direct tool is registered under — the same key the lazy set holds.
    const added: string[] = [];
    for (const match of matches) {
      const name = match.tool;
      if (!lazyDirectTools.has(name) || registeredDirectToolServers.get(name) !== match.server) continue;
      if (activeSet.has(name) || added.includes(name)) continue;
      added.push(name);
    }
    if (added.length > 0) {
      pi.setActiveTools([...activeTools, ...added]);
      for (const name of added) searchActivatedTools.add(name);
    }
    return added;
  }

  function activeFailureServers(): Set<string> {
    const currentState = state;
    if (!currentState) return new Set();
    return new Set(Object.keys(currentState.config.mcpServers).filter((serverName) => isServerInActiveFailureBackoff(currentState, serverName)));
  }

  function resolveCurrentDirectTools(config: McpConfig, cache: MetadataCache | null, reservedNames?: Set<string>): DirectToolSpec[] {
    if (envRaw === "__none__") return [];
    const prefix = config.settings?.toolPrefix ?? "server";
    return resolveDirectTools(config, cache, prefix, envDirectToolOverride, activeFailureServers(), reservedNames);
  }

  function getActiveToolsIfReady(): string[] | undefined {
    try {
      return callReentrant(() => pi.getActiveTools?.());
    } catch (error) {
      if (error instanceof Error
        && error.message.includes("Action methods cannot be called during extension loading")) return undefined;
      throw error;
    }
  }

  function deactivateTools(toolNames: string[]): string[] {
    if (toolNames.length === 0) return [];
    const unregisterTool = (pi as ExtensionAPI & { unregisterTool?: (name: string) => boolean }).unregisterTool;
    const unregistered = toolNames.filter((toolName) => callReentrant(() => unregisterTool?.(toolName)) === true);
    const fallbackNames = toolNames.filter((toolName) => !unregistered.includes(toolName));
    const remove = new Set(toolNames);
    const activeTools = getActiveToolsIfReady();
    if (!activeTools || activeTools.length === 0) {
      for (const toolName of fallbackNames) fallbackDeactivatedTools.add(toolName);
      return unregistered;
    }
    const nextActiveTools = activeTools.filter((name) => !remove.has(name));
    if (nextActiveTools.length !== activeTools.length) {
      for (const toolName of fallbackNames) fallbackDeactivatedTools.add(toolName);
      callReentrant(() => pi.setActiveTools(nextActiveTools));
    }
    return unregistered;
  }

  function syncDirectTools(config: McpConfig, cache: MetadataCache | null): {
    specs: DirectToolSpec[];
    reservedDirectNames: Set<string>;
    activeDirectNames: Set<string>;
    added: string[];
    updated: string[];
    deactivated: string[];
  } {
    const reservedDirectNames = new Set<string>();
    const specs = resolveCurrentDirectTools(config, cache, reservedDirectNames);
    const nextNames = new Set(specs.map((spec) => spec.prefixedName));
    const added: string[] = [];
    const updated: string[] = [];
    const deactivated: string[] = [];

    for (const spec of specs) {
      const fingerprint = directToolFingerprint(spec);
      const previous = registeredDirectTools.get(spec.prefixedName);
      if (previous !== fingerprint) {
        const previousServer = registeredDirectToolServers.get(spec.prefixedName);
        registerDirectTool(spec, config);
        finalizationGuard?.();
        registeredDirectTools.set(spec.prefixedName, fingerprint);
        registeredDirectToolServers.set(spec.prefixedName, spec.serverName);
        registeredDirectToolVersions.set(spec.prefixedName, (registeredDirectToolVersions.get(spec.prefixedName) ?? 0) + 1);
        if (previousServer !== spec.serverName) {
          forgetReportedDirectToolName(previousServer, spec.prefixedName);
        }
        if (fallbackDeactivatedTools.delete(spec.prefixedName) && !spec.lazy) {
          const activeTools = getActiveToolsIfReady();
          if (activeTools && !activeTools.includes(spec.prefixedName)) {
            callReentrant(() => pi.setActiveTools([...activeTools, spec.prefixedName]));
          }
        }
        (previous ? updated : added).push(spec.prefixedName);
      }
      if (spec.lazy) {
        // Search mode, whether first registered or flipped from eager (e.g. in
        // the panel): held inactive below unless a search already activated it.
        lazyDirectTools.add(spec.prefixedName);
      } else if (lazyDirectTools.delete(spec.prefixedName)) {
        // Search → eager: an eager direct tool is active by definition, so a
        // tool that search never activated must be activated now. Pi does not
        // re-activate a tool it already knows on re-registration.
        searchActivatedTools.delete(spec.prefixedName);
        const activeTools = getActiveToolsIfReady();
        if (activeTools && !activeTools.includes(spec.prefixedName)) callReentrant(() => pi.setActiveTools([...activeTools, spec.prefixedName]));
      }
    }

    for (const toolName of [...registeredDirectTools.keys()]) {
      if (nextNames.has(toolName)) continue;
      const serverName = registeredDirectToolServers.get(toolName);
      registeredDirectTools.delete(toolName);
      registeredDirectToolServers.delete(toolName);
      forgetReportedDirectToolName(serverName, toolName);
      if (lazyDirectTools.delete(toolName)) searchActivatedTools.delete(toolName);
      deactivated.push(toolName);
    }

    deactivateTools(deactivated);
    holdLazyToolsInactive();
    return { specs, reservedDirectNames, activeDirectNames: nextNames, added, updated, deactivated };
  }

  function applyDirectToolConfigChanges(changes: Map<string, true | string[] | false | "search">): void {
    if (!state) return;
    for (const [serverName, value] of changes) {
      const definition = state.config.mcpServers[serverName];
      if (!definition) continue;
      state.config.mcpServers[serverName] = { ...definition, directTools: value };
    }
  }

  function loadToolSurfaceCache(config: McpConfig): MetadataCache | null {
    const cache = loadMetadataCache();
    const currentState = state;
    if (!currentState || !cache) return cache;
    const servers = { ...cache.servers };
    const connections = callReentrant(() => [...currentState.manager.getAllConnections()]);
    for (const [serverName, connection] of connections) {
      const definition = config.mcpServers[serverName];
      const entry = servers[serverName];
      if (connection.status !== "connected" || !entry || !definition || isServerDisabled(definition)) continue;
      const configHash = computeServerHash(definition);
      if (computeServerHash(connection.definition) !== configHash || entry.configHash !== configHash) continue;
      const { ttlMs: _liveTtl, ...liveEntry } = entry;
      servers[serverName] = liveEntry;
    }
    return { ...cache, servers };
  }

  function syncToolSurface(ctx?: ExtensionContext): void {
    const notificationGeneration = lifecycleGeneration;
    const notificationOwner = currentOwner;
    const config = state?.config ?? earlyConfig;
    const cache = loadToolSurfaceCache(config);
    const result = syncDirectTools(config, cache);
    if (state) {
      const directToolCounts = state.directToolCounts ?? new Map<string, number>();
      directToolCounts.clear();
      for (const spec of result.specs) {
        directToolCounts.set(spec.serverName, (directToolCounts.get(spec.serverName) ?? 0) + 1);
      }
      state.directToolCounts = directToolCounts;
    }
    syncProxyTool(config, cache, result.specs);
    syncNamespaceTools(config, cache, result.reservedDirectNames, result.activeDirectNames);
    deliverLargeDirectToolsAdvisory(ctx, config, result.specs);
    if (ctx && (notificationGeneration !== lifecycleGeneration
      || notificationOwner !== currentOwner
      || (notificationOwner && !notificationOwner.isActive()))) {
      throw notificationOwner?.signal.reason ?? new Error("Stale MCP session after direct-tools advisory");
    }
    finalizationGuard?.();
    const changed = result.added.length + result.updated.length + result.deactivated.length;
    if (changed > 0 && ctx?.hasUI) {
      callReentrant(() => ctx.ui.notify(
        `MCP: direct tools refreshed (+${result.added.length}, ~${result.updated.length}, -${result.deactivated.length})`,
        "info",
      ));
    }
  }

  function deliverLargeDirectToolsAdvisory(
    ctx: ExtensionContext | undefined,
    config: McpConfig,
    specs: readonly DirectToolSpec[],
  ): void {
    if (!ctx || largeDirectToolsAdvisoryDelivered) return;
    const message = getLargeDirectToolsAdvisory(config, specs);
    if (!message) return;
    largeDirectToolsAdvisoryDelivered = true;
    if (ctx.hasUI) {
      callReentrant(() => ctx.ui.notify(message, "warning"));
    } else {
      console.warn(message);
    }
  }

  function getDeferredSessionSnapshot(cwd: string | undefined): {
    config: McpConfig;
    cache: MetadataCache | null;
    enabledServerCount: number;
  } | undefined {
    const config = programmaticConfig
      ? resolveConfiguredClaudePluginMcp(cloneMcpConfig(sessionConfig), cwd ?? process.cwd())
      : loadMcpConfig(earlyConfigPath, cwd);
    const cache = loadMetadataCache();
    const enabledServers = Object.values(config.mcpServers).filter((definition) => !isServerDisabled(definition));
    if (enabledServers.some((definition) => definition.lifecycle === "eager" || definition.lifecycle === "keep-alive")) return undefined;
    if (envRaw !== undefined && envRaw !== "__none__"
      && getMissingConfiguredDirectToolServers(config, cache, envDirectToolOverride).length > 0) return undefined;
    if (config.settings?.deferWithMissingMetadata !== true
      && (cache === null || hasEnabledServerWithoutValidMetadata(config, cache))) return undefined;
    return { config, cache, enabledServerCount: enabledServers.length };
  }

  function syncNamespaceTools(
    config: McpConfig,
    cache: MetadataCache | null,
    reservedDirectNames: Set<string> = new Set(registeredDirectTools.keys()),
    activeDirectNames: Set<string> = new Set(registeredDirectTools.keys()),
  ): void {
    const result = syncNamespaceProxyTools({
      config,
      cache,
      envOverride: namespaceEnvOverride,
      existingDirectNames: reservedDirectNames,
      activeDirectNames,
      existingNamespaceNames: registeredNamespaceProxyTools,
      unavailableServers: activeFailureServers(),
      pi,
      getState: () => state,
      getInitPromise: () => initPromise,
      ensureRuntime: (ctx) => ensureSessionRuntime(ctx as ExtensionContext),
      executeCall: async (...args) => {
        const guard = captureRuntimeGuard(args[0]);
        return (await loadForRuntime(loadProxyModes, guard)).executeCall(...args);
      },
      getPiTools: () => pi.getAllTools(),
      renderOptions: toolRenderOptions,
      renderShell: toolRenderShell,
      renderResult: renderMcpToolResult,
      guardReentrant: () => finalizationGuard?.(),
      onToolRegistered: (name) => finalizationRegistrations?.add(name),
    });
    finalizationGuard?.();
    for (const name of result.added) registeredNamespaceProxyTools.add(name);
    for (const name of result.deactivated) registeredNamespaceProxyTools.delete(name);
  }

  const registeredPromptCommands = new Set<string>();

  function registerPromptCommands(specs: Iterable<PromptMetadata>): void {
    for (const spec of specs) {
      if (registeredPromptCommands.has(spec.commandName)) {
        logger.debug(`MCP: prompt "${spec.originalName}" on ${spec.serverName} skipped; /${spec.commandName} is already registered`);
        continue;
      }
      callReentrant(() => pi.registerCommand(spec.commandName, createPromptCommand(pi, () => state, spec, {
        ensureState: (ctx) => ensureSessionRuntime(ctx as unknown as ExtensionContext),
        lazyConnect: async (...args) => {
          const guard = captureRuntimeGuard(args[0]);
          return (await loadForRuntime(loadCoreRuntime, guard)).lazyConnect(...args);
        },
        isStateCurrent: (targetState) => state === targetState && currentOwner?.isActive() === true,
      })));
      registeredPromptCommands.add(spec.commandName);
    }
  }

  function syncPromptCommands(): void {
    registerPromptCommands([...(state?.promptMetadata?.entries() ?? [])]
      .filter(([name]) => !state?.provisionalInstalls?.has(name))
      .flatMap(([, prompts]) => prompts));
  }

  const registerRuntimeServer = (name: string, definition: ServerEntry): McpServerRegistration => {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("MCP server name must be a non-empty string");
    }
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
      throw new Error(`MCP server definition for "${name}" must be an object`);
    }
    const effective = state?.config ?? earlyConfig;
    if (runtimeServers.has(name) || Object.hasOwn(effective.mcpServers, name)) {
      throw new Error(`MCP server "${name}" is already registered`);
    }
    // Runtime-registered servers are proxy-tool-only: direct tools are frozen
    // at startup and must not be rebuilt for late registrations.
    const snapshotDefinition = structuredClone(definition);
    const entry: ServerEntry = { ...structuredClone(snapshotDefinition), directTools: false };
    runtimeServers.set(name, { definition: snapshotDefinition, entry });
    const registeredState = state;
    if (registeredState) {
      registeredState.config.mcpServers[name] = entry;
      attachRuntimeServerLifecycle(registeredState, name, entry);
      syncToolSurface();
      const guard = captureRuntimeGuard(registeredState);
      void loadForRuntime(loadCoreRuntime, guard)
        .then(({ updateStatusBar }) => updateStatusBar(registeredState))
        .catch((error) => {
          if (!isAbortError(error, guard.owner?.signal)) {
            logger.debug(`MCP: could not update status after runtime registration: ${formatTerminalError(error)}`);
          }
        });
    }
    let disposed = false;
    return {
      dispose: async (): Promise<void> => {
        if (disposed) return;
        disposed = true;
        runtimeServers.delete(name);
        const currentState = state;
        if (!currentState || currentState.config.mcpServers[name] !== entry) return;
        delete currentState.config.mcpServers[name];
        currentState.lifecycle.unregisterServer(name);
        const guard = captureRuntimeGuard(currentState);
        await currentState.manager.close(name);
        assertRuntimeGuard(guard);
        syncToolSurface();
        (await loadForRuntime(loadCoreRuntime, guard)).updateStatusBar(currentState);
      },
    };
  };
  const getRuntimeServerSnapshot = (name: string): McpRuntimeServerSnapshot => {
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("MCP runtime server name must be a non-empty string");
    }
    const runtimeServer = runtimeServers.get(name);
    if (!runtimeServer) {
      throw new Error(`MCP runtime server "${name}" is not registered or has been disposed`);
    }
    const activeState = state;
    if (!activeState) {
      throw new Error(`MCP runtime server "${name}" is unavailable because the adapter has no active state`);
    }
    const activeEntry = activeState.config.mcpServers[name];
    if (Object.hasOwn(activeState.config.mcpServers, name) && activeEntry !== runtimeServer.entry) {
      throw new Error(`MCP runtime server "${name}" is shadowed by a configured server`);
    }
    if (activeEntry !== runtimeServer.entry) {
      throw new Error(`MCP runtime server "${name}" is unavailable in the active adapter state`);
    }
    return {
      name,
      definition: structuredClone(runtimeServer.definition),
      runtime: true,
      persisted: false,
    };
  };
  runtimeRegistrars.set(pi, registerRuntimeServer);
  runtimeSnapshotters.set(pi, getRuntimeServerSnapshot);
  pi.events.on(MCP_RUNTIME_REGISTER_EVENT, (rawRequest: unknown) => {
    if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) return;
    const request = rawRequest as McpRuntimeRegistrationRequest;
    if (request.result !== undefined) return;
    if (request.version !== MCP_RUNTIME_REGISTER_VERSION) {
      request.result = { ok: false, error: new Error(`Unsupported MCP runtime registration version: ${String(request.version)}`) };
      return;
    }
    try {
      request.result = { ok: true, registration: registerRuntimeServer(request.name, request.definition) };
    } catch (error) {
      request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  });
  pi.events.on(MCP_RUNTIME_SNAPSHOT_EVENT, (rawRequest: unknown) => {
    if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) return;
    const request = rawRequest as McpRuntimeSnapshotRequest;
    if (request.result !== undefined) return;
    if (request.version !== MCP_RUNTIME_SNAPSHOT_VERSION) {
      request.result = { ok: false, error: new Error(`Unsupported MCP runtime snapshot version: ${String(request.version)}`) };
      return;
    }
    try {
      request.result = { ok: true, snapshot: getRuntimeServerSnapshot(request.name) };
    } catch (error) {
      request.result = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  });

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  function startInitialization(ctx: ExtensionContext, owner: McpRuntimeOwner, generation: number, staleReason: string): Promise<void> {
    let oauthRuntime: McpOAuthRuntime | null = null;
    let markStarted!: () => void;
    initStartedPromise = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let coreRuntime: Awaited<ReturnType<typeof loadCoreRuntime>> | null = null;
    const initializationPromise = (async () => {
      const guard = captureRuntimeGuard(null);
      const [core, oauth] = await Promise.all([
        loadCoreRuntime(),
        loadOAuthRuntime(),
      ]);
      assertRuntimeGuard(guard);
      if (generation !== guard.generation || guard.owner !== owner) {
        throw owner.signal.reason ?? new Error("Stale MCP initialization");
      }
      coreRuntime = core;
      assertRuntimeGuard(guard);
      oauthRuntime = oauth.createOAuthRuntime(owner.signal);
      try {
        assertRuntimeGuard(guard);
      } catch (error) {
        await oauth.shutdownOAuth(oauthRuntime);
        throw error;
      }
      currentOAuthRuntime = oauthRuntime;
      assertRuntimeGuard(guard);
      owner.addCleanup(async () => {
        const { cleanupMaterializedBinaryResources } = await import("./tool-registrar.ts");
        cleanupMaterializedBinaryResources(owner.signal);
      });
      assertRuntimeGuard(guard);
      const initialization = core.initializeMcp(pi, ctx, owner, {
        ...(programmaticConfig || options.configPath !== undefined
          ? {
              ...(earlyConfigPath !== undefined ? { configPath: earlyConfigPath } : {}),
              ...(sessionConfig !== undefined ? { config: sessionConfig } : {}),
            }
          : {}),
        oauthRuntime,
      });
      assertRuntimeGuard(guard);
      markStarted();
      return initialization;
    })().catch((error) => {
      markStarted();
      throw error;
    }).then((value) => value);
    let promise: Promise<McpExtensionState>;
    promise = initializationPromise.then(async (nextState) => {
      if (!owner.isActive() || generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, staleReason, false);
        } catch (error) {
          console.error(`MCP: failed to clean stale initialization state: ${formatTerminalError(error)}`);
        }
        throw owner.signal.reason ?? new Error("Stale MCP initialization completed");
      }

      const guard = () => {
        owner.throwIfInactive();
        if (generation !== lifecycleGeneration || currentOwner !== owner || state !== nextState || initPromise !== promise) {
          throw owner.signal.reason ?? new Error("Stale MCP initialization finalized");
        }
      };
      const registeredDuringFinalization = new Set<string>();
      let statusPublicationAttempted = false;
      state = nextState;
      finalizationGuard = guard;
      finalizationRegistrations = registeredDuringFinalization;
      try {
        guard();
        // Re-read after asynchronous startup so navigation during initialization
        // cannot restore a stale branch.
        callReentrant(() => restoreCurrentSessionApprovals(nextState));
        for (const [name, { entry }] of runtimeServers) {
          guard();
          if (Object.hasOwn(nextState.config.mcpServers, name)) {
            console.error(`MCP: runtime-registered server "${name}" now collides with a configured server; keeping the configured server`);
            continue;
          }
          nextState.config.mcpServers[name] = entry;
          guard();
          callReentrant(() => attachRuntimeServerLifecycle(nextState, name, entry));
        }
        guard();
        nextState.onToolMetadataUpdated = (_serverName, _reason) => {
          if (state !== nextState || !owner.isActive()) return;
          syncPromptCommands();
          if (directToolsFrozen) {
            logger.debug(`MCP: metadata update for ${_serverName} (${_reason}) skipped — directTools frozen`);
            return;
          }
          syncToolSurface(ctx);
        };
        guard();
        syncPromptCommands();
        guard();
        syncToolSurface(ctx);
        guard();
        // A connected snapshot is readiness-like external state. Publish it only
        // after Pi's model-facing direct-tool surface reflects live metadata.
        nextState.statusEvents = pi.events;
        guard();
        if (!coreRuntime) throw new Error("MCP core runtime was not loaded");
        const loadedCoreRuntime = coreRuntime;
        statusPublicationAttempted = true;
        callReentrant(() => loadedCoreRuntime.updateStatusBar(nextState));
        guard();
        clearRetainedInitFailure();
        guard();
        if (earlyConfig.settings?.freezeDirectTools === true) {
          directToolsFrozen = true;
          logger.info("MCP: direct tools frozen after initial sync — metadata can refresh without rebuilding the active tool surface");
        }
        guard();
        initPromise = null;
        initStartedPromise = null;
        return nextState;
      } catch (error) {
        if (state === nextState) state = null;
        finalizationGuard = null;
        finalizationRegistrations = null;
        if (registeredDuringFinalization.size > 0) {
          deactivateTools([...registeredDuringFinalization]);
          for (const name of registeredDuringFinalization) {
            registeredDirectTools.delete(name);
            registeredDirectToolServers.delete(name);
            registeredDirectToolVersions.delete(name);
            registeredNamespaceProxyTools.delete(name);
          }
          if (registeredDuringFinalization.has("mcp")) {
            proxyToolRegistered = false;
            proxyToolDescription = null;
          }
        }
        if (statusPublicationAttempted && generation === lifecycleGeneration && currentOwner === owner) {
          publishMcpStatusShutdown(nextState.statusEvents);
        }
        // A synchronous lifecycle replacement captures published state and owns
        // its cleanup. Only clean here when no replacement took ownership.
        if (generation === lifecycleGeneration && currentOwner === owner) {
          try {
            await shutdownState(nextState, staleReason, false);
          } catch (cleanupError) {
            console.error(`MCP: failed to clean interrupted initialization state: ${formatTerminalError(cleanupError)}`);
          }
        }
        throw error;
      } finally {
        if (finalizationGuard === guard) finalizationGuard = null;
        if (finalizationRegistrations === registeredDuringFinalization) finalizationRegistrations = null;
      }
    });
    initPromise = promise;

    return promise.then(() => undefined).catch(async err => {
      if (!owner.isActive() || generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise) return;
      const message = retainInitFailure(err);
      console.error(`MCP initialization failed: ${message}`);
      initPromise = null;
      initStartedPromise = null;
      if (state) return;

      try {
        await Promise.all([
          owner.stop("MCP initialization failed"),
          oauthRuntime ? loadOAuthRuntime().then(({ shutdownOAuth }) => shutdownOAuth(oauthRuntime!)) : Promise.resolve(),
        ]);
      } catch (error) {
        console.error(`MCP: failed to clean rejected initialization: ${formatTerminalError(error)}`);
      }
    });
  }

  function ensureSessionRuntime(ctx: ExtensionContext): Promise<McpExtensionState | null> {
    if (state) return Promise.resolve(state);
    if (initPromise) return initPromise;
    const owner = currentOwner?.isActive() ? currentOwner : createMcpRuntimeOwner();
    if (owner !== currentOwner) currentOwner = owner;
    const generation = currentOwner === owner && lifecycleGeneration > 0
      ? lifecycleGeneration
      : ++lifecycleGeneration;
    startInitialization(ctx, owner, generation, "stale_first_operation_initialization");
    return initPromise!;
  }

  function startLoadTimeInitialization(): void {
    if (!hasStartupServer) return;
    setImmediate(() => {
      if (lifecycleGeneration !== 0 || state || initPromise) return;
      const generation = ++lifecycleGeneration;
      const owner = createMcpRuntimeOwner();
      currentOwner = owner;
      currentOAuthRuntime = null;
      startInitialization({
        mode: "print",
        hasUI: false,
        cwd: process.cwd(),
        model: undefined,
        modelRegistry: undefined,
        signal: undefined,
      } as unknown as ExtensionContext, owner, generation, "stale_load_time_initialization");
    });
  }

  pi.on("resources_discover", (event) => {
    const resourceConfig = programmaticConfig
      ? cloneMcpConfig(sessionConfig)
      : loadMcpConfig(earlyConfigPath, event.cwd);
    const skillPaths = discoverConfiguredClaudePluginSkills(resourceConfig, event.cwd);
    if (earlyConfig.settings?.scriptMode !== false) {
      const scriptingSkillPath = fileURLToPath(new URL("./skills/mcp-scripting/SKILL.md", import.meta.url));
      if (existsSync(scriptingSkillPath) && !skillPaths.includes(scriptingSkillPath)) {
        skillPaths.push(scriptingSkillPath);
      }
    }
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    // Reset before any await so replacement sessions cannot inherit activation.
    searchActivatedTools.clear();
    holdLazyToolsInactive();
    const generation = ++lifecycleGeneration;
    largeDirectToolsAdvisoryDelivered = false;
    const previousState = state;
    const previousOwner = currentOwner;
    const previousOAuthRuntime = currentOAuthRuntime;
    const owner = createMcpRuntimeOwner();
    currentOwner = owner;
    currentOAuthRuntime = null;
    state = null;
    initPromise = null;
    initStartedPromise = null;
    clearRetainedInitFailure();

    // Abort synchronously before awaiting cleanup so old callbacks and startup
    // work cannot resume into a stale ExtensionContext.
    const stopPrevious = previousOwner?.stop("MCP extension session restarted") ?? Promise.resolve();
    try {
      await Promise.all([
        stopPrevious,
        shutdownState(previousState, "session_restart"),
        previousOAuthRuntime ? loadOAuthRuntime().then(({ shutdownOAuth }) => shutdownOAuth(previousOAuthRuntime)) : Promise.resolve(),
      ]);
    } catch (error) {
      console.error(`MCP: failed to shut down previous session state: ${formatTerminalError(error)}`);
    }

    if (generation !== lifecycleGeneration || !owner.isActive()) return;
    if (state) return;

    if (!initPromise) {
      const deferredSnapshot = getDeferredSessionSnapshot(ctx.cwd);
      if (deferredSnapshot) {
        const { config, cache, enabledServerCount } = deferredSnapshot;
        const directResult = syncDirectTools(config, cache);
        syncProxyTool(config, cache, directResult.specs);
        syncNamespaceTools(config, cache, directResult.reservedDirectNames, directResult.activeDirectNames);
        // Pi cannot unregister commands. Wait until cwd is authoritative, and
        // under the opt-in wait for live metadata, before exposing prompts.
        if (config.settings?.deferWithMissingMetadata !== true) {
          registerPromptCommands(resolveCachedPrompts(config));
        }
        deliverLargeDirectToolsAdvisory(ctx, config, directResult.specs);
        if (generation !== lifecycleGeneration || !owner.isActive() || currentOwner !== owner) return;
        const serverCount = Object.keys(config.mcpServers).length;
        const formattedStatus = formatMcpFooterStatus(
          config,
          enabledServerCount,
          serverCount - enabledServerCount,
          0,
        );
        const theme = ctx.ui?.theme;
        const styledStatus = formattedStatus !== undefined && typeof theme?.fg === "function"
          ? theme.fg("accent", formattedStatus)
          : formattedStatus;
        ctx.ui?.setStatus("mcp", styledStatus);
        return;
      }
      startInitialization(ctx, owner, generation, "stale_session_start");
    }

    const initialization = initPromise as Promise<McpExtensionState> | null;
    const initializationStarted = initStartedPromise as Promise<void> | null;
    if (envRaw !== undefined && envRaw !== "__none__") {
      const missingEnvDirectTools = getMissingConfiguredDirectToolServers(
        earlyConfig,
        loadMetadataCache(),
        envDirectToolOverride,
      );
      if (missingEnvDirectTools.length > 0) {
        await initialization?.then(() => undefined, () => undefined);
        return;
      }
    }
    await initializationStarted;
  });

  // Other extensions can reactivate registered tools after session_start.
  pi.on("before_agent_start", holdLazyToolsInactive);

  pi.on("session_tree", (_event, ctx) => {
    const currentState = state;
    const owner = currentOwner;
    if (!currentState || !owner?.isActive() || !currentState.sessionManager) return;

    let sessionManager: ExtensionContext["sessionManager"] | undefined;
    try {
      sessionManager = ctx.sessionManager;
    } catch {
      return;
    }
    if (sessionManager !== currentState.sessionManager) return;

    restoreCurrentSessionApprovals(currentState);
  });

  pi.on("input", async () => {
    const inputOwner = currentOwner;
    if (!inputOwner?.isActive()) return;

    if (!state && initPromise) {
      try {
        await awaitWithTimeout(initPromise, INIT_WAIT_TIMEOUT_MS);
      } catch {
        return;
      }
    }

    const inputState = state;
    if (!inputState || !inputOwner.isActive()) return;
    try {
      await inputState.lifecycle.ensureConverged(inputOwner.signal);
    } catch (error) {
      if (!isAbortError(error, inputOwner.signal)) {
        logger.debug(`MCP: keep-alive convergence failed before input: ${formatTerminalError(error)}`);
      }
    }
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    const owner = currentOwner;
    const oauthRuntime = currentOAuthRuntime;
    currentOwner = null;
    currentOAuthRuntime = null;
    state = null;
    initPromise = null;
    initStartedPromise = null;
    clearRetainedInitFailure();

    // Abort before awaiting cleanup so delayed initialization cannot touch stale
    // Pi context after session shutdown.
    const stopOwner = owner?.stop("MCP extension session shutdown") ?? Promise.resolve();
    try {
      await Promise.all([
        stopOwner,
        shutdownState(currentState, "session_shutdown"),
        oauthRuntime ? loadOAuthRuntime().then(({ shutdownOAuth }) => shutdownOAuth(oauthRuntime)) : Promise.resolve(),
      ]);
    } catch (error) {
      console.error(`MCP: session shutdown cleanup failed: ${formatTerminalError(error)}`);
    }
  });

  // Re-flag returned MCP tool failures so pi registers them as errors (see toolErrorOverride).
  pi.on("tool_result", (event) => toolErrorOverride(event.details));

  const registerMcpCommand = (commandName: string) => pi.registerCommand(commandName, {
    description: "Show MCP server status",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trimStart();
      const argumentMatch = normalized.match(/^(\S+)\s+(.*)$/);
      if (!argumentMatch) {
        const subcommands = [
          { value: "reconnect", label: "reconnect — Reconnect servers" },
          { value: "tools", label: "tools — List all tools" },
          { value: "prompts", label: "prompts — List all MCP prompts" },
          { value: "setup", label: "setup — Configure MCP servers" },
          { value: "jev", label: "jev setup — Configure Jev semantic search" },
          { value: "edit", label: "edit — Edit .mcp.json or the global config" },
          { value: "logout", label: "logout — Clear server credentials" },
          { value: "token", label: "token — Manage stored bearer tokens" },
          { value: "disable", label: "disable — Disable a server" },
          { value: "enable", label: "enable — Enable a server" },
          { value: "status", label: "status — Show server status" },
        ].filter(({ value }) => value.startsWith(normalized));
        return subcommands.length > 0 ? subcommands : null;
      }

      const [, subcommand, argumentPrefix] = argumentMatch;
      if (subcommand === "jev") {
        return "setup".startsWith((argumentPrefix ?? "").trimStart())
          ? [{ value: "jev setup", label: "setup — Configure Jev semantic search" }]
          : null;
      }
      if (
        (subcommand !== "reconnect" && subcommand !== "logout" && subcommand !== "disable" && subcommand !== "enable" && subcommand !== "token")
        || argumentPrefix === undefined
      ) return null;

      const completionConfig = state?.config ?? earlyConfig;
      if (subcommand === "token") {
        const tokenMatch = argumentPrefix.trimStart().match(/^(set|remove|status)\s+(.*)$/);
        if (!tokenMatch) {
          const actions = ["set", "remove", "status"]
            .filter(action => action.startsWith(argumentPrefix.trimStart()))
            .map(action => ({ value: `token ${action} `, label: `${action} — Bearer token ${action}` }));
          return actions.length > 0 ? actions : null;
        }
        const action = tokenMatch[1] ?? "";
        const serverPrefix = tokenMatch[2] ?? "";
        const servers = Object.keys(completionConfig.mcpServers)
          .filter(serverName => serverName.startsWith(serverPrefix.trimStart()))
          .map(serverName => ({ value: `token ${action} ${serverName}`, label: serverName }));
        return servers.length > 0 ? servers : null;
      }

      const servers = Object.keys(completionConfig.mcpServers)
        .filter((serverName) => serverName.startsWith(argumentPrefix.trimStart()))
        .map((serverName) => ({ value: `${subcommand} ${serverName}`, label: serverName }));
      return servers.length > 0 ? servers : null;
    },
    handler: async (args, ctx) => {
      let commandOwner = currentOwner;
      const commandReload = typeof ctx.reload === "function" ? ctx.reload.bind(ctx) : async () => {};
      let commandCtx = createCommandContext(ctx as unknown as ExtensionContext, commandOwner);
      if (!state) {
        try {
          state = await ensureSessionRuntime(ctx as unknown as ExtensionContext);
          commandOwner = currentOwner;
          commandCtx = createCommandContext(ctx as unknown as ExtensionContext, commandOwner);
          commandOwner?.throwIfInactive();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (commandCtx.hasUI) commandCtx.ui?.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (commandCtx.hasUI) commandCtx.ui?.notify("MCP not initialized", "error");
        return;
      }

      const commandGuard = captureRuntimeGuard(state);
      let commands: Awaited<ReturnType<typeof loadCommands>>;
      try {
        commands = await loadForRuntime(loadCommands, commandGuard);
      } catch (error) {
        if (commandGuard.owner && isOwnerAbortError(error, commandGuard.owner)) return;
        const message = error instanceof Error ? error.message : String(error);
        if (commandCtx.hasUI) commandCtx.ui?.notify(`MCP initialization failed: ${message}`, "error");
        return;
      }
      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          commandOwner?.throwIfInactive();
          await commands.reconnectServers(state, commandCtx, targetServer);
          break;
        case "tools":
          await commands.showTools(state, commandCtx);
          break;
        case "prompts":
          await commands.showPrompts(state, commandCtx);
          break;
        case "setup": {
          commandOwner?.throwIfInactive();
          if (programmaticConfig) {
            commandCtx.ui?.notify("MCP setup is unavailable when config is supplied by createMcpAdapter().", "info");
            break;
          }
          const result = await commands.openMcpSetup(state, pi, commandCtx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            commandOwner?.throwIfInactive();
            await commandReload();
            return;
          }
          break;
        }
        case "jev": {
          if (parts[1] !== "setup" || parts.length !== 2) {
            commandCtx.ui?.notify("Usage: /mcp jev setup", "error");
            break;
          }
          if (programmaticConfig) {
            commandCtx.ui?.notify("Jev setup is unavailable when config is supplied by createMcpAdapter().", "info");
            break;
          }
          commandOwner?.throwIfInactive();
          if (await commands.setupJevSemanticSearch(state, commandCtx, earlyConfigPath)) {
            commandOwner?.throwIfInactive();
            await commandReload();
            return;
          }
          break;
        }
        case "edit": {
          if (programmaticConfig) {
            commandCtx.ui?.notify("MCP edit is unavailable when config is supplied by createMcpAdapter().", "info");
            break;
          }
          const target = parts[1] ?? "project";
          if (target !== "project" && target !== "global") {
            commandCtx.ui?.notify("Usage: /mcp edit [project|global]", "error");
            return;
          }
          commandOwner?.throwIfInactive();
          if (await commands.editSharedConfig(commandCtx, target)) {
            commandOwner?.throwIfInactive();
            await commandReload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (commandCtx.hasUI) commandCtx.ui?.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          commandOwner?.throwIfInactive();
          await commands.logoutServer(serverName, state, commandCtx);
          break;
        }
        case "token": {
          const action = parts[1];
          const serverName = parts.slice(2).join(" ");
          if (action !== "set" && action !== "remove" && action !== "status") {
            if (commandCtx.hasUI) commandCtx.ui?.notify("Usage: /mcp token set|remove|status <server>", "error");
            return;
          }
          if (!serverName) {
            if (commandCtx.hasUI) commandCtx.ui?.notify("Usage: /mcp token set|remove|status <server>", "error");
            return;
          }
          commandOwner?.throwIfInactive();
          await commands.manageBearerToken(action, serverName, state, commandCtx);
          break;
        }
        case "disable":
        case "enable": {
          const serverName = rest;
          if (programmaticConfig) {
            commandCtx.ui?.notify(`/mcp ${subcommand} is unavailable when config is supplied by createMcpAdapter().`, "info");
            break;
          }
          if (!serverName) {
            commandCtx.ui?.notify(`Usage: /mcp ${subcommand} <server>`, "error");
            break;
          }
          if (!state.config.mcpServers[serverName]) {
            commandCtx.ui?.notify(`Server "${serverName}" not found in effective config`, "error");
            break;
          }
          commandOwner?.throwIfInactive();
          const result = writeProjectServerDisabledOverride(earlyConfigPath, commandCtx.cwd, serverName, subcommand === "disable");
          if (result.changed) {
            commandCtx.ui?.notify(`${subcommand === "disable" ? "Disabled" : "Enabled"} server "${serverName}" in ${result.path} — run /reload to apply`, "info");
          } else {
            commandCtx.ui?.notify(`Server "${serverName}" is already ${subcommand === "disable" ? "disabled" : "enabled"}`, "info");
          }
          break;
        }
        case "status":
        case "":
        default:
          if (commandCtx.hasUI) {
            commandOwner?.throwIfInactive();
            if (programmaticConfig) {
              commandCtx.ui?.notify("MCP status is shown from the in-memory SDK config; configuration discovery is unavailable.", "info");
              await commands.showStatus(state, commandCtx);
              break;
            }
            const result = await commands.openMcpPanel(state, pi, commandCtx, earlyConfigPath, (changes) => {
              applyDirectToolConfigChanges(changes);
              syncToolSurface(commandCtx);
            });
            if (result?.configChanged) {
              commandOwner?.throwIfInactive();
              await commandReload();
              return;
            }
          } else {
            await commands.showStatus(state, commandCtx);
          }
          break;
      }
    },
  });
  registerMcpCommand("mcp");
  registerMcpCommand("pi-mcp");

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      let commandOwner = currentOwner;
      let commandCtx = createCommandContext(ctx as unknown as ExtensionContext, commandOwner);
      const serverName = args?.trim();
      if (!serverName && !commandCtx.hasUI) {
        return;
      }

      if (!state) {
        try {
          state = await ensureSessionRuntime(ctx as unknown as ExtensionContext);
          commandOwner = currentOwner;
          commandCtx = createCommandContext(ctx as unknown as ExtensionContext, commandOwner);
          commandOwner?.throwIfInactive();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (commandCtx.hasUI) commandCtx.ui?.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (commandCtx.hasUI) commandCtx.ui?.notify("MCP not initialized", "error");
        return;
      }

      const commandGuard = captureRuntimeGuard(state);
      let commands: Awaited<ReturnType<typeof loadCommands>>;
      try {
        commands = await loadForRuntime(loadCommands, commandGuard);
      } catch (error) {
        if (commandGuard.owner && isOwnerAbortError(error, commandGuard.owner)) return;
        const message = error instanceof Error ? error.message : String(error);
        if (commandCtx.hasUI) commandCtx.ui?.notify(`MCP initialization failed: ${message}`, "error");
        return;
      }
      if (!serverName) {
        if (programmaticConfig) {
          commandCtx.ui?.notify("Use /mcp-auth <server> to authenticate a server from the in-memory SDK config.", "info");
          return;
        }
        await commands.openMcpAuthPanel(state, pi, commandCtx, earlyConfigPath);
        return;
      }

      const result = await commands.authenticateServer(serverName, state.config, commandCtx, commandCtx.signal, state.oauthRuntime);
      if (result.ok) {
        commandOwner?.throwIfInactive();
        await commands.reconnectServer(state, commandCtx, serverName);
      }
    },
  });

  if (earlyConfig.settings?.scriptMode !== false) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcpScript",
      label: "MCP Script",
      description: "Run trusted JavaScript that makes multiple MCP tool calls in one request — loop, filter, chain, or fan out between calls. For a single MCP call, search, describe, status check, or auth action, use the mcp tool instead. Discover with await tools.search({ query }) — resolves to { items: [{ path, name, server, description? }], total, hasMore, nextOffset }, not an { ok, data } envelope. Inspect with await tools.describe({ path }) — resolves to the tool descriptor with inputTypeScript, or { path, error: { code, message, suggestions } }. Then call tools.call(path, args) — resolves to { ok: true, data } or { ok: false, error: { code, message } } — or use direct flat calls when the name is already known; use emit(value) for user-visible output. Load the mcp-scripting skill for the full workflow guide.",
      promptSnippet: "Batch multiple MCP tool calls in one JavaScript request (loop, filter, chain)",
      parameters: Type.Object({
        code: Type.String({ description: "Trusted JavaScript MCP script. Use tools.<prefixedToolName>(args) and emit(value)." }),
        timeoutMs: optionalNumber({ minimum: 1, description: "Execution timeout in milliseconds (default: 30000)" }),
      }),
      renderCall: createMcpScriptToolCallRenderer(toolRenderOptions),
      renderResult: renderMcpToolResult,
      async execute(_toolCallId: string, params: { code: string; timeoutMs?: number }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
        let executeOwner = currentOwner;
        if (!state) {
          try {
            const initialized = await awaitWithTimeout(ensureSessionRuntime(ctx), INIT_WAIT_TIMEOUT_MS);
            if (initialized === INIT_WAIT_TIMED_OUT) {
              return {
                content: [{ type: "text" as const, text: "MCP initialization is still in progress. Try again shortly." }],
                details: { mode: "script", error: "init_timeout", timeoutMs: INIT_WAIT_TIMEOUT_MS },
              };
            }
            executeOwner = currentOwner;
            executeOwner?.throwIfInactive();
            state = initialized;
          } catch (error) {
            if (executeOwner && isOwnerAbortError(error, executeOwner)) throw error;
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
              details: { mode: "script", error: "init_failed", message },
            };
          }
        }
        if (!state) {
          return {
            content: [{ type: "text" as const, text: retainedInitFailure
              ? buildInitRetryInstruction("MCP is not initialized after an earlier initialization failure")
              : "MCP not initialized" }],
            details: { mode: "script", error: "not_initialized", ...(retainedInitFailure ? { message: retainedInitFailure } : {}) },
          };
        }
        executeOwner?.throwIfInactive();
        const scriptState = state;
        const scriptGuard = captureRuntimeGuard(scriptState);
        const codeMode = await loadForRuntime(loadCodeMode, scriptGuard);
        return codeMode.runMcpScript(scriptState, params.code, params.timeoutMs, getPiTools, signal);
      },
    });
  }

  async function connectAndReport(targetState: McpExtensionState, serverName: string, signal?: AbortSignal, ctx?: ExtensionContext) {
    const guard = captureRuntimeGuard(targetState);
    const directToolsBefore = new Map([...registeredDirectTools.keys()].map((name) => [name, registeredDirectToolVersions.get(name) ?? 0]));
    const proxyModes = await loadForRuntime(loadProxyModes, guard);
    const result = await proxyModes.executeConnect(targetState, serverName, signal);
    assertRuntimeGuard(guard);
    if (!directToolsFrozen) syncToolSurface(ctx);
    const reportedNames = reportedDirectToolNamesByServer.get(serverName) ?? new Set<string>();
    // Attribute only this server's new definitions; search-mode tools load on search, not connect.
    const addedToolNames = [...registeredDirectTools.keys()].filter(
      (name) => (!directToolsBefore.has(name) || (registeredDirectToolVersions.get(name) ?? 0) !== directToolsBefore.get(name))
        && registeredDirectToolServers.get(name) === serverName
        && !reportedNames.has(name)
        && !lazyDirectTools.has(name),
    );
    if (addedToolNames.length === 0) return result;
    for (const name of addedToolNames) reportedNames.add(name);
    reportedDirectToolNamesByServer.set(serverName, reportedNames);
    return { ...result, addedToolNames };
  }

  async function executeInstall(
    targetState: McpExtensionState,
    rawUrl: string | undefined,
    requestedName: string | undefined,
    target: string | undefined,
    cwd: string,
    signal?: AbortSignal,
  ) {
    const installOwner = currentOwner;
    signal?.throwIfAborted();
    installOwner?.throwIfInactive();
    if (programmaticConfig) {
      return {
        content: [{ type: "text" as const, text: "MCP install is unavailable when the adapter uses programmatic configuration." }],
        details: { mode: "install", error: "programmatic_config" },
      };
    }
    if (targetState.config.settings?.allowInstall === false) {
      return {
        content: [{ type: "text" as const, text: "MCP install is disabled by configuration." }],
        details: { mode: "install", error: "install_disabled" },
      };
    }
    if (target !== undefined && target !== "global" && target !== "project") {
      return {
        content: [{ type: "text" as const, text: "MCP install target must be 'global' or 'project'." }],
        details: { mode: "install", error: "invalid_target" },
      };
    }

    const destination = target === "project" ? getProjectConfigPath(cwd) : getPiGlobalConfigPath(earlyConfigPath);
    if (target === "project" && process.env.PI_MCP_CONFIG_MODE?.trim().toLowerCase() === "exclusive"
      && resolve(destination) !== resolve(getPiGlobalConfigPath(earlyConfigPath))) {
      return {
        content: [{ type: "text" as const, text: "Project installation is unavailable in exclusive config mode; use the global target." }],
        details: { mode: "install", error: "inactive_target" },
      };
    }

    const installGuard = captureRuntimeGuard(targetState);
    const installParsing = await loadForRuntime(loadInstallParsing, installGuard);
    let normalized: ReturnType<typeof installParsing.normalizeMcpInstallRequest>;
    try {
      normalized = installParsing.normalizeMcpInstallRequest({
        url: rawUrl ?? "",
        ...(requestedName !== undefined ? { serverName: requestedName } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Failed to install MCP server: ${message}` }],
        details: { mode: "install", error: "invalid_request", message },
      };
    }

    const matchingUrl = Object.entries(targetState.config.mcpServers).find(([, definition]) =>
      definition.url !== undefined && installParsing.canonicalMcpServerUrl(definition.url) === normalized.url,
    );
    const serverName = requestedName?.trim() || matchingUrl?.[0] || normalized.serverName;
    const existing = targetState.config.mcpServers[serverName];
    if (existing && installParsing.canonicalMcpServerUrl(existing.url ?? "") !== normalized.url) {
      return {
        content: [{ type: "text" as const, text: `MCP server name "${serverName}" is already configured with a different endpoint.` }],
        details: { mode: "install", error: "name_conflict", server: serverName, url: normalized.url },
      };
    }

    if (targetState.provisionalInstalls?.has(serverName)) {
      return {
        content: [{ type: "text" as const, text: `MCP server "${serverName}" is still being installed. Retry after that installation finishes.` }],
        details: { mode: "install", error: "install_in_progress", server: serverName },
      };
    }
    if (runtimeServers.has(serverName)) {
      return {
        content: [{ type: "text" as const, text: `Runtime MCP server "${serverName}" cannot be promoted by URL install. Save its full definition manually.` }],
        details: { mode: "install", error: "runtime_promotion_unsupported", server: serverName },
      };
    }

    const persistedEntry: ServerEntry = { url: normalized.url };
    const runtimeEntry: ServerEntry = existing ?? { ...persistedEntry, directTools: false };
    const provisional = existing === undefined;
    const restoreMetadata = [targetState.toolMetadata, targetState.promptMetadata, targetState.serverInstructions,
      targetState.resourceCounts, targetState.directToolCounts].map((map) => {
      const previous = map.get(serverName);
      return () => {
        if (previous === undefined) map.delete(serverName);
        else (map as Map<string, unknown>).set(serverName, previous);
      };
    });
    const hadLivePrompts = targetState.promptMetadataLive.has(serverName);
    const rollback = async (): Promise<void> => {
      if (!provisional || targetState.config.mcpServers[serverName] !== runtimeEntry) return;
      delete targetState.config.mcpServers[serverName];
      targetState.lifecycle.unregisterServer(serverName);
      try {
        await targetState.manager.close(serverName);
      } finally {
        targetState.provisionalInstalls?.delete(serverName);
        for (const restore of restoreMetadata) restore();
        if (!hadLivePrompts) targetState.promptMetadataLive.delete(serverName);
        const core = await loadForRuntime(loadCoreRuntime, installGuard);
        core.clearFailure(targetState, serverName, "install-rollback");
        syncToolSurface();
        core.updateStatusBar(targetState);
      }
    };

    let connectResult: Awaited<ReturnType<typeof connectAndReport>>;
    try {
      if (provisional) {
        (targetState.provisionalInstalls ??= new Set()).add(serverName);
        targetState.config.mcpServers[serverName] = runtimeEntry;
        attachRuntimeServerLifecycle(targetState, serverName, runtimeEntry);
        syncToolSurface();
        (await loadForRuntime(loadCoreRuntime, installGuard)).updateStatusBar(targetState);
      }
      connectResult = await connectAndReport(targetState, serverName, signal);
      signal?.throwIfAborted();
      installOwner?.throwIfInactive();
    } catch (error) {
      await rollback();
      throw error;
    }
    const connectError = connectResult.details?.error;
    const connectText = connectResult.content.find((content) => content.type === "text")?.text;
    if (connectError && connectError !== "auth_required") {
      await rollback();
      return {
        ...connectResult,
        content: [{ type: "text" as const, text: `MCP installation validation failed for "${serverName}". ${connectText ?? "Connection failed."}` }],
        details: { mode: "install", error: "validation_failed", server: serverName, url: normalized.url },
      };
    }

    if (provisional) {
      try {
        await withFileMutationQueue(destination, async () => {
          signal?.throwIfAborted();
          installOwner?.throwIfInactive();
          writeSharedServerEntry(destination, serverName, persistedEntry);
        });
      } catch (error) {
        await rollback();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `MCP server validation succeeded, but configuration could not be saved: ${message}` }],
          details: { mode: "install", error: "persistence_failed", server: serverName, url: normalized.url, message },
        };
      }
      targetState.provisionalInstalls?.delete(serverName);
      try {
        (await loadForRuntime(loadCoreRuntime, installGuard)).updateMetadataCache(targetState, serverName);
        assertRuntimeGuard(installGuard);
      } catch (error) {
        if (isRuntimeGuardStale(installGuard) || isAbortError(error, installGuard.owner?.signal)) throw error;
        logger.warn(`MCP: installed "${serverName}" but could not cache metadata: ${error}`);
      }
      syncPromptCommands();
    }

    if (connectError === "auth_required") {
      const proxyModes = await loadForRuntime(loadProxyModes, installGuard);
      const authResult = await proxyModes.executeAuthStart(targetState, serverName, signal);
      const authError = authResult.details?.error;
      const authText = authResult.content.find((content) => content.type === "text")?.text;
      return {
        ...connectResult,
        content: [{
          type: "text" as const,
          text: `${provisional ? "Installed" : "Found"} MCP server "${serverName}" at ${normalized.url}.\n\n${authText ?? "OAuth authorization is required."}`,
        }],
        details: {
          mode: "install",
          status: authError ? "auth_start_failed" : "awaiting_auth",
          server: serverName,
          url: normalized.url,
          ...(provisional ? { path: destination } : {}),
          ...(authError ? { error: authError } : {}),
        },
      };
    }

    return {
      ...connectResult,
      content: [{
        type: "text" as const,
        text: `${provisional ? "Installed and connected" : "Already installed; connected"} MCP server "${serverName}" at ${normalized.url}.\n\n${connectText ?? ""}`.trim(),
      }],
      details: {
        mode: "install",
        status: "connected",
        server: serverName,
        url: normalized.url,
        ...(provisional ? { path: destination } : {}),
      },
    };
  }

  function registerProxyTool(description: string): void {
    callReentrant(() => (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description,
      promptSnippet: "MCP gateway — install by URL, status, search, describe, auth, and single MCP tool calls",
      renderShell: toolRenderShell,
      renderCall: createMcpProxyToolCallRenderer(toolRenderOptions),
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
        args: Type.Optional(Type.Union([
          Type.String({ description: "Arguments as a JSON string (e.g., '{\"key\": \"value\"}')" }),
          Type.Object({}, {
            additionalProperties: true,
            description: 'Arguments as a JSON object (e.g., { "key": "value" })',
          }),
        ], { description: "Tool arguments as a JSON object, or as a JSON string encoding one" })),
        connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
        describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
        instructions: Type.Optional(Type.String({ description: "Server name to show that server's usage instructions" })),
        search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
        searchMode: Type.Optional(Type.String({ enum: ["lexical", "semantic"], description: "Search backend (default: lexical; semantic is available when a System One key is configured)" })),
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        limit: optionalNumber({ minimum: 1, description: "Maximum search results to return (default: 12)" }),
        offset: optionalNumber({ minimum: 0, description: "Search result offset (default: 0)" }),
        server: Type.Optional(Type.String({ description: "Server name: filters searches, disambiguates calls and describe operations, and optionally names an install" })),
        action: Type.Optional(Type.String({ description: "Action: 'install', 'ui-messages', 'auth-start', or 'auth-complete'" })),
        url: Type.Optional(Type.String({ description: "MCP endpoint URL for action: 'install'" })),
        target: Type.Optional(Type.String({ description: "Install target: 'global' (default) or 'project'" })),
      }),
      renderResult: renderMcpToolResult,
      async execute(_toolCallId: string, params: {
        tool?: string;
        args?: string | Record<string, unknown>;
        connect?: string;
        describe?: string;
        instructions?: string;
        search?: string;
        searchMode?: "lexical" | "semantic";
        regex?: boolean;
        includeSchemas?: boolean;
        limit?: number;
        offset?: number;
        server?: string;
        action?: string;
        url?: string;
        target?: string;
      }, signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, _ctx: ExtensionContext) {
        let executeOwner = currentOwner;
        const parseArgs = (value: string | Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
          if (value === undefined || value === "") return undefined;
          let args: unknown;
          if (typeof value === "string") {
            try {
              args = JSON.parse(value);
            } catch (error) {
              if (error instanceof SyntaxError) {
                throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
              }
              throw error;
            }
          } else {
            args = value;
          }

          if (typeof args !== "object" || args === null || Array.isArray(args)) {
            const gotType = Array.isArray(args) ? "array" : args === null ? "null" : typeof args;
            throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
          }
          return args as Record<string, unknown>;
        };
        const parsedArgs = parseArgs(params.args);
        const hasGatewayMode = (value: typeof params): boolean =>
          value.tool !== undefined
          || value.connect !== undefined
          || value.describe !== undefined
          || value.instructions !== undefined
          || value.search !== undefined
          || value.server !== undefined
          || value.action !== undefined
          || value.url !== undefined
          || value.target !== undefined;
        if (!hasGatewayMode(params) && params.args !== undefined) {
          throw new Error("Gateway params were nested inside `args`; pass them top-level (for example, mcp({ search: \"...\" }) or mcp({ tool: \"...\", args: {} })).");
        }

        if (!state && !initPromise) {
          if (retainedInitFailure) startGatewayRetryInitialization(_ctx);
          else void ensureSessionRuntime(_ctx);
          executeOwner = currentOwner;
        }

        if (!state && initPromise) {
          try {
            const initialized = await awaitWithTimeout(initPromise, INIT_WAIT_TIMEOUT_MS);
            if (initialized === INIT_WAIT_TIMED_OUT) {
              return {
                content: [{ type: "text" as const, text: "MCP initialization is still in progress. Try again shortly." }],
                details: { error: "init_timeout", timeoutMs: INIT_WAIT_TIMEOUT_MS },
              };
            }
            executeOwner?.throwIfInactive();
            state = initialized;
          } catch (error) {
            if (executeOwner && isOwnerAbortError(error, executeOwner)) throw error;
            const message = retainInitFailure(error);
            return {
              content: [{ type: "text" as const, text: buildInitRetryInstruction("MCP initialization failed", message) }],
              details: { error: "init_failed", message },
            };
          }
        }
        if (!state) {
          return {
            content: [{ type: "text" as const, text: retainedInitFailure
              ? buildInitRetryInstruction("MCP is not initialized after an earlier initialization failure")
              : "MCP not initialized" }],
            details: { error: "not_initialized", ...(retainedInitFailure ? { message: retainedInitFailure } : {}) },
          };
        }
        executeOwner?.throwIfInactive();
        const proxyState = state;
        const proxyGuard = captureRuntimeGuard(proxyState);
        const proxyModes = await loadForRuntime(loadProxyModes, proxyGuard);

        if (params.action === "install") {
          return executeInstall(proxyState, params.url, params.server, params.target, _ctx.cwd, signal);
        }
        if (params.action === "ui-messages") {
          return proxyModes.executeUiMessages(proxyState);
        }
        if (params.action === "auth-start") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
              details: { mode: "auth-start", error: "missing_server" },
            };
          }
          return signal
            ? proxyModes.executeAuthStart(proxyState, params.server, signal)
            : proxyModes.executeAuthStart(proxyState, params.server);
        }
        if (params.action === "auth-complete") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires `server`." }],
              details: { mode: "auth-complete", error: "missing_server" },
            };
          }
          const input = parsedArgs?.redirectUrl ?? parsedArgs?.code ?? parsedArgs?.input;
          if (typeof input !== "string" || input.trim().length === 0) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires args with `redirectUrl`, `code`, or `input`." }],
              details: { mode: "auth-complete", error: "missing_input" },
            };
          }
          return signal
            ? proxyModes.executeAuthComplete(proxyState, params.server, input, signal)
            : proxyModes.executeAuthComplete(proxyState, params.server, input);
        }
        if (params.tool) {
          return proxyModes.executeCall(proxyState, params.tool, parsedArgs, params.server, getPiTools, signal);
        }
        if (params.connect) {
          return connectAndReport(proxyState, params.connect, signal, _ctx as ExtensionContext);
        }
        if (params.describe) {
          return proxyModes.executeDescribe(proxyState, params.describe, params.server);
        }
        if (params.instructions) {
          return proxyModes.executeInstructions(proxyState, params.instructions);
        }
        if (params.search !== undefined) {
          const result = await proxyModes.executeSearch(proxyState, params.search, params.regex, params.server, params.includeSchemas, params.limit, params.offset, params.searchMode, signal);
          assertRuntimeGuard(proxyGuard);
          if (lazyDirectTools.size === 0) return result;
          holdLazyToolsInactive();
          const matches = (result.details as { matches?: Array<{ server: string; tool: string }> } | undefined)?.matches ?? [];
          const added = activateSearchMatches(matches);
          if (added.length === 0) return result;
          const text = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
          return {
            ...result,
            content: [{ type: "text" as const, text: `Activated as direct tools: ${added.join(", ")}.\n\n${text}` }],
            details: { ...(result.details ?? {}), activated: added },
            addedToolNames: added,
          };
        }
        if (params.server) {
          return proxyModes.executeList(proxyState, params.server);
        }
        return proxyModes.executeStatus(proxyState);
      },
    }));
    proxyToolRegistered = true;
    proxyToolDescription = description;
  }

  function syncProxyTool(config: McpConfig, cache: MetadataCache | null, directSpecs: DirectToolSpec[]): void {
    const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(
      config,
      cache,
      envRaw === undefined || envRaw === "__none__" ? undefined : envDirectToolOverride,
    );
    // Search-mode tools are registered INACTIVE and `mcp({ search })` is their only
    // activation entry point, so dropping the gateway strands them: every tool held, nothing
    // able to activate one. Keep it whenever any spec depends on it.
    const hasSearchModeSpecs = directSpecs.some((spec) => spec.lazy === true);
    const shouldRegisterProxyTool =
      config.settings?.disableProxyTool !== true
      || directSpecs.length === 0
      || hasSearchModeSpecs
      || missingConfiguredDirectToolServers.length > 0
      || hasEnabledServerWithoutValidMetadata(config, cache, directSpecs);

    if (shouldRegisterProxyTool) {
      const description = buildProxyDescription(config);
      if (!proxyToolRegistered || proxyToolDescription !== description) {
        finalizationRegistrations?.add("mcp");
        registerProxyTool(description);
        finalizationGuard?.();
        return;
      }
      const activeTools = getActiveToolsIfReady();
      if (activeTools && !activeTools.includes("mcp")) {
        callReentrant(() => pi.setActiveTools([...activeTools, "mcp"]));
      }
      return;
    }

    if (proxyToolRegistered) {
      const unregistered = deactivateTools(["mcp"]);
      if (unregistered.includes("mcp")) {
        proxyToolRegistered = false;
        proxyToolDescription = null;
      }
    }
  }

  const initialDirectResult = syncDirectTools(earlyConfig, earlyCache);
  syncProxyTool(earlyConfig, earlyCache, initialDirectResult.specs);
  // Register namespace-proxy tools eagerly so tool-groups/slow-mode can validate
  // `mcp:<server>` references on the first session_start turn. Without this
  // eager call, the tool-groups expansion runs before MCP initialization
  // completes and emits false `[unknown-tool] mcp__<server>` diagnostics.
  syncNamespaceTools(earlyConfig, earlyCache, initialDirectResult.reservedDirectNames, initialDirectResult.activeDirectNames);
  startLoadTimeInitialization();
}

export function createMcpAdapter(options: McpAdapterOptions = {}) {
  // Snapshot programmatic plugin roots at the API boundary so early and
  // session-scoped loading cannot resolve the same relative path differently.
  const factoryConfig = options.config !== undefined
    ? normalizeProgrammaticConfig(cloneMcpConfig(options.config))
    : undefined;
  return function mcpAdapter(pi: ExtensionAPI) {
    installMcpAdapter(pi, {
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(factoryConfig !== undefined ? { config: cloneMcpConfig(factoryConfig) } : {}),
    });
  };
}

/**
 * Register an MCP server with the adapter installed for this Pi instance.
 * Registrations are session/runtime scoped and never persisted. Duplicate
 * names fail closed. Registered servers are proxy-tool-only; their tools
 * become visible at the next tool sync. To change a definition, dispose the
 * registration and register again.
 */
export function registerMcpServer(options: { pi: ExtensionAPI; name: string; definition: ServerEntry }): McpServerRegistration {
  const { pi, name, definition } = options;
  const register = runtimeRegistrars.get(pi);
  if (register) return register(name, definition);
  const request: McpRuntimeRegistrationRequest = {
    version: MCP_RUNTIME_REGISTER_VERSION,
    name,
    definition,
  };
  pi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
  if (!request.result) {
    throw new Error("pi-mcp-adapter is not installed for this Pi instance");
  }
  if (!request.result.ok) throw request.result.error;
  return request.result.registration;
}

/**
 * Return a detached, non-persisted snapshot of one runtime-registered MCP
 * server. Configured servers and runtime registrations shadowed by config are
 * never exported through this API.
 */
export function getRuntimeMcpServerSnapshot(options: { pi: ExtensionAPI; name: string }): McpRuntimeServerSnapshot {
  const { pi, name } = options;
  const getSnapshot = runtimeSnapshotters.get(pi);
  if (getSnapshot) return getSnapshot(name);
  const request: McpRuntimeSnapshotRequest = {
    version: MCP_RUNTIME_SNAPSHOT_VERSION,
    name,
  };
  pi.events.emit(MCP_RUNTIME_SNAPSHOT_EVENT, request);
  if (!request.result) {
    throw new Error("pi-mcp-adapter is not installed for this Pi instance");
  }
  if (!request.result.ok) throw request.result.error;
  return request.result.snapshot;
}

export default createMcpAdapter();
