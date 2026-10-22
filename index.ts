import { registerProtocolBridge } from "./runtime-protocol.ts";
export { registerMcpProtocol, MCP_PROTOCOL_EVENT, type McpProtocolDefinition, type McpProtocol, type McpProtocolSession, type McpProtocolStream, type McpProtocolWatch, type McpProtocolEnd } from "./runtime-protocol.ts";
import { withFileMutationQueue, type AgentToolResult, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type RegisteredMcpServer, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type CachedTool, type DirectToolSpec, type McpAdapterOptions, type McpConfig, type PromptMetadata, type ServerEntry } from "./types.ts";
import type { McpOAuthRuntime } from "./mcp-auth-flow.ts";
import type { NestedCallHandOff } from "./proxy-modes.ts";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { cloneMcpConfig, discoverConfiguredClaudePluginSkills, getLegacyMcpMigrationNotices, getPiGlobalConfigPath, getPiMcpAuthPath, getProjectConfigPath, getProjectPiConfigPath, isExclusiveConfigMode, loadMcpConfig, loadMcpConfigWithSources, resolveConfiguredClaudePluginMcp, setPiMcpConfigEnabled, translatePiMcpServer, writeProjectServerDisabledOverride, writeSharedServerEntry } from "./config.ts";
import { approveProjectScriptTool, approveProjectServer, describeBlockedScriptTool, excludeProjectServersAtLoadTime, hasProjectScriptToolDefinitions, hasProjectServerDefinitions, loadedScriptToolIssues } from "./project-server-trust.ts";
import { buildProxyDescription, getLargeDirectToolsAdvisory, getMissingConfiguredDirectToolServers, prepareDirectToolArguments, resolveDirectTools } from "./direct-tool-surface.ts";
import { deferredToolKey, resolveDeferredToolSpecs, type DeferredToolSpec } from "./deferred-tool-surface.ts";
import { findScriptTool, nestedScriptToolResult, resolveScriptToolSpecs, runScriptTool, SCRIPT_TOOL_NAMESPACE, scriptToolNameConflict, scriptToolOwnerKey, type ScriptToolReservation, type ScriptToolSpec } from "./script-tool-surface.ts";
import { parseScriptTools } from "./script-tools.ts";
import { buildScriptToolSavePrompt, checkScriptToolCode, checkScriptToolSave, scriptToolSaveChange, writeScriptToolSave } from "./script-tool-save.ts";
import { namespaceProxyName } from "./mcp-references.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";
import { isServerCacheValid, loadMetadataCache, parseDirectToolSelectors, withSessionMetadata, type MetadataCache } from "./metadata-cache.ts";
import { isExecutorCatalogEntry } from "./executor-catalog.ts";
import { createPromptCommand, resolveCachedPrompts } from "./prompts.ts";
import { logger } from "./logger.ts";
import { formatMcpFooterStatus, formatTerminalError, getConfigPathFromArgv, normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";
import { createMcpDirectToolCallRenderer, createMcpProxyToolCallRenderer, createMcpToolResultRenderer, resolveMcpToolRenderOptions } from "./tool-result-renderer.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { createMcpRuntimeOwner, createOwnedUi, isAbortError, type McpRuntimeOwner } from "./runtime-owner.ts";
import { cleanupMaterializedBinaryResources } from "./tool-registrar.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";
import { syncNamespaceProxyTools } from "./namespace-tools.ts";
import { restoreSessionApprovalState } from "./session-approvals.ts";
import { createRetryableLoader } from "./lazy-loader.ts";
import { toToolParameters } from "./tool-parameters.ts";
import { readPanelOpenKeys } from "./panel-keys.ts";
import { getAgentPath } from "./agent-dir.ts";

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
const loadInstallParsing = createRetryableLoader(() => import("./mcp-install.ts"));

const INIT_WAIT_TIMEOUT_MS = 30_000;
const INIT_FAILURE_MESSAGE_MAX_CHARS = 1_000;
const INIT_WAIT_TIMED_OUT: unique symbol = Symbol("init-wait-timed-out");
// A call that reaches an unregistered server waits this long for it, then runs regardless.
const LATE_REGISTRATION_WAIT_MS = 10_000;

/** Pi 0.99+ has its own MCP config; on Pi 0.84–0.87, `mcp.json` is an old adapter config. */
function piSupportsMcp(pi: ExtensionAPI): boolean {
  return typeof pi.registerMcpServer === "function";
}

/** The CallToolResult codemode scripts get from a deferred tool: its output-guarded content, the server's structuredContent, and isError on any failure. */
function toCallToolResult(result: AgentToolResult<Record<string, unknown>>): AgentToolResult<Record<string, unknown>> {
  return {
    ...result,
    structuredContent: {
      content: result.content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result.details?.error !== undefined ? { isError: true } : {}),
    } as unknown as NonNullable<AgentToolResult["structuredContent"]>,
  };
}

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

/** An enabled Executor whose valid cached listing has no app catalog yet: its startup connect pages one. */
function hasExecutorWithoutCatalog(config: McpConfig, cache: MetadataCache | null): boolean {
  return Object.entries(config.mcpServers).some(([serverName, definition]) => {
    const entry = cache?.servers[serverName];
    return entry !== undefined && !entry.executorApps && !isServerDisabled(definition)
      && isExecutorCatalogEntry(entry) && isServerCacheValid(entry, definition);
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

export const MCP_RUNTIME_TOOL_CALL_EVENT = "pi-mcp-adapter:runtime-tool-call:v1" as const;
export const MCP_RUNTIME_TOOL_CALL_VERSION = 1 as const;

export type McpRuntimeToolCallResult =
  | { ok: true; result: AgentToolResult<Record<string, unknown>> }
  | { ok: false; error: Error };

/** The adapter sets `result` to a promise during `emit()`; await it. */
export interface McpRuntimeToolCallRequest {
  version: typeof MCP_RUNTIME_TOOL_CALL_VERSION;
  /** Tool name as accepted by `mcp({ tool })`. */
  tool: string;
  args?: Record<string, unknown>;
  server?: string;
  result?: Promise<McpRuntimeToolCallResult>;
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

// The label a supplied config's script-tool issues carry, since it has no file path.
const SUPPLIED_CONFIG_LABEL = "The MCP config supplied to the adapter";

function validateSuppliedScriptTools(config: McpConfig): { config: McpConfig; issues: string[] } {
  if (config.scriptTools === undefined) return { config, issues: [] };
  const { scriptTools, issues } = parseScriptTools(config.scriptTools, SUPPLIED_CONFIG_LABEL, process.cwd());
  const { scriptTools: _supplied, ...rest } = config;
  return { config: Object.keys(scriptTools).length > 0 ? { ...rest, scriptTools } : rest, issues };
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
  // A supplied config was never read from a file, so its script tools are checked here, with
  // relative paths against the working directory, the same way a config file's are.
  const supplied = options.config !== undefined ? validateSuppliedScriptTools(cloneMcpConfig(options.config)) : undefined;
  const sessionConfig = supplied?.config;
  const programmaticConfig = sessionConfig !== undefined;
  // Before the first config load, so every load in this process agrees.
  if (!programmaticConfig) setPiMcpConfigEnabled(piSupportsMcp(pi));
  let state: McpExtensionState | null = null;
  let sessionCtx: ExtensionContext | null = null;
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
    : excludeProjectServersAtLoadTime(loadMcpConfig(earlyConfigPath));
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
  const namespaceProxyFingerprints = new Map<string, string>();
  const fallbackDeactivatedTools = new Set<string>();
  // directTools: "search" — registered inactive, activated by mcp({ search }) or a successful mcp({ tool }) call.
  const lazyDirectTools = new Set<string>();
  const searchActivatedTools = new Set<string>();
  // On Pi 0.99+ search-mode tools are Pi deferred tools, whose activation Pi owns.
  const deferSearchTools = piSupportsMcp(pi);
  // MCP_DIRECT_TOOLS=__none__ registers nothing, so proxy calls then stay in the proxy too.
  const deferredRegistryLive = deferSearchTools && envRaw !== "__none__";
  const deferredToolDefinitions = new Map<string, Record<string, unknown>>();
  // Pi 0.99+: cached tools with no direct or search-mode registration, as Pi deferred tools, by Pi name.
  const registeredDeferredTools = new Map<string, string>();
  // Script tools, by Pi name: the fingerprint each was last registered with.
  const registeredScriptTools = new Map<string, string>();
  // The registered script tools, by Pi name, for the gateway.
  const registeredScriptSpecs = new Map<string, ScriptToolSpec>();
  // The Pi name each cached tool the adapter registered is callable under, by deferredToolKey.
  const registeredToolNames = new Map<string, string>();
  // The deferredToolKey each deferred name was first given to. Never cleared, so within a session a
  // name never moves to a different tool, as in Pi's built-in MCP.
  const deferredNameOwners = new Map<string, string>();
  const syncedServers = new Set<string>();
  // Every name this adapter registered a direct, search-mode or deferred tool under; Pi keeps hidden ones.
  const adapterToolNames = new Set<string>();
  // Proxy calls handed to a registered tool, by the proxy's tool call id.
  const pendingProxyHandOffs = new Map<string, { name: string; consumed: boolean; run: (params: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<AgentToolResult<Record<string, unknown>>> }>();
  // Pi 1.2+ reads which tools a call may reach; Pi 0.99-1.1 ignore the field.
  const reachesAllTools = deferSearchTools ? { reachesTools: () => "all" as const } : {};
  const toolRenderOptions = resolveMcpToolRenderOptions(earlyConfig.settings);
  const toolRenderShell = toolRenderOptions.resultRendering === "compact" ? "self" : "default";
  const renderMcpToolResult = createMcpToolResultRenderer(toolRenderOptions);
  let proxyToolRegistered = false;
  let proxyToolDescription: string | null = null;
  let directToolsFrozen = false;
  let largeDirectToolsAdvisoryDelivered = false;
  let sessionMigrationNotices: string[] = [];
  let sessionScriptToolIssues: string[] = [];
  // Script tools the last sync left out, with the reason.
  let scriptToolSurfaceIssues: string[] = [];
  // The script-tool issues this session already showed, so a re-sync never repeats one.
  let deliveredScriptToolIssues = new Set<string>();
  // Session/runtime scoped server registrations from other extensions. They
  // survive session restarts within this install and die with the process.
  const runtimeServers = new Map<string, { definition: ServerEntry; entry: ServerEntry }>();
  // Every server registered with Pi's `pi.registerMcpServer()`, and the ones applied to the
  // session by name, with their config JSON; `registration` is null when skipped or overridden.
  let piRegistered: RegisteredMcpServer[] = [];
  const piServers = new Map<string, { config: string; registration: McpServerRegistration | null }>();

  // Mirrors init's per-server lifecycle registration so runtime servers get
  // idle cleanup and keep-alive health recovery like configured servers.
  function attachRuntimeServerLifecycle(targetState: McpExtensionState, name: string, definition: ServerEntry): void {
    const lifecycleMode = definition.lifecycle ?? "lazy";
    const persistsAfterFirstSpawn = lifecycleMode === "eager" || lifecycleMode === "lazy-keep-alive";
    const idleOverride = definition.idleTimeout ?? (persistsAfterFirstSpawn ? 0 : undefined);
    targetState.lifecycle.registerServer(name, definition, idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined);
    if (lifecycleMode === "keep-alive") targetState.lifecycle.markKeepAlive(name, definition);
  }

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
      // An Executor app tool's closure sends this path, so a refresh that only respells it must re-register.
      executorPath: spec.executorPath,
      // A mode-only change (search ↔ eager) must re-register, or the tool
      // keeps the activation behavior of the mode it was registered under.
      lazy: spec.lazy === true,
    });
  }

  function deferredToolFields(spec: DirectToolSpec, config: McpConfig, cache: MetadataCache | null): Record<string, unknown> | undefined {
    if (!deferSearchTools || !spec.lazy) return undefined;
    return piDeferredToolFields(spec, config, cache);
  }

  // The fields Pi's built-in MCP registers its tools with (extensions/mcp/tools.js).
  function piDeferredToolFields(spec: DirectToolSpec, config: McpConfig, cache: MetadataCache | null, cachedTools?: ReadonlyMap<string, CachedTool>): Record<string, unknown> {
    const serverCache = cache?.servers[spec.serverName];
    const tool = spec.resourceUri
      ? undefined
      : cachedTools ? cachedTools.get(spec.originalName) : serverCache?.tools?.find((candidate) => candidate.name === spec.originalName);
    const description = config.mcpServers[spec.serverName]?.description?.trim();
    const instructions = serverCache?.instructions;
    const { title: _title, ...annotations } = tool?.annotations ?? {};
    return {
      exposure: "deferred",
      namespace: {
        name: namespaceProxyName(spec.serverName),
        ...(description ? { description } : {}),
        ...(instructions ? { instructions } : {}),
      },
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      // Pi's createMcpResultSchema shape, which codemode renders as CallToolResult<T>.
      outputSchema: {
        type: "object",
        properties: {
          content: { type: "array", items: { type: "object" } },
          ...(tool?.outputSchema !== undefined ? { structuredContent: tool.outputSchema } : {}),
          isError: { type: "boolean" },
          _meta: { type: "object" },
        },
        required: ["content"],
      },
    };
  }

  function forgetReportedDirectToolName(serverName: string | undefined, toolName: string): void {
    if (!serverName) return;
    const reportedNames = reportedDirectToolNamesByServer.get(serverName);
    if (!reportedNames) return;
    reportedNames.delete(toolName);
    if (reportedNames.size === 0) reportedDirectToolNamesByServer.delete(serverName);
  }

  // The deferred surface registers without a promptSnippet, like Pi's built-in MCP: Pi re-normalizes
  // every snippet on every registerTool, and an activated tool then adds no line to the prompt.
  // `script` runs a script tool instead of the MCP call.
  function registerDirectTool(spec: DirectToolSpec, config: McpConfig, deferred: Record<string, unknown> | undefined, name = spec.prefixedName, promptSnippet = true, script?: ScriptToolSpec): void {
    finalizationRegistrations?.add(name);
    adapterToolNames.add(name);
    const definition = {
      name,
      label: script ? `Script: ${script.name}` : `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      ...(promptSnippet ? { promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}` } : {}),
      parameters: toToolParameters(normalizeDirectToolInputSchema(spec.inputSchema)),
      ...(config.settings?.strictDirectToolArguments === true
        ? { prepareArguments: (args: unknown) => prepareDirectToolArguments(spec.inputSchema, args) }
        : {}),
      ...deferred,
      async execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, ctx: ExtensionContext): Promise<AgentToolResult<Record<string, unknown>>> {
        if (script) return executeScriptTool(script, toolCallId, params, signal, onUpdate, ctx as ExtensionToolContext);
        const handedOff = takeProxyHandOff(toolCallId, name);
        if (handedOff) return handedOff(params, signal);
        let executor: ReturnType<(typeof import("./direct-tools.ts"))["createDirectToolExecutor"]>;
        let guard: RuntimeGuard | undefined;
        try {
          const targetState = await ensureSessionRuntime(ctx);
          if (!targetState) throw new Error("MCP not initialized");
          guard = captureRuntimeGuard(targetState);
          const executionGuard = guard;
          const { createDirectToolExecutor } = await loadForRuntime(loadDirectExecution, executionGuard);
          executor = createDirectToolExecutor(() => executionGuard.state, () => initPromise, spec, deferred !== undefined);
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
      renderCall: createMcpDirectToolCallRenderer(name, toolRenderOptions),
      renderResult: renderMcpToolResult,
    };
    if (deferred && !script) {
      const run = definition.execute;
      definition.execute = async (...args) => toCallToolResult(await run(...args));
    }
    callReentrant(() => (pi.registerTool as (tool: unknown) => unknown)(definition));
    if (deferred) deferredToolDefinitions.set(name, definition);
    else deferredToolDefinitions.delete(name);
  }

  function executeScriptTool(script: ScriptToolSpec, toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult<Record<string, unknown>>> {
    // Called by a tool other than the model or the adapter's proxies, such as a codemode script.
    if (calledByAnotherTool(toolCallId)) return Promise.resolve(nestedScriptToolResult(script.name));
    return runScriptTool({
      pi, ctx, toolCallId, signal, onUpdate: onUpdate as AgentToolUpdateCallback<unknown> | undefined,
      spec: script, input: params, settings: (state?.config ?? earlyConfig).settings,
    });
  }

  // Registers the configured script tools and adds their names to `taken`, before the deferred MCP
  // tools take theirs. Like the deferred surface, an unchanged tool is not registered again.
  // The names a script tool cannot take, and why, for a sync and for a save.
  function scriptToolReservations(config: McpConfig, reservedDirectNames: ReadonlySet<string>, foreignNames: readonly string[]): ScriptToolReservation[] {
    const proxyNames = new Set([...registeredNamespaceProxyTools, ...Object.keys(config.mcpServers).map(namespaceProxyName)]);
    return [
      // No built-in reservation: every candidate is mcp__script__<name>, which no built-in tool is.
      { names: reservedDirectNames, reason: "is already the name of a direct MCP tool" },
      { names: proxyNames, reason: "is already the name of an MCP server's namespace tool" },
      { names: new Set(foreignNames), reason: "is already registered by another extension" },
    ];
  }

  function syncScriptTools(config: McpConfig, taken: Set<string>, reservedDirectNames: ReadonlySet<string>, foreignNames: readonly string[]): void {
    const { specs, issues } = resolveScriptToolSpecs(config.scriptTools, scriptToolReservations(config, reservedDirectNames, foreignNames), deferredNameOwners);
    scriptToolSurfaceIssues = issues;
    if (state) state.scriptToolIssues = scriptToolIssuesOf(state);
    const nextNames = new Set<string>();
    registeredScriptSpecs.clear();
    for (const spec of specs) {
      taken.add(spec.toolName);
      nextNames.add(spec.toolName);
      registeredScriptSpecs.set(spec.toolName, spec);
      if (!deferredNameOwners.has(spec.toolName)) deferredNameOwners.set(spec.toolName, scriptToolOwnerKey(spec.name));
      const deferred = spec.definition.declare === true ? undefined : { exposure: "deferred", namespace: { name: SCRIPT_TOOL_NAMESPACE } };
      const fingerprint = JSON.stringify([spec.definition, deferred ?? null]);
      if (registeredScriptTools.get(spec.toolName) === fingerprint) continue;
      const directSpec = { serverName: SCRIPT_TOOL_NAMESPACE, originalName: spec.name, prefixedName: spec.toolName, description: spec.definition.description, inputSchema: spec.definition.inputSchema };
      registerDirectTool(directSpec, config, deferred, spec.toolName, false, spec);
      finalizationGuard?.();
      registeredScriptTools.set(spec.toolName, fingerprint);
    }
    const removed = [...registeredScriptTools.keys()].filter((name) => !nextNames.has(name));
    for (const name of removed) registeredScriptTools.delete(name);
    // A direct tool registered under a removed name this sync owns it now.
    deactivateTools(removed.filter((name) => !registeredDirectTools.has(name)));
  }

  // What /mcp-adapter lists: invalid entries, project script tools trust blocked, and name clashes.
  function scriptToolIssuesOf(targetState: McpExtensionState): string[] {
    const blocked = [...targetState.blockedScriptTools ?? []].map(([name, block]) => describeBlockedScriptTool(name, block));
    return [...sessionScriptToolIssues, ...blocked, ...scriptToolSurfaceIssues];
  }

  // The script tools the gateway reaches: the registered ones, or under MCP_DIRECT_TOOLS=__none__,
  // which registers none, every configured one. A Pi before 0.99 gets none.
  function gatewayScriptTools(): ScriptToolSpec[] {
    if (deferredRegistryLive) return [...registeredScriptSpecs.values()];
    if (!deferSearchTools) return [];
    return resolveScriptToolSpecs((state?.config ?? earlyConfig).scriptTools, [], new Map()).specs;
  }

  /**
   * `mcp({ tool: "<script tool>" })`. With a nested-call context the call is handed to the registered
   * script tool, so Pi's hooks see `mcp__script__<name>` and its own caller check runs; otherwise the
   * script runs here. Either way the result is the script tool's own.
   */
  async function callScriptToolFromGateway(
    spec: ScriptToolSpec, args: Record<string, unknown>, mcpCallId: string, signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined, ctx: ExtensionContext,
    shadowed: { server: string; tool: string } | undefined,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const withShadowNote = (result: AgentToolResult<Record<string, unknown>>) => shadowed ? {
      ...result,
      content: [...result.content, { type: "text" as const, text: `"${shadowed.tool}" also names an MCP tool on server "${shadowed.server}"; this call ran the script tool. Call the MCP tool with mcp({ tool: "${shadowed.tool}", server: "${shadowed.server}" }).` }],
    } : result;
    let input: Record<string, unknown>;
    try {
      input = prepareDirectToolArguments(normalizeDirectToolInputSchema(spec.definition.inputSchema), args) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Failed to call tool: ${message}` }], details: { mode: "script_tool", tool: spec.name, error: "call_failed", message } };
    }
    const toolCtx = ctx as ExtensionToolContext;
    if (deferredRegistryLive && !directToolsFrozen && typeof toolCtx.executeTool === "function"
      && registeredScriptSpecs.has(spec.toolName) && toolCtx.tools.some((tool) => tool.name === spec.toolName)) {
      const outcome = await toolCtx.executeTool(spec.toolName, input);
      const details = outcome.result.details as Record<string, unknown> | undefined;
      // Keep Pi's verdict, so a failed script reads as failed here as it does when called directly.
      const flag = outcome.isError ? { isError: true as const } : {};
      // Blocked by a tool_call hook or rejected before the script tool ran.
      if (details?.mode !== "script_tool") {
        return withShadowNote({ ...flag, content: outcome.result.content, details: { mode: "script_tool", tool: spec.name, error: "nested_call_failed" } });
      }
      return withShadowNote({ ...flag, content: outcome.result.content, details });
    }
    // The script runs here, not in the script tool, so the caller check runs here too.
    if (calledByAnotherTool(mcpCallId)) return withShadowNote(nestedScriptToolResult(spec.name));
    return withShadowNote(await runScriptTool({
      pi, ctx: toolCtx, toolCallId: mcpCallId, signal, onUpdate: onUpdate as AgentToolUpdateCallback<unknown> | undefined,
      spec, input, settings: (state?.config ?? earlyConfig).settings,
    }));
  }

  // Pi registers a tool active. A lazy tool must not stay that way: hold every
  // lazy tool that search has not activated out of the active set. Safe to call
  // repeatedly; a no-op until Pi's action methods are available.
  function holdLazyToolsInactive(): void {
    // Pi registers deferred tools inactive and owns their activation, including tool_search's and a
    // resumed branch's; holding them here would switch those off.
    if (deferSearchTools || lazyDirectTools.size === 0) return;
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return;
    const next = activeTools.filter((name) => !lazyDirectTools.has(name) || searchActivatedTools.has(name));
    if (next.length !== activeTools.length) pi.setActiveTools(next);
  }

  /**
   * Activate lazy direct tools additively — the ones a search matched, or the
   * one a successful proxy call named. This is the one place a search-mode tool
   * becomes active; nothing is ever deactivated here. Returns the names that
   * actually changed state so the result can report only real additions.
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

  // Tools other extensions registered while the session runs, such as Pi's built-in MCP, which a deferred
  // name registered later must not replace. During extension loading Pi can't list tools, so names claimed
  // then aren't checked. Names this adapter registered earlier stay its own, so deferred names don't drift.
  function foreignToolNames(): string[] {
    let tools: ToolInfo[];
    try {
      tools = callReentrant(() => pi.getAllTools());
    } catch (error) {
      if (error instanceof Error
        && error.message.includes("Action methods cannot be called during extension loading")) return [];
      throw error;
    }
    return tools.map((tool) => tool.name).filter((name) => !adapterToolNames.has(name));
  }

  function deactivateTools(toolNames: string[]): string[] {
    if (toolNames.length === 0) return [];
    const unregisterTool = (pi as ExtensionAPI & { unregisterTool?: (name: string) => boolean }).unregisterTool;
    const unregistered = toolNames.filter((toolName) => callReentrant(() => unregisterTool?.(toolName)) === true);
    const fallbackNames = toolNames.filter((toolName) => !unregistered.includes(toolName));
    // A deferred tool stays callable from codemode while inactive; only hidden makes it unreachable.
    for (const toolName of fallbackNames) {
      const definition = deferredToolDefinitions.get(toolName);
      if (!definition) continue;
      deferredToolDefinitions.delete(toolName);
      callReentrant(() => (pi.registerTool as (tool: unknown) => unknown)({ ...definition, exposure: "hidden" }));
    }
    const activeTools = getActiveToolsIfReady();
    if (!activeTools) return unregistered;
    const removedFallbackNames = fallbackNames.filter((name) => activeTools.includes(name));
    if (removedFallbackNames.length === 0) return unregistered;
    const remove = new Set(removedFallbackNames);
    const nextActiveTools = activeTools.filter((name) => !remove.has(name));
    callReentrant(() => pi.setActiveTools(nextActiveTools));
    for (const toolName of removedFallbackNames) fallbackDeactivatedTools.add(toolName);
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
      const deferred = deferredToolFields(spec, config, cache);
      const fingerprint = directToolFingerprint(spec) + (deferred ? JSON.stringify(deferred) : "");
      const previous = registeredDirectTools.get(spec.prefixedName);
      if (previous !== fingerprint) {
        const previousServer = registeredDirectToolServers.get(spec.prefixedName);
        registerDirectTool(spec, config, deferred);
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
        // Eager → search on Pi 0.99+: Pi keeps a re-registered tool active, so switch it off once.
        if (deferSearchTools && previous !== undefined && !lazyDirectTools.has(spec.prefixedName)) {
          const activeTools = getActiveToolsIfReady();
          if (activeTools?.includes(spec.prefixedName)) {
            callReentrant(() => pi.setActiveTools(activeTools.filter((name) => name !== spec.prefixedName)));
          }
        }
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

  // A server in failure backoff withdraws its direct tools; they must not move to the deferred surface meanwhile.
  function directToolsIgnoringBackoff(config: McpConfig, cache: MetadataCache | null, emitted: DirectToolSpec[]): DirectToolSpec[] {
    if (activeFailureServers().size === 0) return emitted;
    return resolveDirectTools(config, cache, config.settings?.toolPrefix ?? "server", envDirectToolOverride, new Set(), new Set());
  }

  // Pi 0.99+ only. Runs after syncDirectTools, whose names it must not take, and before the namespace proxies.
  // A tool whose fingerprint is unchanged is not registered again, so an unchanged sync costs Pi nothing.
  function syncDeferredTools(config: McpConfig, cache: MetadataCache | null, reservedDirectNames: ReadonlySet<string>, directSpecs: DirectToolSpec[]): void {
    const foreignNames = deferredRegistryLive ? foreignToolNames() : [];
    const taken = deferredRegistryLive
      ? new Set([...reservedDirectNames, ...registeredNamespaceProxyTools, ...Object.keys(config.mcpServers).map(namespaceProxyName), ...foreignNames])
      : undefined;
    if (taken) syncScriptTools(config, taken, reservedDirectNames, foreignNames);
    else {
      // MCP_DIRECT_TOOLS=__none__ registers none and drops none, so it has no issue to report.
      scriptToolSurfaceIssues = !deferSearchTools && Object.keys(config.scriptTools ?? {}).length > 0
        ? ["Script tools need Pi 0.99.0 or later, so none were loaded."]
        : [];
      if (state) state.scriptToolIssues = scriptToolIssuesOf(state);
    }
    const specs: DeferredToolSpec[] = taken
      ? resolveDeferredToolSpecs(config, cache, { names: taken, directTools: directToolsIgnoringBackoff(config, cache, directSpecs), owners: deferredNameOwners })
      : [];
    const nextNames = new Set<string>();
    // One map per server, so looking up each spec's cached tool is O(1).
    const toolsByServer = new Map<string, Map<string, CachedTool>>();
    const cachedToolsOf = (serverName: string): Map<string, CachedTool> => {
      let tools = toolsByServer.get(serverName);
      if (!tools) {
        tools = new Map();
        for (const tool of cache?.servers[serverName]?.tools ?? []) if (!tools.has(tool.name)) tools.set(tool.name, tool);
        toolsByServer.set(serverName, tools);
      }
      return tools;
    };
    for (const spec of specs) {
      nextNames.add(spec.name);
      if (!deferredNameOwners.has(spec.name)) deferredNameOwners.set(spec.name, deferredToolKey(spec.serverName, spec.originalName, spec.resourceUri));
      const fields = piDeferredToolFields(spec, config, cache, cachedToolsOf(spec.serverName));
      const fingerprint = directToolFingerprint(spec) + JSON.stringify(fields);
      if (registeredDeferredTools.get(spec.name) === fingerprint) continue;
      registerDirectTool(spec, config, fields, spec.name, false);
      finalizationGuard?.();
      registeredDeferredTools.set(spec.name, fingerprint);
    }
    const removed = [...registeredDeferredTools.keys()].filter((name) => !nextNames.has(name));
    for (const name of removed) registeredDeferredTools.delete(name);
    // A direct tool registered under a removed name this sync owns it now.
    deactivateTools(removed.filter((name) => !registeredDirectTools.has(name)));

    registeredToolNames.clear();
    for (const spec of directSpecs) registeredToolNames.set(deferredToolKey(spec.serverName, spec.originalName, spec.resourceUri), spec.prefixedName);
    for (const spec of specs) registeredToolNames.set(deferredToolKey(spec.serverName, spec.originalName, spec.resourceUri), spec.name);
    // The servers this sync covered, so a call that reaches another one registers it first.
    syncedServers.clear();
    if (!deferredRegistryLive) return;
    for (const [serverName, definition] of Object.entries(config.mcpServers)) {
      const entry = cache?.servers[serverName];
      if (entry && isServerCacheValid(entry, definition)) syncedServers.add(serverName);
    }
  }

  /** The Pi tool name a cached MCP tool or resource tool is registered under, direct or deferred. */
  function registeredDeferredName(serverName: string, originalName: string, resourceUri?: string): string | undefined {
    return registeredToolNames.get(deferredToolKey(serverName, originalName, resourceUri));
  }

  /** Re-syncs the tool surface from cached metadata; never connects, and a frozen surface stays frozen. */
  async function ensureDeferredRegistered(serverName: string): Promise<void> {
    if (directToolsFrozen || !state?.config.mcpServers[serverName]) return;
    syncToolSurface();
  }

  // The nested leg resolves the canonical name, an exact match by construction.
  type InProxyCall = (serverName: string, canonicalTool: string, args: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<AgentToolResult<Record<string, unknown>>>;

  /**
   * Pi 0.99+: hands a proxy call to its registered tool through ctx.executeTool, so Pi's hooks and
   * permission extensions see the real tool. The registered tool runs the call as the proxy would,
   * so results, approval (once, origin "proxy") and output limits are unchanged.
   */
  function createProxyHandOff(ctx: unknown, toolCallId: string, runInProxy: InProxyCall): NestedCallHandOff | undefined {
    if (!deferredRegistryLive || typeof (ctx as { executeTool?: unknown } | undefined)?.executeTool !== "function") return undefined;
    const toolCtx = ctx as ExtensionToolContext;
    return async ({ serverName, toolMeta, args, callIdentity }) => {
      let name = registeredDeferredName(serverName, toolMeta.originalName, toolMeta.resourceUri);
      if (name === undefined) {
        await ensureDeferredRegistered(serverName);
        name = registeredDeferredName(serverName, toolMeta.originalName, toolMeta.resourceUri);
      }
      // A frozen surface registers nothing new; the proxy still reaches tools it knows.
      if (name === undefined && directToolsFrozen) return undefined;
      if (name === undefined) {
        const message = `MCP tool "${toolMeta.originalName}" on server "${serverName}" has no registered Pi tool.`;
        return { content: [{ type: "text" as const, text: message }], details: { mode: "call", error: "tool_not_registered", ...callIdentity, message } };
      }
      // Pi calls only active direct tools; one the host deactivated keeps today's proxy path.
      const registered = name;
      if (!toolCtx.tools.some((tool) => tool.name === registered)) return undefined;
      let thrown: { error: unknown } | undefined;
      const handOff = {
        name: registered,
        consumed: false,
        run: async (params: Record<string, unknown>, signal: AbortSignal | undefined) => {
          try {
            return await runInProxy(serverName, toolMeta.name, params, signal);
          } catch (error) {
            thrown = { error };
            throw error;
          }
        },
      };
      pendingProxyHandOffs.set(toolCallId, handOff);
      let outcome: Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
      try {
        outcome = await toolCtx.executeTool(registered, args ?? {});
      } finally {
        pendingProxyHandOffs.delete(toolCallId);
      }
      // Pi turns a throw into an error result; the proxy throws, as it did in-proxy.
      if (thrown) throw thrown.error;
      const details = outcome.result.details as Record<string, unknown> | undefined;
      if (handOff.consumed) return { content: outcome.result.content, details: details ?? {} };
      // Blocked by a tool_call hook or rejected before the tool ran.
      return { content: outcome.result.content, details: { mode: "call", error: "nested_call_failed", ...callIdentity } };
    };
  }

  // The proxy hand-off a nested call `<proxy call id>/<n>` to `name` runs, consumed once.
  function takeProxyHandOff(toolCallId: string, name: string): ((params: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<AgentToolResult<Record<string, unknown>>>) | undefined {
    const handOff = pendingProxyHandOffs.get(toolCallId.slice(0, Math.max(0, toolCallId.lastIndexOf("/"))));
    if (!handOff || handOff.consumed || handOff.name !== name) return undefined;
    handOff.consumed = true;
    return handOff.run;
  }

  function applyDirectToolConfigChanges(changes: Map<string, true | string[] | false | "search">): void {
    if (!state) return;
    for (const [serverName, value] of changes) {
      const definition = state.config.mcpServers[serverName];
      if (!definition) continue;
      state.config.mcpServers[serverName] = { ...definition, directTools: value };
    }
  }

  function syncToolSurface(ctx?: ExtensionContext): void {
    const notificationGeneration = lifecycleGeneration;
    const notificationOwner = currentOwner;
    const config = state?.config ?? earlyConfig;
    const cache = withSessionMetadata(loadMetadataCache(), config, state?.sessionMetadata);
    const result = syncDirectTools(config, cache);
    syncDeferredTools(config, cache, result.reservedDirectNames, result.specs);
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
    if (ctx && state) deliverScriptToolIssues(ctx, scriptToolIssuesOf(state));
  }

  // Shows each script-tool issue once per session, whichever sync found it.
  function deliverScriptToolIssues(ctx: ExtensionContext, issues: readonly string[]): void {
    for (const issue of issues) {
      if (deliveredScriptToolIssues.has(issue)) continue;
      deliveredScriptToolIssues.add(issue);
      if (ctx.hasUI) callReentrant(() => ctx.ui.notify(issue, "warning"));
      else console.warn(`MCP: ${issue}`);
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
    /** The script-tool issues of the config files read for this snapshot. */
    scriptToolIssues: string[];
  } | undefined {
    let config: McpConfig;
    if (programmaticConfig) {
      config = resolveConfiguredClaudePluginMcp(cloneMcpConfig(sessionConfig), cwd ?? process.cwd());
    } else {
      const loadedConfig = loadMcpConfig(earlyConfigPath, cwd);
      // Project servers and script tools require the authoritative session trust context.
      if (hasProjectServerDefinitions(loadedConfig) || hasProjectScriptToolDefinitions(loadedConfig)) return undefined;
      config = loadedConfig;
    }
    const cache = loadMetadataCache();
    const enabledServers = Object.values(config.mcpServers).filter((definition) => !isServerDisabled(definition));
    if (enabledServers.some((definition) => definition.lifecycle === "eager" || definition.lifecycle === "keep-alive")) return undefined;
    if (envRaw !== undefined && envRaw !== "__none__"
      && getMissingConfiguredDirectToolServers(config, cache, envDirectToolOverride).length > 0) return undefined;
    if (config.settings?.deferWithMissingMetadata !== true
      && (cache === null || hasEnabledServerWithoutValidMetadata(config, cache))) return undefined;
    if (envRaw !== "__none__" && hasExecutorWithoutCatalog(config, cache)) return undefined;
    return { config, cache, enabledServerCount: enabledServers.length, scriptToolIssues: programmaticConfig ? sessionScriptToolIssues : loadedScriptToolIssues(config) };
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
      registeredFingerprints: namespaceProxyFingerprints,
      unavailableServers: activeFailureServers(),
      fallbackDeactivatedNames: fallbackDeactivatedTools,
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
      createHandOff: createProxyHandOff,
      reachesTools: deferSearchTools,
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
  // A Pi registration the adapter hasn't applied yet, such as one made during load, came first.
  const registerAdapterServer = (name: string, definition: ServerEntry): McpServerRegistration => {
    if (piSupportsMcp(pi) && !piServers.has(name) && pi.getMcpServers().some((server) => server.name === name)) {
      throw new Error(`MCP server "${name}" is already registered`);
    }
    const registration = registerRuntimeServer(name, definition);
    return {
      dispose: async (): Promise<void> => {
        try {
          await registration.dispose();
        } finally {
          // A Pi registration this one overrode takes the freed name, unless a configured server holds it.
          // The name is freed before closing, so this runs even when closing fails.
          const activeState = state;
          const ctx = sessionCtx;
          if (activeState && ctx && piServers.get(name)?.registration === null
            && !Object.hasOwn(activeState.config.mcpServers, name)) {
            piServers.delete(name);
            await callReentrant(() => applyPiMcpServers(activeState, ctx));
          }
        }
      },
    };
  };
  runtimeRegistrars.set(pi, registerAdapterServer);
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
      request.result = { ok: true, registration: registerAdapterServer(request.name, request.definition) };
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
  pi.events.on(MCP_RUNTIME_TOOL_CALL_EVENT, (rawRequest: unknown) => {
    if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) return;
    const request = rawRequest as McpRuntimeToolCallRequest;
    if (request.result !== undefined) return;
    const ctx = sessionCtx;
    request.result = (async (): Promise<McpRuntimeToolCallResult> => {
      try {
        if (request.version !== MCP_RUNTIME_TOOL_CALL_VERSION) {
          throw new Error(`Unsupported MCP runtime tool-call version: ${String(request.version)}`);
        }
        if (typeof request.tool !== "string" || request.tool.trim() === "") {
          throw new Error("MCP runtime tool-call requires a non-empty `tool` name");
        }
        if (!ctx) throw new Error("MCP runtime tool calls require an active Pi session");
        const callState = await awaitWithTimeout(ensureSessionRuntime(ctx), INIT_WAIT_TIMEOUT_MS);
        if (callState === INIT_WAIT_TIMED_OUT) {
          throw new Error(`MCP initialization is still in progress after ${INIT_WAIT_TIMEOUT_MS}ms`);
        }
        if (!callState) throw new Error("MCP is not initialized");
        const guard = captureRuntimeGuard(callState);
        const { executeCall } = await loadForRuntime(loadProxyModes, guard);
        const result = await executeCall(callState, request.tool, request.args, request.server, getPiTools, undefined, "script");
        assertRuntimeGuard(guard);
        // Denials and tool errors resolve with details.error rather than rejecting.
        const failure = result.details?.error;
        if (failure !== undefined) return { ok: false, error: new Error(`MCP tool call failed: ${String(failure)}`) };
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    })();
  });

  registerProtocolBridge(pi, async name => {
    if (!sessionCtx) throw new Error("MCP connections require an active Pi session");
    const target = await ensureSessionRuntime(sessionCtx);
    if (!target) throw new Error("MCP is not initialized");
    const guard = captureRuntimeGuard(target);
    const definition = target.config.mcpServers[name];
    if (!Object.hasOwn(target.config.mcpServers, name) || !definition || isServerDisabled(definition)) {
      throw new Error("MCP server is not configured or enabled");
    }
    const core = await loadForRuntime(loadCoreRuntime, guard);
    if (!await core.lazyConnect(target, name, target.owner.signal)) throw new Error("MCP server could not connect; check /mcp-adapter");
    assertRuntimeGuard(guard);
    if (target.config.mcpServers[name] !== definition || isServerDisabled(definition)) {
      throw new Error("MCP server configuration changed while connecting");
    }
    const connection = target.manager.getConnection(name);
    if (!connection || connection.status !== "connected") throw new Error("MCP connection is unavailable");
    return { connection, signal: target.owner.signal };
  });

  // Compares registrations with the active session's config, so it runs only once state exists.
  function applyPiMcpServers(activeState: McpExtensionState, ctx: ExtensionContext): Promise<void> {
    const next = new Map(piRegistered.map((server) => [server.name, JSON.stringify(server.config)]));
    const disposals: Promise<void>[] = [];
    for (const [name, applied] of piServers) {
      if (next.get(name) === applied.config) continue;
      piServers.delete(name);
      // Removes the server synchronously, so a re-registration below can take the name.
      if (applied.registration) disposals.push(applied.registration.dispose());
    }
    const report = (message: string) => ctx.hasUI ? ctx.ui.notify(message, "warning") : console.warn(`MCP: ${message}`);
    const configured = activeState.config.mcpServers;
    for (const { name, config, extensionPath } of piRegistered) {
      if (piServers.has(name)) continue;
      const label = `MCP server "${name}" registered by ${extensionPath}`;
      const translated = translatePiMcpServer(name, config);
      let registration: McpServerRegistration | null = null;
      if (typeof translated === "string") {
        report(`${label} is not connected: ${translated}.`);
      } else if (Object.hasOwn(configured, name) && configured[name] !== runtimeServers.get(name)?.entry) {
        report(`${label} is overridden by the configured server of the same name.`);
      } else if (runtimeServers.has(name)) {
        report(`${label} is overridden by the server registered earlier with pi-mcp-adapter's registerMcpServer().`);
      } else {
        // Runtime servers are proxy-only, so exposure settings that map to direct tools don't apply.
        const { directTools, ...entry } = translated.entry;
        const ignored = [
          ...translated.ignored,
          ...(Array.isArray(directTools)
            ? directTools.map((tool) => `toolExposure ${JSON.stringify(tool)}: direct`)
            : directTools !== undefined ? [`exposure: ${config.exposure}`] : []),
        ];
        if (ignored.length > 0) report(`${label}: ignored settings ${ignored.join(", ")}.`);
        registration = registerRuntimeServer(name, entry);
      }
      piServers.set(name, { config: JSON.stringify(config), registration });
    }
    return Promise.all(disposals).then(() => undefined);
  }

  if (piSupportsMcp(pi)) {
    // Registered in the factory so Pi sees a handler; session_start reads earlier registrations.
    pi.on("mcp_servers_change", async (event, ctx) => {
      piRegistered = event.servers;
      if (state) await applyPiMcpServers(state, ctx);
    });
  }

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });
  pi.registerFlag("mcp-project-servers", {
    description: "Set to \"allow\" to start unapproved project MCP servers in a trusted project without asking, for this process only",
    type: "string",
  });

  function startInitialization(
    ctx: ExtensionContext,
    owner: McpRuntimeOwner,
    generation: number,
    staleReason: string,
    excludeProjectServers = false,
  ): Promise<void> {
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
      owner.addCleanup(() => cleanupMaterializedBinaryResources(owner.signal));
      assertRuntimeGuard(guard);
      const initialization = core.initializeMcp(pi, ctx, owner, {
        ...(programmaticConfig || options.configPath !== undefined
          ? {
              ...(earlyConfigPath !== undefined ? { configPath: earlyConfigPath } : {}),
              ...(sessionConfig !== undefined ? { config: sessionConfig } : {}),
            }
          : {}),
        oauthRuntime,
        excludeProjectServers,
        // Pi awaits session_start handlers in order. Returning before the approval
        // dialog settles lets /reload or a later extension replace the editor and
        // orphan the dialog, leaving initialization pending forever.
        onProjectTrustResolved: markStarted,
      });
      assertRuntimeGuard(guard);
      return initialization;
    })().finally(markStarted);
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
      nextState.migrationNotices = [...sessionMigrationNotices];
      if (nextState.scriptToolLoadIssues) sessionScriptToolIssues = nextState.scriptToolLoadIssues;
      nextState.scriptToolIssues = scriptToolIssuesOf(nextState);
      // initializeMcp already warned about each project script tool that trust blocked.
      for (const [name, block] of nextState.blockedScriptTools ?? []) deliveredScriptToolIssues.add(describeBlockedScriptTool(name, block));
      nextState.deliversToScript = deliversToScript;
      nextState.listScriptTools = gatewayScriptTools;
      finalizationGuard = guard;
      finalizationRegistrations = registeredDuringFinalization;
      try {
        guard();
        // Re-read after asynchronous startup so navigation during initialization
        // cannot restore a stale branch.
        callReentrant(() => restoreCurrentSessionApprovals(nextState));
        // Pi registrations are compared with each session's config again, below.
        for (const { registration } of piServers.values()) void registration?.dispose();
        piServers.clear();
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
        void callReentrant(() => applyPiMcpServers(nextState, ctx));
        guard();
        nextState.onToolMetadataUpdated = (_serverName, _reason) => {
          if (state !== nextState || !owner.isActive()) return;
          if (envRaw !== "__none__") coreRuntime?.refreshExecutorCatalog(nextState, _serverName, _reason);
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
        // Startup connects ran before the hook above was set.
        if (envRaw !== "__none__") {
          for (const name of Object.keys(nextState.config.mcpServers)) coreRuntime?.refreshExecutorCatalog(nextState, name);
        }
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
          // Routine initialization must not write over Pi's interactive editor.
          logger.debug("MCP: direct tools frozen after initial sync — metadata can refresh without rebuilding the active tool surface");
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
            registeredDeferredTools.delete(name);
          }
          for (const [key, name] of registeredToolNames) {
            if (registeredDuringFinalization.has(name)) registeredToolNames.delete(key);
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
      } as unknown as ExtensionContext, owner, generation, "stale_load_time_initialization", true);
    });
  }

  pi.on("resources_discover", (event) => {
    const resourceConfig = programmaticConfig
      ? cloneMcpConfig(sessionConfig)
      : loadMcpConfig(earlyConfigPath, event.cwd);
    const skillPaths = discoverConfiguredClaudePluginSkills(resourceConfig, event.cwd);
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = null;
    sessionMigrationNotices = programmaticConfig
      ? []
      : getLegacyMcpMigrationNotices(ctx.cwd, earlyConfigPath);
    // A config file's issues arrive with the session's config load: the deferred snapshot or initialization.
    sessionScriptToolIssues = programmaticConfig ? supplied?.issues ?? [] : [];
    deliveredScriptToolIssues = new Set(sessionScriptToolIssues);
    if (ctx.hasUI) {
      for (const notice of [...sessionMigrationNotices, ...sessionScriptToolIssues]) ctx.ui.notify(notice, "warning");
    } else {
      for (const issue of sessionScriptToolIssues) console.warn(`MCP: ${issue}`);
    }
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
    // Registrations made while extensions loaded; initialization applies them.
    if (piSupportsMcp(pi)) piRegistered = pi.getMcpServers();

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
    // An explicit config path marks a one-off process; Pi already skips its built-in for it because /mcp is ours.
    if (!programmaticConfig && earlyConfigPath === undefined && piSupportsMcp(pi)) {
      const report = (message: string, level: "info" | "warning") => {
        if (generation !== lifecycleGeneration || !owner.isActive()) return;
        if (ctx.hasUI) ctx.ui.notify(message, level);
        else console.error(message);
      };
      void import("./pi-builtin-mcp.ts")
        .then(({ turnOffPiBuiltinMcp }) => turnOffPiBuiltinMcp())
        .then((turnedOff) => {
          if (turnedOff) report("Turned off Pi's built-in MCP so it doesn't run next to pi-mcp-adapter. If you remove the adapter, turn it back on in `pi config` → Built-in.", "info");
        })
        .catch((error) => report(`MCP: could not turn off Pi's built-in MCP: ${formatTerminalError(error)}`, "warning"));
    }
    // Before any connection, so an imported sign-in is used from the first connect.
    if (ctx.hasUI && !programmaticConfig && piSupportsMcp(pi) && existsSync(getPiMcpAuthPath())) {
      try {
        const { offerPiSignInImports } = await import("./pi-signin-import.ts");
        await offerPiSignInImports(ctx, excludeProjectServersAtLoadTime(loadMcpConfig(earlyConfigPath, ctx.cwd)), owner.signal);
      } catch (error) {
        console.error(`MCP: could not offer Pi sign-in import: ${formatTerminalError(error)}`);
      }
      if (generation !== lifecycleGeneration || !owner.isActive()) return;
    }
    // Recorded only after previous-session cleanup, so a runtime tool call cannot
    // start initialization before session_start decides whether to defer it.
    sessionCtx = ctx;
    if (state) return;

    if (!initPromise) {
      const deferredSnapshot = getDeferredSessionSnapshot(ctx.cwd);
      if (deferredSnapshot) {
        const { config, cache, enabledServerCount } = deferredSnapshot;
        sessionScriptToolIssues = deferredSnapshot.scriptToolIssues;
        const directResult = syncDirectTools(config, cache);
        syncDeferredTools(config, cache, directResult.reservedDirectNames, directResult.specs);
        deliverScriptToolIssues(ctx, [...sessionScriptToolIssues, ...scriptToolSurfaceIssues]);
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
    sessionCtx = null;
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
  pi.on("tool_result", (event) => {
    return toolErrorOverride(event.details);
  });

  // Pi 1.2+ `reachesTools` by tool name: refilled from pi.getAllTools() only for a name it does not know,
  // so a tool call costs a map lookup.
  const toolReaches = new Map<string, ((input: unknown) => unknown) | undefined>();

  function reachOf(toolName: string, input: unknown): "all" | string[] | undefined {
    if (registeredDirectTools.has(toolName) || registeredDeferredTools.has(toolName)) return undefined;
    // The proxies connect and register on their own, so their first-call errors stay as they are.
    if (toolName === "mcp" || registeredNamespaceProxyTools.has(toolName)) return undefined;
    if (!toolReaches.has(toolName)) {
      toolReaches.clear();
      for (const tool of pi.getAllTools()) {
        const reaches = (tool as { reachesTools?: unknown }).reachesTools;
        toolReaches.set(tool.name, typeof reaches === "function" ? reaches as (input: unknown) => unknown : undefined);
      }
      if (!toolReaches.has(toolName)) toolReaches.set(toolName, undefined);
    }
    const reach = toolReaches.get(toolName)?.(input);
    if (reach === "all") return reach;
    return Array.isArray(reach) && reach.every((word) => typeof word === "string") ? reach : undefined;
  }

  // Pi's codemode names tools by words of the script, so `mcp__docs` and `mcp__docs__find` reach docs.
  function reachesServer(reach: "all" | string[], serverName: string): boolean {
    if (reach === "all") return true;
    const namespace = namespaceProxyName(serverName);
    return reach.some((word) => word === namespace || word.startsWith(`${namespace}__`));
  }

  async function waitBounded(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
    // An abort listener added after the abort never fires.
    if (signal?.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolveWait) => {
        timer = setTimeout(resolveWait, LATE_REGISTRATION_WAIT_MS);
        onAbort = resolveWait;
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }

  /**
   * Registers the servers a call reaches before it runs. "all" only awaits connections already in
   * flight; a reach that names servers connects every unregistered one it names, first starting the
   * session runtime if a deferred session has none yet. Failures are recorded by the connect and
   * reported by the call itself.
   */
  async function registerReachedServers(reach: "all" | string[], signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<void> {
    if (signal?.aborted) return;
    let targetState = state;
    if (!targetState) {
      // A deferred session has no runtime until its first MCP operation, so naming a server with no
      // registered tools starts it, as the proxy's first call does. "all" never starts every server.
      const namesPending = reach !== "all" && Object.entries(earlyConfig.mcpServers)
        .some(([serverName, definition]) => !isServerDisabled(definition) && !syncedServers.has(serverName) && reachesServer(reach, serverName));
      const initialization = namesPending ? ensureSessionRuntime(ctx) : initPromise;
      if (!initialization) return;
      await waitBounded(initialization, signal);
      if (!namesPending || !state) {
        // The session initialization just produced, if it finished within the wait.
        if (!directToolsFrozen && state) syncToolSurface();
        return;
      }
      targetState = state;
    }
    const runtimeState = targetState;
    const pending = Object.entries(runtimeState.config.mcpServers)
      .filter(([serverName, definition]) => !isServerDisabled(definition) && !syncedServers.has(serverName) && reachesServer(reach, serverName))
      .map(([serverName]) => serverName);
    if (pending.length === 0) return;
    const { lazyConnect } = await loadForRuntime(loadCoreRuntime, captureRuntimeGuard(runtimeState));
    const connecting = reach === "all"
      ? pending.filter((serverName) => runtimeState.manager.isConnecting(serverName))
      : pending;
    if (connecting.length === 0) return;
    let connected = false;
    await waitBounded(Promise.all(connecting.map(async (serverName) => {
      if (await lazyConnect(runtimeState, serverName, signal)) connected = true;
    })), signal);
    // A failed connect has nothing new to register, so an unreachable server costs no re-sync.
    if (connected && !directToolsFrozen && state === runtimeState) syncToolSurface();
  }

  // Pi tells a nested call only its parent's id, not which tool that is, so the tool_call handler
  // below records each call until its tool_execution_end, which Pi emits for every call, blocked or
  // run, so the record holds only calls still running. Without that handler (MCP_DIRECT_TOOLS=__none__,
  // or Pi before 0.99) nothing is recorded and every result keeps the output guard.
  const toolCallsById = new Map<string, { name: string; parent: string | undefined }>();
  const MAX_CALL_DEPTH = 64;

  /**
   * A call's result goes to a script, not the model, when a tool other than the adapter's proxies
   * (`mcp`, `mcp__<server>`) called it, directly or through them: Pi's codemode or another
   * extension's tool. A proxy's hand-off leg is asked with the proxy's own id.
   */
  function deliversToScript(toolCallId: string | undefined): boolean {
    let call = toolCallId === undefined ? undefined : toolCallsById.get(toolCallId);
    for (let depth = 0; call?.parent !== undefined && depth < MAX_CALL_DEPTH; depth++) {
      const parent = toolCallsById.get(call.parent);
      if (!parent || parent === call) return false;
      if (parent.name !== "mcp" && !registeredNamespaceProxyTools.has(parent.name)) return true;
      call = parent;
    }
    return false;
  }

  /**
   * Whether a tool other than the model or the adapter's proxies called `toolCallId`, for script tools.
   * Pi forms every nested call id as `<parent>/<n>`; under MCP_DIRECT_TOOLS=__none__ there is no caller
   * record, so the id shape is the only signal. That holds for a call whose record is already gone too.
   */
  function calledByAnotherTool(toolCallId: string): boolean {
    return toolCallsById.has(toolCallId) ? deliversToScript(toolCallId) : toolCallId.includes("/");
  }

  if (deferredRegistryLive) pi.on("agent_end", () => toolCallsById.clear());
  if (deferredRegistryLive) pi.on("tool_execution_end", (event) => { toolCallsById.delete(event.toolCallId); });

  // A call that may reach other tools (Pi's codemode and tool_search, other extensions) first registers what it reaches.
  // Registered only when deferred tools are, since Pi runs its tool_call pipeline for every call once a handler exists.
  if (deferredRegistryLive) pi.on("tool_call", async (event, ctx) => {
    toolCallsById.set(event.toolCallId, { name: event.toolName, parent: event.parentToolCallId });
    if (directToolsFrozen) return;
    try {
      const reach = reachOf(event.toolName, event.input);
      if (reach !== undefined) await registerReachedServers(reach, ctx.signal, ctx);
    } catch (error) {
      logger.debug(`MCP: could not register the servers ${event.toolName} reaches: ${formatTerminalError(error)}`);
    }
  });

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
            commandCtx.ui?.notify("Usage: /mcp-adapter jev setup", "error");
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
            commandCtx.ui?.notify("Usage: /mcp-adapter edit [project|global]", "error");
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
            if (commandCtx.hasUI) commandCtx.ui?.notify("Usage: /mcp-adapter logout <server>", "error");
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
            if (commandCtx.hasUI) commandCtx.ui?.notify("Usage: /mcp-adapter token set|remove|status <server>", "error");
            return;
          }
          if (!serverName) {
            if (commandCtx.hasUI) commandCtx.ui?.notify("Usage: /mcp-adapter token set|remove|status <server>", "error");
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
            commandCtx.ui?.notify(`/mcp-adapter ${subcommand} is unavailable when config is supplied by createMcpAdapter().`, "info");
            break;
          }
          if (!serverName) {
            commandCtx.ui?.notify(`Usage: /mcp-adapter ${subcommand} <server>`, "error");
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
          await commands.showStatus(state, commandCtx);
          break;
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
  registerMcpCommand("mcp-adapter");
  // /mcp at load replaces Pi 0.99+'s built-in MCP; a supplied config doesn't read Pi's files, so it keeps the built-in.
  if (!programmaticConfig || !piSupportsMcp(pi)) registerMcpCommand("mcp");
  // Opt-in `mcp.panel.open` keys open the panel without touching the editor draft.
  // Shortcut handlers get no reload(), so dispatch the command: its context has one.
  if (!programmaticConfig) {
    for (const key of readPanelOpenKeys(getAgentPath("keybindings.json"))) {
      pi.registerShortcut(key, {
        description: "Open the MCP panel",
        handler: () => pi.sendUserMessage("/mcp-adapter", { expandPromptTemplates: true }),
      });
    }
  }

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
    ctx: ExtensionContext,
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
    if (target === "project" && isExclusiveConfigMode()
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

    if (target === "project") {
      const trusted = ctx.isProjectTrusted();
      const allowed = trusted && (ctx.hasUI
        ? await ctx.ui.confirm(
            `Install project MCP server “${serverName}”?`,
            `Endpoint: ${normalized.url}\n\nThis project server can make network requests with your user permissions.`,
          )
        : targetState.config.settings?.projectServers === "allow");
      if (!allowed) {
        return {
          content: [{ type: "text" as const, text: trusted
            ? `Project MCP server "${serverName}" requires interactive approval or user-global settings.projectServers: "allow".`
            : `Project MCP server "${serverName}" is blocked because the project is not trusted.` }],
          details: { mode: "install", error: "project_trust_required", server: serverName },
        };
      }
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
      if (target === "project" && targetState.blockedProjectServers !== undefined) {
        const effective = loadMcpConfig(earlyConfigPath, cwd).mcpServers[serverName] ?? persistedEntry;
        approveProjectServer(cwd, serverName, effective);
      }
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

  /**
   * `mcp({ action: "save-script" })`: shows the operator the save, then the script in an editor, and
   * writes only what they approve. Every refusal before the dialogs asks nothing and writes nothing.
   */
  async function executeSaveScript(
    targetState: McpExtensionState,
    args: Record<string, unknown> | undefined,
    topLevelTarget: string | undefined,
    toolCallId: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<Record<string, unknown>>> {
    const saveOwner = currentOwner;
    const throwIfStopped = () => {
      signal?.throwIfAborted();
      saveOwner?.throwIfInactive();
    };
    throwIfStopped();
    const { target: argsTarget, ...saveArgs } = args ?? {};
    const requestedName = typeof saveArgs.name === "string" ? saveArgs.name : undefined;
    const result = (text: string, details: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text }],
      details: { mode: "save-script", ...(requestedName !== undefined ? { name: requestedName } : {}), ...details },
    });
    if (programmaticConfig) {
      return result("Saving a script tool is unavailable when the adapter uses programmatic configuration.", { error: "programmatic_config" });
    }
    if (targetState.config.settings?.allowScriptToolSave === false) {
      return result("Saving script tools is disabled by configuration.", { error: "save_disabled" });
    }
    // Before Pi 0.99 no script tool loads, so a save would write files that never become a tool.
    if (!deferSearchTools) {
      return result("Saving a script tool needs Pi 0.99.0 or later, which runs script tools. Nothing was written.", { error: "unsupported_pi" });
    }
    // An args.target that is present but not a string is refused, not replaced by the top-level one.
    const target = argsTarget !== undefined ? argsTarget : topLevelTarget ?? "global";
    if (target !== "global" && target !== "project") {
      return result("Script tool save target must be 'global' or 'project'.", { error: "invalid_target" });
    }
    if (target === "project" && isExclusiveConfigMode()
      && resolve(getProjectPiConfigPath(ctx.cwd)) !== resolve(getPiGlobalConfigPath(earlyConfigPath))) {
      return result("Saving to the project config is unavailable in exclusive config mode; use the global target.", { error: "inactive_target" });
    }
    if (calledByAnotherTool(toolCallId)) {
      return result('Saving a script tool cannot be requested from inside another tool. Call mcp({ action: "save-script" }) directly.', { error: "nested_save" });
    }
    const saveGuard = captureRuntimeGuard(targetState);
    const core = await loadForRuntime(loadCoreRuntime, saveGuard);
    // An RPC client has a UI too, but the operator must read the diff and the script, so only the TUI asks.
    if (!core.isTuiMode(ctx)) {
      return result(`Saving a script tool needs an interactive terminal session, because it writes files only after you approve them. This session is ${ctx.mode}.`, { error: "headless" });
    }
    if (target === "project" && !ctx.isProjectTrusted()) {
      return result("Saving to the project config needs project trust. Trust this project and try again.", { error: "project_trust_required" });
    }
    const checked = checkScriptToolSave({
      args: saveArgs, target, cwd: ctx.cwd, ...(earlyConfigPath !== undefined ? { configOverridePath: earlyConfigPath } : {}),
      scriptTools: targetState.config.scriptTools,
      // Only a project config can shadow a global save, and nothing shadows a project save.
      projectScriptTools: target === "global" ? loadMcpConfigWithSources(earlyConfigPath, ctx.cwd).projectScriptTools : undefined,
    });
    if (!checked.ok) {
      return result(checked.message, {
        error: checked.error,
        ...(checked.shadowedBy ? { shadowedBy: checked.shadowedBy } : {}),
        ...(checked.reason !== undefined ? { message: checked.reason } : {}),
      });
    }
    const { name, scriptPath, configPath } = checked;
    const toolName = `${SCRIPT_TOOL_NAMESPACE}__${name}`;
    // Checked against the live surface: another extension can register a name after the last sync.
    const reservations = scriptToolReservations(targetState.config, new Set(registeredDirectTools.keys()), foreignToolNames());
    const unavailable = scriptToolNameConflict(name, reservations, deferredNameOwners);
    if (unavailable) return result(`Cannot save script tool "${name}": ${toolName} ${unavailable}.`, { error: "name_unavailable" });

    const failed = (error: unknown, text: (message: string) => string) => {
      const message = error instanceof Error ? error.message : String(error);
      return result(text(message), { error: "script_save_failed", message });
    };
    const summary = buildScriptToolSavePrompt(checked);
    const declined = () => result("The save was declined, so nothing was written.", { error: "declined" });
    // Deny first, so a stray Enter declines.
    const choice = await ctx.ui.select(summary, ["Don't save", "Review the script"], signal ? { signal } : {});
    throwIfStopped();
    if (choice !== "Review the script") return declined();
    const code = await ctx.ui.editor(`Review the script for ${toolName} (${scriptPath}). Saving writes the script and its config entry; Escape writes nothing.`, checked.code);
    throwIfStopped();
    if (code === undefined) return declined();
    const codeRefusal = checkScriptToolCode(name, code);
    if (codeRefusal) return result(codeRefusal.message, { error: codeRefusal.error });
    const approvedButFailed = (message: string) => `The script tool was approved, but could not be saved: ${message}`;
    let changed: string | undefined;
    try {
      await withFileMutationQueue(configPath, async () => {
        throwIfStopped();
        // The operator approved the files as the summary showed them.
        changed = scriptToolSaveChange(checked);
        if (changed === undefined) writeScriptToolSave({ ...checked, code });
      });
    } catch (error) {
      if (signal?.aborted || (saveOwner && !saveOwner.isActive())) throw error;
      return failed(error, approvedButFailed);
    }
    if (changed !== undefined) return failed(changed, approvedButFailed);

    const entry = { ...checked.entry, file: scriptPath };
    if (target === "project" && targetState.blockedScriptTools !== undefined) {
      // The approval is keyed on the entry as the loader returns it.
      approveProjectScriptTool(ctx.cwd, name, loadMcpConfig(earlyConfigPath, ctx.cwd).scriptTools?.[name] ?? entry);
    }
    targetState.blockedScriptTools?.delete(name);
    targetState.config.scriptTools = { ...targetState.config.scriptTools, [name]: entry };
    // The files are written: only a stale session or an abort makes that a failure, as for install.
    let syncFailure: string | undefined;
    if (!directToolsFrozen) {
      try {
        syncToolSurface(ctx);
      } catch (error) {
        if (isRuntimeGuardStale(saveGuard) || isAbortError(error, saveGuard.owner?.signal)) throw error;
        syncFailure = error instanceof Error ? error.message : String(error);
        logger.warn(`MCP: saved script tool "${name}" but could not refresh the tool surface: ${syncFailure}`);
      }
    }
    const registered = syncFailure === undefined && deferredRegistryLive && !directToolsFrozen && registeredScriptSpecs.has(toolName);
    const lines = [savedScriptToolText(name, toolName, registered, syncFailure)];
    const edited = code !== checked.code;
    if (edited) lines.push("The operator edited the script before saving, so the saved code differs from the code you sent.");
    lines.push(`Script: ${scriptPath}`, `Config: ${configPath}`);
    return result(lines.join("\n"), { tool: toolName, path: configPath, scriptPath, target, registered, edited });
  }

  // How the model reaches a script tool it just saved.
  function savedScriptToolText(name: string, toolName: string, registered: boolean, syncFailure: string | undefined): string {
    if (registered) return `Saved script tool "${name}". Call it as ${toolName} or mcp({ tool: "${name}", args }).`;
    if (!deferredRegistryLive) return `Saved script tool "${name}". This session registers no script tools, so call it with mcp({ tool: "${name}", args }).`;
    if (directToolsFrozen) return `Saved script tool "${name}". The tool surface is frozen in this session, so it is callable after /reload.`;
    if (syncFailure !== undefined) {
      return `Saved script tool "${name}", but the tool surface could not be refreshed (${syncFailure}), so it is callable after /reload.`;
    }
    const issue = scriptToolSurfaceIssues.find((text) => text.startsWith(`Script tool "${name}" was not loaded`));
    return `Saved script tool "${name}", but it is not registered in this session. ${issue ?? `${toolName} was left out of the tool surface.`}`;
  }

  function registerProxyTool(description: string, allowScriptToolSave: boolean): void {
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
        action: Type.Optional(Type.String({ description: allowScriptToolSave
          ? "Action: 'install', 'ui-messages', 'auth-start', 'auth-complete', or 'save-script'"
          : "Action: 'install', 'ui-messages', 'auth-start', or 'auth-complete'" })),
        url: Type.Optional(Type.String({ description: "MCP endpoint URL for action: 'install'" })),
        target: Type.Optional(Type.String({ description: "Install target: 'global' (default) or 'project'" })),
      }),
      renderResult: renderMcpToolResult,
      ...reachesAllTools,
      async execute(toolCallId: string, params: {
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
          return executeInstall(proxyState, params.url, params.server, params.target, _ctx.cwd, _ctx, signal);
        }
        if (params.action === "ui-messages") {
          return proxyModes.executeUiMessages(proxyState);
        }
        if (params.action === "save-script") {
          return executeSaveScript(proxyState, parsedArgs, params.target, toolCallId, _ctx, signal);
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
          // A script tool wins over an MCP tool of the same name; mcp({ tool, server }) reaches the MCP one.
          const scriptTool = params.server === undefined ? findScriptTool(gatewayScriptTools(), params.tool) : undefined;
          if (scriptTool) {
            const mcpMatch = proxyModes.resolveDescribeTarget(proxyState, params.tool);
            const shadowed = "error" in mcpMatch ? undefined : { server: mcpMatch.server, tool: params.tool };
            const result = await callScriptToolFromGateway(scriptTool, parsedArgs ?? {}, toolCallId, signal, _onUpdate, _ctx, shadowed);
            assertRuntimeGuard(proxyGuard);
            return result;
          }
          const handOff = createProxyHandOff(_ctx, toolCallId, (server, canonicalTool, args, nestedSignal) =>
            proxyModes.executeCall(proxyState, canonicalTool, args, server, getPiTools, nestedSignal, undefined, undefined, toolCallId));
          const result = await proxyModes.executeCall(proxyState, params.tool, parsedArgs, params.server, getPiTools, signal, undefined, undefined, toolCallId, handOff);
          assertRuntimeGuard(proxyGuard);
          if (lazyDirectTools.size === 0) return result;
          // A successful proxy call is as clear a signal as a search hit: the
          // model wants this tool. Activate it the same additive way, keyed on
          // the registered (prefixed) name the call reports as canonicalTool.
          // Failed calls (lookup, approval, tool errors) carry details.error
          // and activate nothing.
          const identity = result.details as { error?: unknown; server?: unknown; canonicalTool?: unknown } | undefined;
          if (!identity || identity.error !== undefined || typeof identity.server !== "string" || typeof identity.canonicalTool !== "string") return result;
          holdLazyToolsInactive();
          const added = activateSearchMatches([{ server: identity.server, tool: identity.canonicalTool }]);
          if (added.length === 0) return result;
          // Content is returned untouched: the call's output is already sized to
          // the output limits and is what a compact view previews. The tool
          // description tells the model a called tool is direct from then on.
          return { ...result, details: { ...(result.details ?? {}), activated: added }, addedToolNames: added };
        }
        if (params.connect) {
          return connectAndReport(proxyState, params.connect, signal, _ctx as ExtensionContext);
        }
        if (params.describe) {
          const result = await proxyModes.executeGuardedDescribe(proxyState, params.describe, params.server, signal);
          assertRuntimeGuard(proxyGuard);
          return result;
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
    // Search-mode tools are registered INACTIVE and the `mcp` gateway (search, or a
    // proxy call) is their only activation entry point, so dropping it strands them: every tool held, nothing
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
        registerProxyTool(description, config.settings?.allowScriptToolSave !== false);
        finalizationGuard?.();
      }
      const activeTools = getActiveToolsIfReady();
      if (activeTools?.includes("mcp")) {
        // Observed host reactivation ends our fallback ownership. A later
        // host removal must not be mistaken for our own deactivation.
        fallbackDeactivatedTools.delete("mcp");
      } else if (activeTools && fallbackDeactivatedTools.delete("mcp")) {
        // Only undo a fallback deactivation that the adapter still owns.
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
  syncDeferredTools(earlyConfig, earlyCache, initialDirectResult.reservedDirectNames, initialDirectResult.specs);
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
