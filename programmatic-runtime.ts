import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServerManager } from "./server-manager.ts";
import type { ServerDefinition } from "./types.ts";
import type {
  McpConfigSource,
  McpDiagnostic,
  McpInitialSource,
  McpLaunchValueProvider,
  McpLaunchValues,
  McpProgrammaticRuntime,
  McpRuntimeCapabilities,
  McpRuntimeLease,
  McpRuntimeLeaseProvider,
  McpRuntimeServerBinding,
  McpSourceIdentity,
  McpSourceRemoveResult,
  McpSourceReplaceRequest,
  McpSourceReplaceResult,
  McpSourceServer,
  McpSourceServerStatus,
  McpSourceStatus,
  McpSourceValidationResult,
} from "./programmatic-types.ts";

const INVALID_SOURCE = "SOURCE_INVALID";
const ADAPTER_FAILED = "ADAPTER_FAILED";
const CANCELLED = "MCP_LAUNCH_CANCELLED";
const CLEANUP_FAILED = "MCP_LAUNCH_CLEANUP_FAILED";
const SOURCE_DIGEST_PREFIX = "mcp-programmatic-source-v1\0";

interface ProgrammaticConnection {
  client: {
    callTool(
      params: { name: string; arguments?: Record<string, unknown> },
      resultSchema?: unknown,
      options?: RequestOptions,
    ): Promise<CallToolResult>;
  };
  tools: readonly { name: string; description?: string; inputSchema?: unknown }[];
  status: "connected" | "closed" | "needs-auth";
}

type ServerRuntimeStatus = {
  state: McpSourceServerStatus["state"];
  toolCount?: number;
  errorCode?: string;
};

type ExecutionState = {
  controller: AbortController;
  lease: McpRuntimeLease;
  closed: boolean;
};

type SourceRecord = {
  source: McpConfigSource;
  sourceDigest: string;
  launchValues: McpLaunchValueProvider;
  runtimeLeases: McpRuntimeLeaseProvider;
  serverStatus: Map<string, ServerRuntimeStatus>;
  executions: Set<ExecutionState>;
};

export interface ProgrammaticExecution {
  readonly connection: ProgrammaticConnection;
  readonly signal: AbortSignal;
  close(signal?: AbortSignal): Promise<void>;
}

class ProgrammaticMcpError extends Error {
  constructor(readonly code: string) {
    super("MCP programmatic runtime operation failed");
    this.name = "ProgrammaticMcpError";
  }
}

const textEncoder = new TextEncoder();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new TypeError("invalid string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("invalid number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("not JSON");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort(compareUtf8).map((key) => {
    if (hasLoneSurrogate(key)) throw new TypeError("invalid key");
    return `${JSON.stringify(key)}:${canonicalJson(object[key])}`;
  }).join(",")}}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !hasLoneSurrogate(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function identityIsValid(identity: unknown): identity is McpSourceIdentity {
  return isRecord(identity) && hasOnlyKeys(identity, ["id", "revision"]) &&
    isNonEmptyString(identity.id) && isNonEmptyString(identity.revision);
}

function stringListIsValid(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) &&
    new Set(value).size === value.length;
}

function serverIsValid(server: unknown): server is McpSourceServer {
  return isRecord(server) && hasOnlyKeys(server, [
    "transport", "requestTimeoutMs", "allowedTools", "deniedTools",
  ]) && (server.transport === "stdio" || server.transport === "streamable-http") &&
    (server.requestTimeoutMs === undefined ||
      typeof server.requestTimeoutMs === "number" && Number.isFinite(server.requestTimeoutMs) &&
      server.requestTimeoutMs > 0) &&
    (server.allowedTools === undefined || stringListIsValid(server.allowedTools)) &&
    (server.deniedTools === undefined || stringListIsValid(server.deniedTools));
}

function sourceIsValid(source: unknown): source is McpConfigSource {
  if (!isRecord(source) || !hasOnlyKeys(source, ["identity", "servers"]) ||
      !identityIsValid(source.identity) || !isRecord(source.servers) ||
      Object.keys(source.servers).length === 0) return false;
  return Object.entries(source.servers)
    .every(([key, server]) => isNonEmptyString(key) && serverIsValid(server));
}

function sourceDigest(source: McpConfigSource): string {
  const bytes = `${SOURCE_DIGEST_PREFIX}${canonicalJson(source)}`;
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function launchValuesAreValid(values: unknown, transport: McpSourceServer["transport"]): values is McpLaunchValues {
  if (!isRecord(values) || values.transport !== transport) return false;
  if (transport === "stdio") {
    return hasOnlyKeys(values, ["transport", "command", "args", "cwd", "env"]) &&
      isNonEmptyString(values.command) && !values.command.includes("\0") && Array.isArray(values.args) &&
      values.args.every((value) => typeof value === "string" &&
        !hasLoneSurrogate(value) && !value.includes("\0")) &&
      (values.cwd === undefined || typeof values.cwd === "string" && !values.cwd.includes("\0")) &&
      (values.env === undefined || isRecord(values.env) &&
        Object.entries(values.env).every(([key, value]) =>
          isNonEmptyString(key) && !/[=\0]/.test(key) && typeof value === "string" &&
          !hasLoneSurrogate(value) && !value.includes("\0")));
  }
  if (!hasOnlyKeys(values, ["transport", "url", "headers", "bearerToken"]) ||
      !isNonEmptyString(values.url) || /[\u0000-\u001f\u007f]/.test(values.url) ||
      (values.headers !== undefined && (!isRecord(values.headers) ||
        Object.entries(values.headers).some(([key, value]) =>
          !isNonEmptyString(key) || /[\r\n\0]/.test(key) ||
          typeof value !== "string" || /[\r\n\0]/.test(value)))) ||
      (values.bearerToken !== undefined &&
        (typeof values.bearerToken !== "string" || /[\r\n\0]/.test(values.bearerToken)))) return false;
  try {
    const url = new URL(values.url);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function launchProviderIsValid(provider: unknown): provider is McpLaunchValueProvider {
  return isRecord(provider) && typeof provider.resolve === "function" &&
    typeof provider.dispose === "function";
}

function leaseProviderIsValid(provider: unknown): provider is McpRuntimeLeaseProvider {
  return isRecord(provider) && typeof provider.acquire === "function" &&
    typeof provider.release === "function" && typeof provider.drain === "function";
}

const NO_RUNTIME_LEASES: McpRuntimeLeaseProvider = Object.freeze({
  async acquire() { return Object.freeze({}); },
  async release() {},
  async drain() {},
});

function providersAreValid(request: McpSourceReplaceRequest | McpInitialSource): boolean {
  return launchProviderIsValid(request.launchValues) &&
    (request.runtimeLeases === undefined || leaseProviderIsValid(request.runtimeLeases));
}

function invalidDiagnostic(operation: string, code = INVALID_SOURCE): McpDiagnostic {
  return {
    code,
    severity: "error",
    operation,
    message: "MCP source operation was rejected",
    details: { sourceOperation: operation },
  };
}

function ownerKey(identity: McpSourceIdentity): string {
  return identity.id;
}

function exactIdentityKey(identity: McpSourceIdentity): string {
  return canonicalJson(identity);
}

function qualifiedServerKey(identity: McpSourceIdentity, serverKey: string): string {
  return `programmatic:${createHash("sha256")
    .update(`${exactIdentityKey(identity)}\0${serverKey}`)
    .digest("hex")}`;
}

function copyIdentity(identity: McpSourceIdentity): McpSourceIdentity {
  return cloneJson(identity);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function statusFor(record: SourceRecord): McpSourceStatus {
  return {
    identity: copyIdentity(record.source.identity),
    sourceDigest: record.sourceDigest,
    state: "registered",
    servers: Object.entries(record.source.servers)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, server]) => {
        const runtime = record.serverStatus.get(key) ?? { state: "registered" as const };
        return {
          key,
          transport: server.transport,
          state: runtime.state,
          ...(runtime.toolCount === undefined ? {} : { toolCount: runtime.toolCount }),
          ...(runtime.errorCode === undefined ? {} : { errorCode: runtime.errorCode }),
        };
      }),
  };
}

function serverDefinition(server: McpSourceServer, values: McpLaunchValues): ServerDefinition {
  const common: ServerDefinition = {
    requestTimeoutMs: server.requestTimeoutMs,
    exposeResources: false,
    excludeTools: [...(server.deniedTools ?? [])],
    auth: values.transport === "streamable-http" && values.bearerToken !== undefined
      ? "bearer"
      : false,
  };
  if (values.transport === "stdio") {
    return {
      ...common,
      command: values.command,
      args: [...values.args],
      ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
      ...(values.env === undefined ? {} : { env: { ...values.env } }),
    };
  }
  return {
    ...common,
    url: values.url,
    ...(values.headers === undefined ? {} : { headers: { ...values.headers } }),
    ...(values.bearerToken === undefined ? {} : { bearerToken: values.bearerToken }),
  };
}

function retainedDefinition(server: McpSourceServer): ServerDefinition {
  return {
    requestTimeoutMs: server.requestTimeoutMs,
    exposeResources: false,
    excludeTools: [...(server.deniedTools ?? [])],
  };
}

/**
 * Source authority used by the public factory and its Pi extension. The class
 * itself is package-internal; callers receive the narrow lifecycle interface.
 */
export class ProgrammaticMcpRuntime implements McpProgrammaticRuntime {
  private readonly records = new Map<string, SourceRecord>();
  private manager: McpServerManager | undefined;
  private context: ExtensionContext | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(readonly options: { readonly fileDiscovery: "enabled" | "disabled" }) {
    // Initial registration is deliberately synchronous. The returned extension
    // cannot register a tool until every source has been validated and stored.
  }

  installInitialSources(initialSources: readonly McpInitialSource[]): void {
    for (const initial of initialSources) {
      if (!sourceIsValid(initial.source) || !providersAreValid(initial)) {
        throw new ProgrammaticMcpError(INVALID_SOURCE);
      }
      const source = cloneJson(initial.source);
      const key = ownerKey(source.identity);
      if (this.records.has(key)) throw new ProgrammaticMcpError(INVALID_SOURCE);
      this.records.set(key, this.createRecord(source, initial.launchValues, initial.runtimeLeases));
    }
  }

  private createRecord(
    source: McpConfigSource,
    launchValues: McpLaunchValueProvider,
    runtimeLeases?: McpRuntimeLeaseProvider,
  ): SourceRecord {
    return {
      source,
      sourceDigest: sourceDigest(source),
      launchValues,
      runtimeLeases: runtimeLeases ?? NO_RUNTIME_LEASES,
      serverStatus: new Map(Object.keys(source.servers)
        .map((key) => [key, { state: "registered" as const }])),
      executions: new Set(),
    };
  }

  async attachSession(context: ExtensionContext): Promise<void> {
    if (this.manager !== undefined) await this.detachSession();
    this.context = context;
    const manager = new McpServerManager(context.cwd);
    manager.setSamplingConfig(context.hasUI ? {
      autoApprove: false,
      ui: context.ui,
      modelRegistry: context.modelRegistry,
      getCurrentModel: () => context.model,
      getSignal: () => context.signal,
    } : undefined);
    manager.setElicitationConfig(context.hasUI ? {
      ui: context.ui,
      allowUrl: context.mode === "tui",
    } : undefined);
    this.manager = manager;
    for (const record of this.records.values()) {
      for (const key of Object.keys(record.source.servers)) {
        record.serverStatus.set(key, { state: "registered" });
      }
    }
  }

  async detachSession(): Promise<void> {
    const manager = this.manager;
    this.manager = undefined;
    this.context = undefined;
    for (const record of this.records.values()) {
      for (const execution of [...record.executions]) execution.controller.abort(new ProgrammaticMcpError(CANCELLED));
      await this.closeExecutions(record);
      for (const key of Object.keys(record.source.servers)) {
        record.serverStatus.set(key, { state: "registered" });
      }
    }
    if (manager !== undefined) await manager.closeAll();
  }

  async capabilities(signal: AbortSignal): Promise<McpRuntimeCapabilities> {
    throwIfAborted(signal);
    const context = this.context;
    return {
      sourceLifecycle: {
        initialSourcesBeforeToolRegistration: true,
        isolatedFileDiscovery: true,
        localValidation: true,
        atomicReplace: true,
        exactRemove: true,
        inspect: true,
        cancellable: true,
        lateLaunchValues: true,
        runtimeLeases: true,
      },
      transports: {
        stdio: true,
        streamableHttp: true,
        legacySse: false,
        websocket: false,
      },
      oauth: {
        authorizationCode: false,
        clientCredentials: false,
      },
      features: {
        sampling: context?.hasUI === true,
        elicitationForm: context?.hasUI === true,
        elicitationUrl: context?.hasUI === true && context.mode === "tui",
        toolApproval: false,
        resources: false,
        directTools: false,
      },
    };
  }

  async validateSource(
    source: McpConfigSource,
    signal: AbortSignal,
  ): Promise<McpSourceValidationResult> {
    throwIfAborted(signal);
    if (!sourceIsValid(source)) {
      return { ok: false, diagnostics: [invalidDiagnostic("validateMcpSource")] };
    }
    const copy = cloneJson(source);
    throwIfAborted(signal);
    return { ok: true, value: copy, diagnostics: [] };
  }

  private async exclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    throwIfAborted(signal);
    const previous = this.operationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.operationTail = previous.catch(() => undefined).then(() => gate);
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        previous.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
      throwIfAborted(signal);
      return await operation();
    } finally {
      // An operation cancelled while queued must still release its queue slot.
      release();
    }
  }

  async replaceSource(
    request: McpSourceReplaceRequest,
    signal: AbortSignal,
  ): Promise<McpSourceReplaceResult> {
    return this.exclusive(signal, async () => {
      const validation = await this.validateSource(request.source, signal);
      if (!validation.ok) return { kind: "rejected", diagnostics: validation.diagnostics };
      const expectedValid = isRecord(request.expected) &&
        (request.expected.kind === "absent" && hasOnlyKeys(request.expected, ["kind"]) ||
          request.expected.kind === "exact" && hasOnlyKeys(request.expected, ["kind", "identity"]) &&
          identityIsValid(request.expected.identity));
      if (!providersAreValid(request) || !expectedValid) {
        return { kind: "rejected", diagnostics: [invalidDiagnostic("replaceMcpSource")] };
      }

      const source = validation.value;
      const key = ownerKey(source.identity);
      const previous = this.records.get(key);
      const expectedMatches = request.expected.kind === "absent"
        ? previous === undefined
        : previous !== undefined &&
          exactIdentityKey(previous.source.identity) === exactIdentityKey(request.expected.identity);
      if (!expectedMatches) {
        if (previous !== undefined) {
          return { kind: "stale", currentIdentity: copyIdentity(previous.source.identity) };
        }
        return { kind: "rejected", diagnostics: [invalidDiagnostic("replaceMcpSource")] };
      }

      const replacement = this.createRecord(
        cloneJson(source),
        request.launchValues,
        request.runtimeLeases,
      );
      if (previous !== undefined) {
        try {
          await this.closeRecord(previous, signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          return { kind: "rejected", diagnostics: [invalidDiagnostic("replaceMcpSource", CLEANUP_FAILED)] };
        }
      }
      // Cleanup is the commit threshold. Once the old runtime authority has
      // drained, publish the complete replacement even if cancellation arrives
      // concurrently; this avoids exposing a half-reconciled source.
      this.records.set(key, replacement);
      return {
        kind: "applied",
        status: statusFor(replacement),
        ...(previous === undefined ? {} : {
          previousIdentity: copyIdentity(previous.source.identity),
        }),
      };
    });
  }

  async removeSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceRemoveResult> {
    return this.exclusive(signal, async () => {
      if (!identityIsValid(identity)) throw new ProgrammaticMcpError(INVALID_SOURCE);
      const requested = cloneJson(identity);
      const key = ownerKey(requested);
      const current = this.records.get(key);
      if (current === undefined) return { kind: "absent" };
      if (exactIdentityKey(current.source.identity) !== exactIdentityKey(requested)) {
        return {
          kind: "ownership-mismatch",
          requestedIdentity: requested,
          currentIdentity: copyIdentity(current.source.identity),
        };
      }
      await this.closeRecord(current, signal);
      // As with replacement, exact removal commits after cleanup has drained.
      this.records.delete(key);
      return { kind: "removed" };
    });
  }

  async inspectSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceStatus | undefined> {
    throwIfAborted(signal);
    if (!identityIsValid(identity)) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const record = this.records.get(ownerKey(identity));
    if (record === undefined || exactIdentityKey(record.source.identity) !== exactIdentityKey(identity)) {
      return undefined;
    }
    return cloneJson(statusFor(record));
  }

  async inspectSources(signal: AbortSignal): Promise<readonly McpSourceStatus[]> {
    throwIfAborted(signal);
    return [...this.records.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, record]) => cloneJson(statusFor(record)));
  }

  private recordFor(identity: McpSourceIdentity): SourceRecord {
    if (!identityIsValid(identity)) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const record = this.records.get(ownerKey(identity));
    if (record === undefined || exactIdentityKey(record.source.identity) !== exactIdentityKey(identity)) {
      throw new ProgrammaticMcpError(INVALID_SOURCE);
    }
    return record;
  }

  private bindingFor(record: SourceRecord, serverKey: string): McpRuntimeServerBinding {
    const server = record.source.servers[serverKey];
    if (server === undefined) throw new ProgrammaticMcpError(INVALID_SOURCE);
    return {
      source: copyIdentity(record.source.identity),
      serverKey,
      transport: server.transport,
    };
  }

  async openExecution(
    identity: McpSourceIdentity,
    serverKey: string,
    signal: AbortSignal,
  ): Promise<ProgrammaticExecution> {
    throwIfAborted(signal);
    const record = this.recordFor(identity);
    const server = record.source.servers[serverKey];
    if (server === undefined) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const binding = this.bindingFor(record, serverKey);
    let lease: McpRuntimeLease | undefined;
    let values: McpLaunchValues | undefined;
    let connection: ProgrammaticConnection | undefined;
    let primaryFailure: unknown;
    record.serverStatus.set(serverKey, { state: "connecting" });

    try {
      lease = await record.runtimeLeases.acquire(binding, signal);
      throwIfAborted(signal);
      const manager = this.manager;
      if (manager === undefined) throw new ProgrammaticMcpError(ADAPTER_FAILED);
      const internalKey = qualifiedServerKey(identity, serverKey);
      const existing = manager.getConnection(internalKey) as ProgrammaticConnection | undefined;
      if (existing?.status === "connected") {
        connection = existing;
      } else {
        values = await record.launchValues.resolve(binding, signal);
        throwIfAborted(signal);
        if (!launchValuesAreValid(values, server.transport)) {
          throw new ProgrammaticMcpError(INVALID_SOURCE);
        }
        connection = await manager.connect(
          internalKey,
          serverDefinition(server, values),
          signal,
          {
            allowLegacySseFallback: false,
            retainedDefinition: retainedDefinition(server),
            values: "resolved",
          },
        ) as ProgrammaticConnection;
      }
      throwIfAborted(signal);
    } catch (error) {
      primaryFailure = signal.aborted ? signal.reason : error;
    } finally {
      if (values !== undefined) {
        try {
          await record.launchValues.dispose(values);
        } catch {
          if (!signal.aborted) primaryFailure = new ProgrammaticMcpError(CLEANUP_FAILED);
        }
      }
      if (primaryFailure !== undefined && lease !== undefined) {
        try {
          await record.runtimeLeases.release(lease, new AbortController().signal);
        } catch {
          if (!signal.aborted) primaryFailure = new ProgrammaticMcpError(CLEANUP_FAILED);
        }
      }
    }

    if (primaryFailure !== undefined) {
      if (connection !== undefined && this.manager !== undefined) {
        await this.manager.close(qualifiedServerKey(identity, serverKey));
      }
      record.serverStatus.set(serverKey, {
        state: "failed",
        errorCode: signal.aborted ? CANCELLED : primaryFailure instanceof ProgrammaticMcpError
          ? primaryFailure.code
          : ADAPTER_FAILED,
      });
      throw primaryFailure instanceof ProgrammaticMcpError || signal.aborted
        ? primaryFailure
        : new ProgrammaticMcpError(ADAPTER_FAILED);
    }
    if (lease === undefined || connection === undefined) throw new ProgrammaticMcpError(CLEANUP_FAILED);
    if (connection.status === "needs-auth") {
      await record.runtimeLeases.release(lease, new AbortController().signal);
      record.serverStatus.set(serverKey, { state: "needs-auth" });
      throw new ProgrammaticMcpError(ADAPTER_FAILED);
    }

    const executionController = new AbortController();
    const execution: ExecutionState = {
      controller: executionController,
      lease,
      closed: false,
    };
    record.executions.add(execution);
    record.serverStatus.set(serverKey, {
      state: "connected",
      toolCount: connection.tools.length,
    });

    return {
      connection,
      signal: AbortSignal.any([signal, executionController.signal]),
      close: async (closeSignal = new AbortController().signal) => {
        if (execution.closed) return;
        execution.closed = true;
        try {
          await record.runtimeLeases.release(execution.lease, closeSignal);
          record.executions.delete(execution);
        } catch (error) {
          execution.closed = false;
          throw error;
        }
      },
    };
  }

  async callTool(
    identity: McpSourceIdentity,
    serverKey: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const record = this.recordFor(identity);
    const server = record.source.servers[serverKey];
    if (server === undefined) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const allowed = server.allowedTools === undefined
      ? undefined
      : new Set(server.allowedTools);
    const denied = server.deniedTools === undefined
      ? undefined
      : new Set(server.deniedTools);
    if ((allowed !== undefined && !allowed.has(tool)) || denied?.has(tool)) {
      throw new ProgrammaticMcpError(INVALID_SOURCE);
    }
    const execution = await this.openExecution(identity, serverKey, signal);
    try {
      return await execution.connection.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { signal: execution.signal },
      );
    } finally {
      await execution.close(new AbortController().signal);
    }
  }

  async listTools(
    identity: McpSourceIdentity,
    serverKey: string,
    signal: AbortSignal,
  ): Promise<readonly { identity: string; name: string; description?: string; inputSchema?: unknown }[]> {
    const record = this.recordFor(identity);
    const server = record.source.servers[serverKey];
    if (server === undefined) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const execution = await this.openExecution(identity, serverKey, signal);
    try {
      const allowed = server.allowedTools === undefined
        ? undefined
        : new Set(server.allowedTools);
      const denied = new Set(server.deniedTools ?? []);
      const qualifier = qualifiedServerKey(identity, serverKey);
      return execution.connection.tools
        .filter((tool) => (allowed === undefined || allowed.has(tool.name)) && !denied.has(tool.name))
        .map((tool) => ({
          identity: `${qualifier}:${tool.name}`,
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        }));
    } finally {
      await execution.close(new AbortController().signal);
    }
  }

  private async closeExecutions(record: SourceRecord): Promise<void> {
    for (const execution of [...record.executions]) execution.controller.abort(new ProgrammaticMcpError(CANCELLED));
    for (const execution of [...record.executions]) {
      if (!execution.closed) {
        execution.closed = true;
        try {
          await record.runtimeLeases.release(execution.lease, new AbortController().signal);
          record.executions.delete(execution);
        } catch {
          execution.closed = false;
          throw new ProgrammaticMcpError(CLEANUP_FAILED);
        }
      }
    }
    await record.runtimeLeases.drain(new AbortController().signal);
  }

  private async closeRecord(record: SourceRecord, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.closeExecutions(record);
    throwIfAborted(signal);
    const manager = this.manager;
    if (manager !== undefined) {
      await Promise.all(Object.keys(record.source.servers).map((serverKey) =>
        manager.close(qualifiedServerKey(record.source.identity, serverKey))));
    }
  }
}
