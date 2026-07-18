import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

export type McpSourceTransport = "stdio" | "streamable-http";

/**
 * Stable caller-owned source name plus an opaque revision used for exact
 * compare-and-replace. Names should be globally unique to the contributing
 * extension, for example `com.example.search:workspace`.
 */
export interface McpSourceIdentity {
  readonly id: string;
  readonly revision: string;
}

/** Secret-free policy retained by the adapter between connection attempts. */
export interface McpSourceServer {
  readonly transport: McpSourceTransport;
  readonly requestTimeoutMs?: number;
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
}

export interface McpConfigSource {
  readonly identity: McpSourceIdentity;
  /** Server keys are source-local and remain qualified by `identity` internally. */
  readonly servers: Readonly<Record<string, McpSourceServer>>;
}

export type McpSourcePrecondition =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "exact"; identity: McpSourceIdentity }>;

export interface McpRuntimeServerBinding {
  readonly source: McpSourceIdentity;
  readonly serverKey: string;
  readonly transport: McpSourceTransport;
}

export type McpLaunchValueRequest = McpRuntimeServerBinding;

/**
 * Plaintext launch values exist only for one immediate launch/connect attempt.
 * The runtime never places them in source records, status, cache metadata, or
 * diagnostics and always calls the provider's `dispose` hook.
 */
export type McpLaunchValues =
  | Readonly<{
      transport: "stdio";
      command: string;
      args: readonly string[];
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      transport: "streamable-http";
      url: string;
      headers?: Readonly<Record<string, string>>;
      bearerToken?: string;
    }>;

export interface McpLaunchValueProvider {
  resolve(request: McpLaunchValueRequest, signal: AbortSignal): Promise<McpLaunchValues>;
  dispose(values: McpLaunchValues): void | Promise<void>;
}

/** Opaque caller-owned authority retained only for one active execution. */
export type McpRuntimeLease = Readonly<Record<PropertyKey, unknown>>;

/**
 * Optional lifetime hooks for callers that must keep launch authority alive
 * while a tool is executing. `drain` completes before a source is replaced or
 * removed.
 */
export interface McpRuntimeLeaseProvider {
  acquire(binding: McpRuntimeServerBinding, signal: AbortSignal): Promise<McpRuntimeLease>;
  release(lease: McpRuntimeLease, signal: AbortSignal): Promise<void>;
  drain(signal: AbortSignal): Promise<void>;
}

export type McpSourceReplaceRequest = Readonly<{
  source: McpConfigSource;
  expected: McpSourcePrecondition;
  launchValues: McpLaunchValueProvider;
  runtimeLeases?: McpRuntimeLeaseProvider;
}>;

export interface McpDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly operation: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export type McpSourceValidationResult =
  | Readonly<{
      ok: true;
      value: McpConfigSource;
      diagnostics: readonly McpDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly McpDiagnostic[];
    }>;

export interface McpSourceServerStatus {
  readonly key: string;
  readonly transport: McpSourceTransport;
  readonly state: "registered" | "connecting" | "connected" | "needs-auth" | "failed";
  readonly toolCount?: number;
  readonly errorCode?: string;
}

export interface McpSourceStatus {
  readonly identity: McpSourceIdentity;
  /** SHA-256 of the canonical, secret-free source definition. */
  readonly sourceDigest: string;
  readonly state: "registered" | "replacing" | "removing" | "failed";
  readonly servers: readonly McpSourceServerStatus[];
}

export type McpSourceReplaceResult =
  | Readonly<{
      kind: "applied";
      status: McpSourceStatus;
      previousIdentity?: McpSourceIdentity;
    }>
  | Readonly<{
      kind: "stale";
      currentIdentity: McpSourceIdentity;
    }>
  | Readonly<{
      kind: "rejected";
      diagnostics: readonly McpDiagnostic[];
    }>;

export type McpSourceRemoveResult =
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{
      kind: "ownership-mismatch";
      requestedIdentity: McpSourceIdentity;
      currentIdentity: McpSourceIdentity;
    }>;

/** Complete, environment-aware facts for the programmatic adapter instance. */
export interface McpRuntimeCapabilities {
  readonly sourceLifecycle: Readonly<{
    initialSourcesBeforeToolRegistration: boolean;
    isolatedFileDiscovery: boolean;
    localValidation: boolean;
    atomicReplace: boolean;
    exactRemove: boolean;
    inspect: boolean;
    cancellable: boolean;
    lateLaunchValues: boolean;
    runtimeLeases: boolean;
  }>;
  readonly transports: Readonly<{
    stdio: boolean;
    streamableHttp: boolean;
    legacySse: boolean;
    websocket: boolean;
  }>;
  readonly oauth: Readonly<{
    authorizationCode: boolean;
    clientCredentials: boolean;
  }>;
  readonly features: Readonly<{
    sampling: boolean;
    elicitationForm: boolean;
    elicitationUrl: boolean;
    toolApproval: boolean;
    resources: boolean;
    directTools: boolean;
  }>;
}

/** Documented package boundary. Transport and manager internals stay private. */
export interface McpProgrammaticRuntime {
  capabilities(signal: AbortSignal): Promise<McpRuntimeCapabilities>;
  validateSource(
    source: McpConfigSource,
    signal: AbortSignal,
  ): Promise<McpSourceValidationResult>;
  replaceSource(
    request: McpSourceReplaceRequest,
    signal: AbortSignal,
  ): Promise<McpSourceReplaceResult>;
  removeSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceRemoveResult>;
  inspectSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceStatus | undefined>;
  inspectSources(signal: AbortSignal): Promise<readonly McpSourceStatus[]>;
}

export type McpInitialSource = Readonly<{
  source: McpConfigSource;
  launchValues: McpLaunchValueProvider;
  runtimeLeases?: McpRuntimeLeaseProvider;
}>;

export interface McpAdapterOptions {
  /** Installed synchronously before the returned extension can register tools. */
  readonly initialSources?: readonly McpInitialSource[];
  /** Existing standalone behavior remains the default. */
  readonly fileDiscovery?: "enabled" | "disabled";
}

export interface McpAdapterInstance {
  readonly extension: (pi: ExtensionAPI) => void;
  readonly runtime: McpProgrammaticRuntime;
}
