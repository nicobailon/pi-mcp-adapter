import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpAdapterOptions, McpConfig, PromptMetadata, ServerEntry } from "./types.ts";
import type { McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { showStatus, showTools, showPrompts, reconnectServer, reconnectServers, authenticateServer, logoutServer, manageBearerToken, openMcpAuthPanel, openMcpPanel, openMcpSetup } from "./commands.ts";
import { cloneMcpConfig, loadMcpConfig, writeProjectServerDisabledOverride } from "./config.ts";
import { buildProxyDescription, createDirectToolExecutor, getMissingConfiguredDirectToolServers, prepareDirectToolArguments, resolveDirectTools } from "./direct-tools.ts";
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";
import { loadMetadataCache, parseDirectToolSelectors, type MetadataCache } from "./metadata-cache.ts";
import { createPromptCommand, resolveCachedPrompts } from "./prompts.ts";
import { logger } from "./logger.ts";
import { executeAuthComplete, executeAuthStart, executeCall, executeConnect, executeDescribe, executeInstructions, executeList, executeSearch, executeStatus, executeUiMessages } from "./proxy-modes.ts";
import { formatTerminalError, getConfigPathFromArgv, normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";
import { createOAuthRuntime, shutdownOAuth } from "./mcp-auth-flow.ts";
import { createMcpDirectToolCallRenderer, createMcpProxyToolCallRenderer, createMcpScriptToolCallRenderer, createMcpToolResultRenderer, resolveMcpToolRenderOptions } from "./tool-result-renderer.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { createMcpRuntimeOwner, createOwnedUi, isAbortError, type McpRuntimeOwner } from "./runtime-owner.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";
import { runMcpScript } from "./mcp-code.ts";
import { cleanupMaterializedBinaryResources } from "./tool-registrar.ts";
import { syncNamespaceProxyTools } from "./namespace-tools.ts";

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

const INIT_WAIT_TIMEOUT_MS = 30_000;
const INIT_FAILURE_MESSAGE_MAX_CHARS = 1_000;
const INIT_WAIT_TIMED_OUT: unique symbol = Symbol("init-wait-timed-out");

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
  let currentOwner: McpRuntimeOwner | null = null;
  let currentOAuthRuntime: McpOAuthRuntime | null = null;
  let lifecycleGeneration = 0;
  let retainedInitFailure: string | null = null;

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

  function startGatewayRetryInitialization(ctx: ExtensionContext): void {
    const generation = ++lifecycleGeneration;
    const owner = createMcpRuntimeOwner();
    const oauthRuntime = createOAuthRuntime(owner.signal);
    currentOwner = owner;
    currentOAuthRuntime = oauthRuntime;
    state = null;
    startInitialization(ctx, owner, oauthRuntime, generation, "stale_gateway_retry_initialization");
  }

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) {
      publishMcpStatusShutdown(pi.events);
      return;
    }

    publishMcpStatusShutdown(currentState.statusEvents);

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

  const earlyConfigPath = programmaticConfig
    ? undefined
    : options.configPath ?? getConfigPathFromArgv();
  const earlyConfig = programmaticConfig
    ? cloneMcpConfig(sessionConfig)
    : loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const envDirectToolOverride = parseEnvDirectToolOverride(envRaw);
  const namespaceEnvOverride = resolveNamespaceEnvOverride(envRaw, envDirectToolOverride);
  const registeredDirectTools = new Map<string, string>();
  const registeredNamespaceProxyTools = new Set<string>();
  const fallbackDeactivatedTools = new Set<string>();
  const toolRenderOptions = resolveMcpToolRenderOptions(earlyConfig.settings);
  const toolRenderShell = toolRenderOptions.resultRendering === "compact" ? "self" : "default";
  const renderMcpToolResult = createMcpToolResultRenderer(toolRenderOptions);
  let proxyToolRegistered = false;
  let proxyToolDescription: string | null = null;
  let directToolsFrozen = false;
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
    });
  }

  function registerDirectTool(spec: DirectToolSpec, config: McpConfig): void {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: toToolParameters(normalizeDirectToolInputSchema(spec.inputSchema)),
      ...(config.settings?.strictDirectToolArguments === true
        ? { prepareArguments: (args: unknown) => prepareDirectToolArguments(spec.inputSchema, args) }
        : {}),
      execute: createDirectToolExecutor(() => state, () => initPromise, spec),
      renderShell: toolRenderShell,
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName, toolRenderOptions),
      renderResult: renderMcpToolResult,
    });
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
      return pi.getActiveTools?.();
    } catch (error) {
      if (error instanceof Error
        && error.message.includes("Action methods cannot be called during extension loading")) return undefined;
      throw error;
    }
  }

  function deactivateTools(toolNames: string[]): string[] {
    if (toolNames.length === 0) return [];
    const unregisterTool = (pi as ExtensionAPI & { unregisterTool?: (name: string) => boolean }).unregisterTool;
    const unregistered = toolNames.filter((toolName) => unregisterTool?.(toolName) === true);
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
      pi.setActiveTools(nextActiveTools);
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
        registerDirectTool(spec, config);
        registeredDirectTools.set(spec.prefixedName, fingerprint);
        if (fallbackDeactivatedTools.delete(spec.prefixedName)) {
          const activeTools = getActiveToolsIfReady();
          if (activeTools && !activeTools.includes(spec.prefixedName)) {
            pi.setActiveTools([...activeTools, spec.prefixedName]);
          }
        }
        (previous ? updated : added).push(spec.prefixedName);
      }
    }

    for (const toolName of [...registeredDirectTools.keys()]) {
      if (nextNames.has(toolName)) continue;
      registeredDirectTools.delete(toolName);
      deactivated.push(toolName);
    }

    deactivateTools(deactivated);
    return { specs, reservedDirectNames, activeDirectNames: nextNames, added, updated, deactivated };
  }

  function applyDirectToolConfigChanges(changes: Map<string, true | string[] | false>): void {
    if (!state) return;
    for (const [serverName, value] of changes) {
      const definition = state.config.mcpServers[serverName];
      if (!definition) continue;
      state.config.mcpServers[serverName] = { ...definition, directTools: value };
    }
  }

  function syncToolSurface(ctx?: ExtensionContext): void {
    const config = state?.config ?? earlyConfig;
    const cache = loadMetadataCache();
    const result = syncDirectTools(config, cache);
    syncProxyTool(config, cache, result.specs);
    syncNamespaceTools(config, cache, result.reservedDirectNames, result.activeDirectNames);
    const changed = result.added.length + result.updated.length + result.deactivated.length;
    if (changed > 0 && ctx?.hasUI) {
      ctx.ui.notify(
        `MCP: direct tools refreshed (+${result.added.length}, ~${result.updated.length}, -${result.deactivated.length})`,
        "info",
      );
    }
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
      getPiTools: () => pi.getAllTools(),
      renderOptions: toolRenderOptions,
      renderShell: toolRenderShell,
      renderResult: renderMcpToolResult,
    });
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
      registeredPromptCommands.add(spec.commandName);
      pi.registerCommand(spec.commandName, createPromptCommand(pi, () => state, spec));
    }
  }

  function syncPromptCommands(): void {
    registerPromptCommands([...(state?.promptMetadata?.values() ?? [])].flat());
  }

  registerPromptCommands(resolveCachedPrompts(earlyConfig));

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
      updateStatusBar(registeredState);
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
        await currentState.manager.close(name);
        syncToolSurface();
        updateStatusBar(currentState);
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

  function startInitialization(ctx: ExtensionContext, owner: McpRuntimeOwner, oauthRuntime: McpOAuthRuntime, generation: number, staleReason: string): Promise<void> {
    owner.addCleanup(() => cleanupMaterializedBinaryResources(owner.signal));
    const promise = initializeMcp(pi, ctx, owner, {
      ...(programmaticConfig || options.configPath !== undefined
        ? {
            ...(earlyConfigPath !== undefined ? { configPath: earlyConfigPath } : {}),
            ...(sessionConfig !== undefined ? { config: sessionConfig } : {}),
          }
        : {}),
      oauthRuntime,
    });
    initPromise = promise;

    return promise.then(async (nextState) => {
      if (!owner.isActive() || generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, staleReason);
        } catch (error) {
          console.error(`MCP: failed to clean stale initialization state: ${formatTerminalError(error)}`);
        }
        return;
      }

      state = nextState;
      clearRetainedInitFailure();
      for (const [name, { entry }] of runtimeServers) {
        if (Object.hasOwn(nextState.config.mcpServers, name)) {
          console.error(`MCP: runtime-registered server "${name}" now collides with a configured server; keeping the configured server`);
          continue;
        }
        nextState.config.mcpServers[name] = entry;
        attachRuntimeServerLifecycle(nextState, name, entry);
      }
      nextState.onToolMetadataUpdated = (_serverName, _reason) => {
        if (state !== nextState || !owner.isActive()) return;
        syncPromptCommands();
        if (directToolsFrozen) {
          logger.debug(`MCP: metadata update for ${_serverName} (${_reason}) skipped — directTools frozen`);
          return;
        }
        syncToolSurface(ctx);
      };
      syncPromptCommands();
      syncToolSurface(ctx);
      // A connected snapshot is readiness-like external state. Publish it only
      // after Pi's model-facing direct-tool surface reflects live metadata.
      nextState.statusEvents = pi.events;
      updateStatusBar(nextState);
      initPromise = null;
      if (earlyConfig.settings?.freezeDirectTools === true) {
        directToolsFrozen = true;
        logger.info("MCP: direct tools frozen after initial sync — reconnects won't rebuild the system prompt; use mcp({ connect: \"server\" }) to rediscover");
      }
    }).catch(async err => {
      if (!owner.isActive() || generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      const message = retainInitFailure(err);
      console.error(`MCP initialization failed: ${message}`);
      initPromise = null;
      if (state) return;

      try {
        await Promise.all([
          owner.stop("MCP initialization failed"),
          shutdownOAuth(oauthRuntime),
        ]);
      } catch (error) {
        console.error(`MCP: failed to clean rejected initialization: ${formatTerminalError(error)}`);
      }
    });
  }

  function startLoadTimeInitialization(): void {
    const hasStartupServer = Object.values(earlyConfig.mcpServers).some((definition) => {
      if (definition.disabled === true) return false;
      return definition.lifecycle === "eager" || definition.lifecycle === "keep-alive";
    });
    if (!hasStartupServer) return;
    setImmediate(() => {
      if (lifecycleGeneration !== 0 || state || initPromise) return;
      const generation = ++lifecycleGeneration;
      const owner = createMcpRuntimeOwner();
      const oauthRuntime = createOAuthRuntime(owner.signal);
      currentOwner = owner;
      currentOAuthRuntime = oauthRuntime;
      startInitialization({
        mode: "print",
        hasUI: false,
        cwd: process.cwd(),
        model: undefined,
        modelRegistry: undefined,
        signal: undefined,
      } as unknown as ExtensionContext, owner, oauthRuntime, generation, "stale_load_time_initialization");
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    const previousOwner = currentOwner;
    const previousOAuthRuntime = currentOAuthRuntime;
    const owner = createMcpRuntimeOwner();
    const oauthRuntime = createOAuthRuntime(owner.signal);
    currentOwner = owner;
    currentOAuthRuntime = oauthRuntime;
    state = null;
    initPromise = null;
    clearRetainedInitFailure();

    // Abort synchronously before awaiting cleanup so old callbacks and startup
    // work cannot resume into a stale ExtensionContext.
    const stopPrevious = previousOwner?.stop("MCP extension session restarted") ?? Promise.resolve();
    try {
      await Promise.all([
        stopPrevious,
        shutdownState(previousState, "session_restart"),
        previousOAuthRuntime ? shutdownOAuth(previousOAuthRuntime) : Promise.resolve(),
      ]);
    } catch (error) {
      console.error(`MCP: failed to shut down previous session state: ${formatTerminalError(error)}`);
    }

    if (generation !== lifecycleGeneration || !owner.isActive()) return;

    const initialization = startInitialization(ctx, owner, oauthRuntime, generation, "stale_session_start");
    if (envRaw !== undefined && envRaw !== "__none__") {
      const missingEnvDirectTools = getMissingConfiguredDirectToolServers(
        earlyConfig,
        loadMetadataCache(),
        envDirectToolOverride,
      );
      if (missingEnvDirectTools.length > 0) {
        await initialization;
      }
    }
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
    clearRetainedInitFailure();

    // Abort before awaiting cleanup so delayed initialization cannot touch stale
    // Pi context after session shutdown.
    const stopOwner = owner?.stop("MCP extension session shutdown") ?? Promise.resolve();
    try {
      await Promise.all([
        stopOwner,
        shutdownState(currentState, "session_shutdown"),
        oauthRuntime ? shutdownOAuth(oauthRuntime) : Promise.resolve(),
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
          { value: "logout", label: "logout — Clear server credentials" },
          { value: "token", label: "token — Manage stored bearer tokens" },
          { value: "disable", label: "disable — Disable a server" },
          { value: "enable", label: "enable — Enable a server" },
          { value: "status", label: "status — Show server status" },
        ].filter(({ value }) => value.startsWith(normalized));
        return subcommands.length > 0 ? subcommands : null;
      }

      const [, subcommand, argumentPrefix] = argumentMatch;
      if (
        (subcommand !== "reconnect" && subcommand !== "logout" && subcommand !== "disable" && subcommand !== "enable" && subcommand !== "token")
        || argumentPrefix === undefined
        || !state
      ) return null;

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
        const servers = Object.keys(state.config.mcpServers)
          .filter(serverName => serverName.startsWith(serverPrefix.trimStart()))
          .map(serverName => ({ value: `token ${action} ${serverName}`, label: serverName }));
        return servers.length > 0 ? servers : null;
      }

      const servers = Object.keys(state.config.mcpServers)
        .filter((serverName) => serverName.startsWith(argumentPrefix.trimStart()))
        .map((serverName) => ({ value: `${subcommand} ${serverName}`, label: serverName }));
      return servers.length > 0 ? servers : null;
    },
    handler: async (args, ctx) => {
      const commandOwner = currentOwner;
      const commandReload = typeof ctx.reload === "function" ? ctx.reload.bind(ctx) : async () => {};
      const commandHasUI = ctx.hasUI;
      const commandCtx = {
        hasUI: commandHasUI,
        ui: commandHasUI
          ? commandOwner ? createOwnedUi(ctx.ui, commandOwner) : ctx.ui
          : undefined,
        cwd: ctx.cwd,
        mode: ctx.mode,
        signal: commandOwner?.signal ?? ctx.signal,
      } as unknown as ExtensionContext;
      if (!state && initPromise) {
        try {
          const initialized = await initPromise;
          commandOwner?.throwIfInactive();
          state = initialized;
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

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          commandOwner?.throwIfInactive();
          await reconnectServers(state, commandCtx, targetServer);
          if (directToolsFrozen) syncToolSurface(commandCtx);
          break;
        case "tools":
          await showTools(state, commandCtx);
          break;
        case "prompts":
          await showPrompts(state, commandCtx);
          break;
        case "setup": {
          commandOwner?.throwIfInactive();
          if (programmaticConfig) {
            commandCtx.ui?.notify("MCP setup is unavailable when config is supplied by createMcpAdapter().", "info");
            break;
          }
          const result = await openMcpSetup(state, pi, commandCtx, earlyConfigPath, "setup");
          if (result?.configChanged) {
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
          await logoutServer(serverName, state, commandCtx);
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
          await manageBearerToken(action, serverName, state, commandCtx);
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
              await showStatus(state, commandCtx);
              break;
            }
            const result = await openMcpPanel(state, pi, commandCtx, earlyConfigPath, (changes) => {
              applyDirectToolConfigChanges(changes);
              syncToolSurface(commandCtx);
            });
            if (result?.configChanged) {
              commandOwner?.throwIfInactive();
              await commandReload();
              return;
            }
          } else {
            await showStatus(state, commandCtx);
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
      const commandOwner = currentOwner;
      const commandHasUI = ctx.hasUI;
      const commandCtx = {
        hasUI: commandHasUI,
        ui: commandHasUI
          ? commandOwner ? createOwnedUi(ctx.ui, commandOwner) : ctx.ui
          : undefined,
        cwd: ctx.cwd,
        mode: ctx.mode,
        signal: commandOwner?.signal ?? ctx.signal,
      } as unknown as ExtensionContext;
      const serverName = args?.trim();
      if (!serverName && !commandCtx.hasUI) {
        return;
      }

      if (!state && initPromise) {
        try {
          const initialized = await initPromise;
          commandOwner?.throwIfInactive();
          state = initialized;
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

      if (!serverName) {
        if (programmaticConfig) {
          commandCtx.ui?.notify("Use /mcp-auth <server> to authenticate a server from the in-memory SDK config.", "info");
          return;
        }
        await openMcpAuthPanel(state, pi, commandCtx, earlyConfigPath);
        return;
      }

      const result = await authenticateServer(serverName, state.config, commandCtx, commandCtx.signal, state.oauthRuntime);
      if (result.ok) {
        commandOwner?.throwIfInactive();
        await reconnectServer(state, commandCtx, serverName);
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
      async execute(_toolCallId: string, params: { code: string; timeoutMs?: number }, signal: AbortSignal | undefined) {
        const executeOwner = currentOwner;
        if (!state && initPromise) {
          try {
            const initialized = await awaitWithTimeout(initPromise, INIT_WAIT_TIMEOUT_MS);
            if (initialized === INIT_WAIT_TIMED_OUT) {
              return {
                content: [{ type: "text" as const, text: "MCP initialization is still in progress. Try again shortly." }],
                details: { mode: "script", error: "init_timeout", timeoutMs: INIT_WAIT_TIMEOUT_MS },
              };
            }
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
        return runMcpScript(state, params.code, params.timeoutMs, getPiTools, signal);
      },
    });
  }

  function registerProxyTool(description: string): void {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description,
      promptSnippet: "MCP gateway — status, search, describe, auth, and single MCP tool calls",
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
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        limit: optionalNumber({ minimum: 1, description: "Maximum search results to return (default: 12)" }),
        offset: optionalNumber({ minimum: 0, description: "Search result offset (default: 0)" }),
        server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
        action: Type.Optional(Type.String({ description: "Action: 'ui-messages', 'auth-start', or 'auth-complete'" })),
      }),
      renderResult: renderMcpToolResult,
      async execute(_toolCallId: string, params: {
        tool?: string;
        args?: string | Record<string, unknown>;
        connect?: string;
        describe?: string;
        instructions?: string;
        search?: string;
        regex?: boolean;
        includeSchemas?: boolean;
        limit?: number;
        offset?: number;
        server?: string;
        action?: string;
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
          || value.action !== undefined;
        if (!hasGatewayMode(params) && params.args !== undefined) {
          throw new Error("Gateway params were nested inside `args`; pass them top-level (for example, mcp({ search: \"...\" }) or mcp({ tool: \"...\", args: {} })).");
        }

        if (!state && !initPromise && retainedInitFailure) {
          startGatewayRetryInitialization(_ctx);
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

        if (params.action === "ui-messages") {
          return executeUiMessages(state);
        }
        if (params.action === "auth-start") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
              details: { mode: "auth-start", error: "missing_server" },
            };
          }
          return signal
            ? executeAuthStart(state, params.server, signal)
            : executeAuthStart(state, params.server);
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
            ? executeAuthComplete(state, params.server, input, signal)
            : executeAuthComplete(state, params.server, input);
        }
        if (params.tool) {
          return executeCall(state, params.tool, parsedArgs, params.server, getPiTools, signal);
        }
        if (params.connect) {
          const result = await executeConnect(state, params.connect, signal);
          syncToolSurface(_ctx as ExtensionContext);
          return result;
        }
        if (params.describe) {
          return executeDescribe(state, params.describe);
        }
        if (params.instructions) {
          return executeInstructions(state, params.instructions);
        }
        if (params.search !== undefined) {
          return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas, params.limit, params.offset);
        }
        if (params.server) {
          return executeList(state, params.server);
        }
        return executeStatus(state);
      },
    });
    proxyToolRegistered = true;
    proxyToolDescription = description;
  }

  function syncProxyTool(config: McpConfig, cache: MetadataCache | null, directSpecs: DirectToolSpec[]): void {
    const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(
      config,
      cache,
      envRaw === undefined || envRaw === "__none__" ? undefined : envDirectToolOverride,
    );
    const shouldRegisterProxyTool =
      config.settings?.disableProxyTool !== true
      || directSpecs.length === 0
      || missingConfiguredDirectToolServers.length > 0;

    if (shouldRegisterProxyTool) {
      const description = buildProxyDescription(config);
      if (!proxyToolRegistered || proxyToolDescription !== description) {
        registerProxyTool(description);
        return;
      }
      const activeTools = getActiveToolsIfReady();
      if (activeTools && !activeTools.includes("mcp")) {
        pi.setActiveTools([...activeTools, "mcp"]);
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
  const factoryConfig = options.config !== undefined ? cloneMcpConfig(options.config) : undefined;
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
