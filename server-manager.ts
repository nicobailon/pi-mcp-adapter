import { mkdirSync } from "node:fs";
import {
  Client,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type GetPromptResult,
  type ReadResourceResult,
  type RequestOptions,
  type UrlElicitationRequiredError,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { UnixSocketClientTransport } from "./unix-socket-transport.ts";
import { probeMcpEndpoint } from "./mcp-probe.ts";
import {
  isServerDisabled,
  type McpTool,
  type McpResource,
  type McpPrompt,
  type ServerDefinition,
  type ServerStreamResultPatchNotification,
  type Transport,
  type McpTraceSettings,
  SERVER_STREAM_RESULT_PATCH_METHOD,
  serverStreamResultPatchNotificationSchema,
} from "./types.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { createJsonSchemaValidator } from "./json-schema-validator.ts";
import { logger } from "./logger.ts";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { extractOAuthConfig, supportsOAuth, type McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { invalidateAuthEntryCache, type AuthStorageOptions } from "./mcp-auth.ts";
import { registerSamplingHandler, type ServerSamplingConfig } from "./sampling-handler.ts";
import {
  handleUrlElicitation,
  registerElicitationHandler,
  type ServerElicitationConfig,
} from "./elicitation-handler.ts";
import {
  interpolateEnvVars,
  resolveBearerToken,
  resolveCommandSecret,
  resolveCommandSecretsRecord,
  resolveConfigPath,
  resolveServerUrl,
} from "./utils.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import {
  createMcpTraceWriter,
  isMcpTraceEnabled,
  McpTraceWriter,
  type McpTraceObserver,
  traceTransportKind,
  wrapTransportWithMcpTrace,
} from "./mcp-trace.ts";
import { createRequestHeadersCommandFetch } from "./request-headers-command.ts";

const MAX_CAPTURED_STDERR_BYTES = 8 * 1024;
const MAX_CAPTURED_STDERR_LINES = 3;
const abortCleanupPromises = new WeakMap<object, Promise<void>>();

type HttpAuthProviderState =
  | { status: "disabled" }
  | { status: "implicit-deferred" }
  | { status: "explicit"; provider: McpOAuthProvider }
  | { status: "implicit-challenged"; provider: McpOAuthProvider };

function isUnauthorizedHttpError(error: unknown): boolean {
  return error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401);
}

function shouldFallbackToSse(error: unknown, definition: ServerDefinition): boolean {
  if (definition.protocolVersion === "2026-07-28") return false;
  return error instanceof SdkHttpError && [404, 405, 406, 415].includes(error.status);
}

function resolveVersionNegotiation(definition: ServerDefinition): VersionNegotiationOptions | undefined {
  switch (definition.protocolVersion) {
    case undefined:
    case "legacy":
      return undefined;
    case "auto":
      return { mode: "auto" };
    case "2026-07-28":
      return { mode: { pin: "2026-07-28" } };
    default:
      throw new Error(`Invalid MCP protocolVersion: ${String(definition.protocolVersion)}`);
  }
}

function boundedStderrChunk(chunk: Buffer | string): Buffer {
  if (Buffer.isBuffer(chunk)) {
    const start = Math.max(0, chunk.byteLength - MAX_CAPTURED_STDERR_BYTES);
    return Buffer.from(chunk.subarray(start));
  }

  // Limit string conversion before encoding; Buffer.from(largeString) would
  // otherwise allocate the entire stderr event before applying the cap.
  const suffix = chunk.length > MAX_CAPTURED_STDERR_BYTES
    ? chunk.slice(-MAX_CAPTURED_STDERR_BYTES)
    : chunk;
  const bytes = Buffer.from(suffix, "utf8");
  return bytes.byteLength > MAX_CAPTURED_STDERR_BYTES
    ? Buffer.from(bytes.subarray(bytes.byteLength - MAX_CAPTURED_STDERR_BYTES))
    : bytes;
}

function appendStderrTail(tail: Buffer, chunk: Buffer | string): Buffer {
  const bytes = boundedStderrChunk(chunk);
  if (bytes.length === 0) return tail;
  if (tail.length === 0) return bytes;
  const combined = Buffer.concat([tail, bytes]);
  return combined.length > MAX_CAPTURED_STDERR_BYTES
    ? Buffer.from(combined.subarray(combined.length - MAX_CAPTURED_STDERR_BYTES))
    : combined;
}

export interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  /** True when prompts were advertised but prompts/list failed. */
  promptDiscoveryFailed?: boolean;
  instructions?: string;
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed" | "needs-auth";
  /** True once this needs-auth episode discarded the cached credential. */
  credentialsInvalidated?: boolean;
}


type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;
type MetadataListChangedListener = (serverName: string, reason: string) => void;

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private reconnectPromises = new Map<string, Promise<ServerConnection>>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  private samplingConfig: ServerSamplingConfig | undefined;
  private metadataListChangedListener: MetadataListChangedListener | undefined;
  private elicitationConfig: ServerElicitationConfig | undefined;
  private authStorageOptions: AuthStorageOptions = {};
  private oauthRuntime: McpOAuthRuntime | undefined;
  private acceptedUrlElicitations = new Map<string, Set<string>>();
  private defaultRequestTimeoutMs: number | undefined;
  private runtimeSignal: AbortSignal | undefined;
  private closePromises = new Map<string, Promise<void>>();
  private closeGenerations = new Map<string, number>();
  private connectAttempts = new Map<string, AbortController>();
  private traceSettings: McpTraceSettings | undefined;
  private traceWriter: McpTraceWriter | undefined;
  private stopped = false;

  /** Default cwd for stdio servers without an explicit config `cwd`. */
  constructor(private readonly defaultCwd?: string) {}

  setSamplingConfig(config: ServerSamplingConfig | undefined): void {
    this.samplingConfig = config;
  }

  setMetadataListChangedListener(listener: MetadataListChangedListener | undefined): void {
    this.metadataListChangedListener = listener;
  }

  setElicitationConfig(config: ServerElicitationConfig | undefined): void {
    this.elicitationConfig = config;
  }

  setRuntimeSignal(signal: AbortSignal | undefined): void {
    this.runtimeSignal = signal;
  }

  setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void {
    this.defaultRequestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  }

  setTraceConfig(settings: McpTraceSettings | undefined): void {
    this.traceSettings = settings;
  }

  setAuthStorageOptions(options: AuthStorageOptions): void {
    this.authStorageOptions = options;
  }

  setOAuthRuntime(runtime: McpOAuthRuntime): void {
    this.oauthRuntime = runtime;
  }

  getRequestOptions(name: string, signal?: AbortSignal): RequestOptions | undefined {
    const connection = this.connections.get(name);
    return this.buildRequestOptions(connection?.definition, signal);
  }

  private getResolvedRequestTimeoutMs(definition?: ServerDefinition): number | undefined {
    if (definition?.requestTimeoutMs !== undefined) {
      return normalizeRequestTimeoutMs(definition.requestTimeoutMs);
    }
    return this.defaultRequestTimeoutMs;
  }

  private buildRequestOptions(
    definition?: ServerDefinition,
    signal?: AbortSignal,
  ): RequestOptions | undefined {
    const timeout = this.getResolvedRequestTimeoutMs(definition);
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);

    if (!ownedSignal && timeout === undefined) {
      return undefined;
    }

    return {
      ...(ownedSignal ? { signal: ownedSignal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  async connect(name: string, definition: ServerDefinition, signal?: AbortSignal): Promise<ServerConnection> {
    if (isServerDisabled(definition)) throw new Error(`MCP server "${name}" is disabled`);
    if (this.stopped) throw new Error("MCP server manager is closed");
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
    throwIfAborted(ownedSignal);
    const closing = this.closePromises.get(name);
    if (closing) await abortable(closing, ownedSignal);
    throwIfAborted(ownedSignal);

    // Dedupe concurrent connection attempts.
    if (this.connectPromises.has(name)) {
      return abortable(this.connectPromises.get(name)!, ownedSignal);
    }

    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const credentialsInvalidated = existing?.status === "needs-auth"
      && existing.credentialsInvalidated === true;
    const generation = this.closeGenerations.get(name) ?? 0;
    const attemptController = new AbortController();
    const attemptSignal = combineAbortSignals(ownedSignal, attemptController.signal);
    const connectionAttempt = this.createConnection(name, definition, attemptSignal, ownedSignal, credentialsInvalidated);
    const promise = definition.url
      ? connectionAttempt.catch(async error => { throw await this.enrichHttpConnectionError(definition, error); })
      : connectionAttempt;
    this.connectPromises.set(name, promise);
    this.connectAttempts.set(name, attemptController);

    try {
      const connection = await promise;
      if (attemptController.signal.aborted || (this.closeGenerations.get(name) ?? 0) !== generation) {
        await this.disposeConnection(connection);
        throwIfAborted(attemptSignal);
        throw new Error(`MCP connection for ${name} was closed while connecting`);
      }
      this.connections.set(name, connection);
      return connection;
    } finally {
      if (this.connectPromises.get(name) === promise) this.connectPromises.delete(name);
      if (this.connectAttempts.get(name) === attemptController) this.connectAttempts.delete(name);
    }
  }

  /**
   * Reconnect a server whose connection was proven stale (e.g. by a 404
   * "session no longer exists" response). Single-flight per server name —
   * concurrent callers that raced to the same failure share one reconnect —
   * and identity-guarded: `staleConnection` is only torn down if it is
   * still the manager's current connection for `name`. If a concurrent
   * reconnect (or an unrelated connect()) already replaced it with a fresh
   * connection, that fresh connection is returned untouched.
   */
  async reconnect(
    name: string,
    definition: ServerDefinition,
    staleConnection: ServerConnection,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    if (isServerDisabled(definition)) throw new Error(`MCP server "${name}" is disabled`);
    if (this.stopped) throw new Error("MCP server manager is closed");
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
    throwIfAborted(ownedSignal);
    const inFlight = this.reconnectPromises.get(name);
    if (inFlight) {
      return abortable(inFlight, ownedSignal);
    }

    const promise = this.doReconnect(name, definition, staleConnection, ownedSignal).finally(() => {
      if (this.reconnectPromises.get(name) === promise) {
        this.reconnectPromises.delete(name);
      }
    });
    this.reconnectPromises.set(name, promise);
    return abortable(promise, ownedSignal);
  }

  private async doReconnect(
    name: string,
    definition: ServerDefinition,
    staleConnection: ServerConnection,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    throwIfAborted(signal);
    const current = this.connections.get(name);

    // Never tear down a connection we didn't prove stale: if the map no
    // longer holds the connection we were asked to replace, someone else
    // already reconnected (or connected) first.
    if (current !== staleConnection) {
      return current ?? this.connect(name, definition, signal);
    }

    const staleInFlight = staleConnection.inFlight;
    await this.close(name);
    const fresh = await this.connect(name, definition, signal);
    fresh.inFlight = Math.max(fresh.inFlight, staleInFlight);
    return fresh;
  }

  private async createConnection(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
    requestSignal?: AbortSignal,
    credentialsInvalidated = false,
  ): Promise<ServerConnection> {
    throwIfAborted(signal);

    const tracingEnabled = isMcpTraceEnabled(definition, this.traceSettings);
    const traceWriter = tracingEnabled
      ? (this.traceWriter ??= createMcpTraceWriter(this.defaultCwd, this.traceSettings ?? {}))
      : undefined;
    const traceObserver: McpTraceObserver | undefined = traceWriter
      ? { record: event => traceWriter.write(event) }
      : undefined;

    let client: Client;
    let transport: Transport;
    let clientConnected = false;
    let invalidated = credentialsInvalidated;
    let transportAlreadyTraced = false;
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const configuredTransports = [definition.command, definition.url, definition.socket]
      .filter(value => typeof value === "string" && value.length > 0);
    if (configuredTransports.length !== 1) {
      throw new Error(`Server ${name} must configure exactly one of command, url, or socket`);
    }

    const requestOptions = this.buildRequestOptions(definition, requestSignal);

    if (definition.command) {
      client = this.createClient(name, definition);
      let command = definition.command;
      let args = (definition.args ?? []).map(interpolateEnvVars);

      if (command === "npx" || command === "npm") {
        const resolved = await resolveNpxBinary(command, args, signal);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
        }
      }
      throwIfAborted(signal);

      if (definition.pluginDataDir) mkdirSync(definition.pluginDataDir, { recursive: true });
      const cwd = resolveConfigPath(definition.cwd) ?? this.defaultCwd;
      const stdioTransport = new StdioClientTransport({
        command,
        args,
        env: resolveEnv(definition.env, name, definition.literalEnv === true),
        ...(cwd !== undefined ? { cwd } : {}),
        stderr: definition.debug ? "inherit" : "pipe",
      });
      // Keep non-debug child diagnostics available for connection failures without
      // retaining an unbounded stream or changing the existing debug behavior.
      if (stdioTransport.stderr) {
        stdioTransport.stderr.on("data", (chunk: Buffer | string) => {
          stderrTail = appendStderrTail(stderrTail, chunk);
        });
      }
      transport = stdioTransport;
    } else if (definition.url) {
      const httpConnection = await this.connectHttpClient(
        definition,
        name,
        requestOptions,
        signal,
        traceObserver,
        invalidated,
      );
      client = httpConnection.client;
      transport = httpConnection.transport;
      invalidated = httpConnection.credentialsInvalidated;
      if (httpConnection.status === "needs-auth") {
        return {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          prompts: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
          credentialsInvalidated: invalidated,
        };
      }
      clientConnected = true;
      transportAlreadyTraced = traceObserver !== undefined;
    } else {
      client = this.createClient(name, definition);
      transport = new UnixSocketClientTransport(resolveConfigPath(definition.socket!)!);
    }

    if (traceObserver && !transportAlreadyTraced) {
      const traceTransportKindValue = traceTransportKind(definition, transport);
      transport = wrapTransportWithMcpTrace(transport, name, traceTransportKindValue, traceObserver);
    }

    try {
      throwIfAborted(signal);
      if (!clientConnected) {
        await this.connectClientWithAbort(client, transport, requestOptions, signal);
      }
      this.attachAdapterNotificationHandlers(name, client);

      const instructions = client.getInstructions?.();
      const connection: ServerConnection = {
        client,
        transport,
        definition,
        tools: [],
        resources: [],
        prompts: [],
        ...(instructions !== undefined ? { instructions } : {}),
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      };

      // Reflect the SDK's own close signal in connection status, guarded by
      // identity so a stale connection's late close can never clobber a fresh
      // connection. The SDK client owns the transport callbacks.
      client.onclose = () => {
        if (this.connections.get(name) === connection) {
          connection.status = "closed";
        }
      };

      // Discover tools, resources, and prompts. Resource and prompt listing is
      // optional: only servers advertising the capability are queried.
      const [tools, resources, promptResult] = await Promise.all([
        this.fetchAllTools(client, requestOptions),
        this.fetchAllResources(client, requestOptions),
        this.fetchAllPrompts(client, requestOptions),
      ]);
      connection.tools = tools;
      connection.resources = resources;
      connection.prompts = promptResult.prompts;
      connection.promptDiscoveryFailed = promptResult.failed;

      return connection;
    } catch (error) {
      // If connectClientWithAbort closed the transport, await that exact close.
      // Otherwise the SDK client owns its transport and performs cleanup once.
      const abortCleanup = abortCleanupPromises.get(transport);
      const abortCleanupFailed = error instanceof AggregateError && error.message === "MCP connection abort cleanup failed";
      const cleanupResults = abortCleanupFailed
        ? []
        : await Promise.allSettled([
            abortCleanup ?? Promise.resolve().then(() => client.close()),
          ]);
      const cleanupFailures = cleanupResults.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      let reportedError: unknown = error;
      if (cleanupFailures.length > 0) {
        reportedError = new AggregateError([error, ...cleanupFailures], "MCP connection setup failed");
      }

      // A cleanup failure remains a setup failure rather than being hidden
      // behind needs-auth.
      if (isUnauthorizedHttpError(error) && supportsOAuth(definition) && cleanupFailures.length === 0) {
        if (!invalidated) {
          invalidateAuthEntryCache(name);
          invalidated = true;
        }
        return {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          prompts: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
          credentialsInvalidated: invalidated,
        };
      }

      if (stderrTail.length > 0) {
        const stderrText = stderrTail.toString("utf8").trim();
        const lines = stderrText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length > 0) {
          const baseMessage = reportedError instanceof Error ? reportedError.message : String(reportedError);
          const detail = lines.slice(-MAX_CAPTURED_STDERR_LINES).join(" — ");
          throw new Error(`${baseMessage} (${detail})`, { cause: reportedError });
        }
      }
      throw reportedError;
    }
  }

  private async enrichHttpConnectionError(definition: ServerDefinition, error: unknown): Promise<Error> {
    const originalMessage = error instanceof Error ? error.message : String(error);
    try {
      const probe = await probeMcpEndpoint(resolveServerUrl(definition)!);
      return new Error(`${originalMessage} — probe: ${probe.classification}`, { cause: error });
    } catch {
      return error instanceof Error ? error : new Error(originalMessage);
    }
  }

  private async connectClientWithAbort(
    client: Client,
    transport: Transport,
    requestOptions?: RequestOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    let abortCleanup: Promise<void> | undefined;
    const closeTransport = () => {
      abortCleanup = Promise.resolve().then(() => transport.close());
      abortCleanupPromises.set(transport, abortCleanup);
    };
    signal?.addEventListener("abort", closeTransport, { once: true });
    try {
      await abortable(client.connect(transport, requestOptions), signal);
      await abortCleanup;
    } catch (error) {
      if (abortCleanup) {
        try {
          await abortCleanup;
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "MCP connection abort cleanup failed");
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeTransport);
    }
  }

  private buildClientCapabilities() {
    return {
      ...(this.samplingConfig ? { sampling: {} } : {}),
      ...(this.elicitationConfig
        ? {
            elicitation: {
              form: {},
              ...(this.elicitationConfig.allowUrl ? { url: {} } : {}),
            },
          }
        : {}),
    };
  }

  private createClient(serverName: string, definition: ServerDefinition): Client {
    const capabilities = this.buildClientCapabilities();
    const versionNegotiation = resolveVersionNegotiation(definition);
    let client: Client;
    client = new Client(
      { name: `pi-mcp-${serverName}`, version: "1.0.0" },
      {
        jsonSchemaValidator: createJsonSchemaValidator(),
        ...(versionNegotiation ? { versionNegotiation } : {}),
        ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
        listChanged: {
          tools: {
            onChanged: (error: Error | null, tools: McpTool[] | null) => {
              this.handleToolsListChanged(serverName, client, error, tools);
            },
          },
          resources: {
            onChanged: (error: Error | null, resources: McpResource[] | null) => {
              this.handleResourcesListChanged(serverName, client, error, resources);
            },
          },
          prompts: {
            onChanged: (error: Error | null, prompts: McpPrompt[] | null) => {
              this.handlePromptsListChanged(serverName, client, error, prompts);
            },
          },
        },
      },
    );
    if (this.samplingConfig) {
      registerSamplingHandler(client, { ...this.samplingConfig, serverName });
    }
    if (this.elicitationConfig) {
      registerElicitationHandler(client, {
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      });
      if (this.elicitationConfig.allowUrl) {
        client.setNotificationHandler("notifications/elicitation/complete", notification => {
          if (this.runtimeSignal?.aborted) return;
          const accepted = this.acceptedUrlElicitations.get(serverName);
          if (!accepted?.delete(notification.params.elicitationId)) return;
          this.elicitationConfig?.ui.notify(
            `MCP browser interaction for ${serverName} completed. You can retry the tool now.`,
            "info",
          );
        });
      }
    }
    return client;
  }

  private handleToolsListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    tools: McpTool[] | null,
  ): void {
    if (error) {
      logger.debug(`MCP: tools/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    if (!tools) return;
    const connection = this.connections.get(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") return;
    connection.tools = tools;
    this.metadataListChangedListener?.(serverName, "tools-list-changed");
  }

  private handlePromptsListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    prompts: McpPrompt[] | null,
  ): void {
    if (error) {
      logger.debug(`MCP: prompts/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    if (!prompts) return;
    const connection = this.connections.get(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") return;
    connection.prompts = prompts;
    connection.promptDiscoveryFailed = false;
    this.metadataListChangedListener?.(serverName, "prompts-list-changed");
  }

  private handleResourcesListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    resources: McpResource[] | null,
  ): void {
    if (error) {
      logger.debug(`MCP: resources/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    if (!resources) return;
    const connection = this.connections.get(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") return;
    connection.resources = resources;
    this.metadataListChangedListener?.(serverName, "resources-list-changed");
  }

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
  ): Promise<"accept" | "decline" | "cancel"> {
    if (this.runtimeSignal?.aborted || !this.elicitationConfig?.allowUrl) return "cancel";
    for (const params of error.elicitations) {
      const result = await handleUrlElicitation({
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      }, params);
      if (result.action !== "accept") return result.action;
    }
    return "accept";
  }

  private rememberUrlElicitation(serverName: string, elicitationId: string): void {
    if (this.runtimeSignal?.aborted) return;
    let accepted = this.acceptedUrlElicitations.get(serverName);
    if (!accepted) {
      accepted = new Set();
      this.acceptedUrlElicitations.set(serverName, accepted);
    }
    accepted.add(elicitationId);
  }

  private async connectHttpClient(
    definition: ServerDefinition,
    serverName: string,
    requestOptions: RequestOptions | undefined,
    signal?: AbortSignal,
    traceObserver?: McpTraceObserver,
    credentialsInvalidated = false,
  ): Promise<{ client: Client; transport: Transport; status: "connected" | "needs-auth"; credentialsInvalidated: boolean }> {
    throwIfAborted(signal);
    const serverUrl = resolveServerUrl(definition)!;
    const url = new URL(serverUrl);

    // Resolve secret commands only for this connection attempt, without
    // mutating the persisted configuration.
    const hasCommandHeader = Object.values(definition.headers ?? {})
      .some(value => value.startsWith("!") && !value.startsWith("!!"));
    const headers = resolveCommandSecretsRecord(
      definition.headers,
      key => `MCP server "${serverName}" HTTP header "${key}"`,
    ) ?? {};

    // Resolve bearer auth before creating requestInit so every attempted
    // transport receives the same headers.
    const commandBearer = definition.bearerToken?.startsWith("!") && !definition.bearerToken.startsWith("!!")
      ? definition.bearerToken
      : undefined;
    if (definition.auth === "bearer") {
      const token = commandBearer
        ? resolveCommandSecret(commandBearer, `MCP server "${serverName}" HTTP bearer token`)
        : resolveBearerToken(definition);
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }

    if (hasCommandHeader || commandBearer) {
      try {
        new Headers(headers);
      } catch {
        throw new Error(`Failed to resolve MCP server "${serverName}" HTTP command secret: command returned an invalid header value`);
      }
    }

    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    const requestFetch = definition.requestHeadersCommand
      ? createRequestHeadersCommandFetch(definition.requestHeadersCommand)
      : undefined;
    const createAuthProvider = (): McpOAuthProvider => new McpOAuthProvider(
      serverName,
      serverUrl,
      extractOAuthConfig(definition),
      { onRedirect: async () => {} },
      this.authStorageOptions,
      this.oauthRuntime?.signal,
    );

    // Explicit OAuth checks secure storage immediately. Implicit OAuth defers
    // provider construction until the server proves authentication is needed.
    let authState: HttpAuthProviderState = supportsOAuth(definition)
      ? definition.auth === undefined
        ? { status: "implicit-deferred" }
        : { status: "explicit", provider: createAuthProvider() }
      : { status: "disabled" };

    const attempt = async (
      kind: "streamable-http" | "sse",
    ): Promise<
      | { status: "connected"; client: Client; transport: Transport }
      | { status: "failed"; client: Client; transport: Transport; error: unknown }
    > => {
      const authProvider = "provider" in authState ? authState.provider : undefined;
      const transportOptions = {
        ...(requestInit !== undefined ? { requestInit } : {}),
        ...(requestFetch !== undefined ? { fetch: requestFetch } : {}),
        ...(authProvider !== undefined ? { authProvider } : {}),
        ...(authProvider !== undefined
          && definition.oauth !== false
          && definition.oauth?.skipIssuerMetadataValidation === true
          ? { skipIssuerMetadataValidation: true }
          : {}),
      };
      const baseTransport: Transport = kind === "streamable-http"
        ? new StreamableHTTPClientTransport(url, transportOptions)
        : new SSEClientTransport(url, transportOptions);
      const transport = traceObserver
        ? wrapTransportWithMcpTrace(baseTransport, serverName, kind, traceObserver)
        : baseTransport;
      const client = this.createClient(serverName, definition);

      try {
        await this.connectClientWithAbort(client, transport, requestOptions, signal);
        return { status: "connected", client, transport };
      } catch (error) {
        const abortCleanupFailed = error instanceof AggregateError
          && error.message === "MCP connection abort cleanup failed";
        if (!abortCleanupFailed) {
          try {
            await (abortCleanupPromises.get(transport) ?? client.close());
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "MCP HTTP connection cleanup failed");
          }
        }
        return { status: "failed", client, transport, error };
      }
    };

    // Connect the real client once. Retry Streamable HTTP only for an implicit
    // OAuth challenge; use SSE only for definitive endpoint incompatibility.
    // Agent Plugins set httpTransport, and their declared transport is used without fallback.
    let kind: "streamable-http" | "sse" = definition.httpTransport ?? "streamable-http";
    let invalidated = credentialsInvalidated;
    for (;;) {
      const result = await attempt(kind);
      if (result.status === "connected") return { ...result, credentialsInvalidated: invalidated };
      if (result.error instanceof AggregateError
        && result.error.message === "MCP connection abort cleanup failed") {
        throw result.error;
      }
      if (signal?.aborted) throwIfAborted(signal);

      if (authState.status === "implicit-deferred" && isUnauthorizedHttpError(result.error)) {
        authState = { status: "implicit-challenged", provider: createAuthProvider() };
        continue;
      }
      if (isUnauthorizedHttpError(result.error)) {
        if (supportsOAuth(definition)) {
          if (!invalidated) {
            invalidateAuthEntryCache(serverName);
            invalidated = true;
          }
          return {
            client: result.client,
            transport: result.transport,
            status: "needs-auth",
            credentialsInvalidated: invalidated,
          };
        }
        throw result.error;
      }

      if (definition.httpTransport === undefined && kind === "streamable-http" && shouldFallbackToSse(result.error, definition)) {
        kind = "sse";
        continue;
      }
      throw result.error;
    }
  }

  private async fetchAllTools(client: Client, requestOptions?: RequestOptions): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return allTools;
  }

  private async fetchAllPrompts(
    client: Client,
    requestOptions?: RequestOptions,
  ): Promise<{ prompts: McpPrompt[]; failed: boolean }> {
    const capabilities = client.getServerCapabilities?.();
    if (!capabilities?.prompts) return { prompts: [], failed: false };

    try {
      const prompts: McpPrompt[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.listPrompts(cursor ? { cursor } : undefined, requestOptions);
        prompts.push(...(result.prompts ?? []));
        cursor = result.nextCursor;
      } while (cursor);
      return { prompts, failed: false };
    } catch (error) {
      if (requestOptions?.signal?.aborted) throwIfAborted(requestOptions.signal);
      if (isUnauthorizedHttpError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`MCP: prompts/list failed: ${message}`);
      return { prompts: [], failed: true };
    }
  }

  private async fetchAllResources(client: Client, requestOptions?: RequestOptions): Promise<McpResource[]> {
    const capabilities = client.getServerCapabilities?.();
    if (!capabilities?.resources) return [];

    try {
      const allResources: McpResource[] = [];
      let cursor: string | undefined;

      do {
        const result = await client.listResources(cursor ? { cursor } : undefined, requestOptions);
        allResources.push(...(result.resources ?? []));
        cursor = result.nextCursor;
      } while (cursor);

      return allResources;
    } catch (error) {
      if (requestOptions?.signal?.aborted) {
        throwIfAborted(requestOptions.signal);
      }
      if (isUnauthorizedHttpError(error)) throw error;
      // The server advertises resources but the listing failed
      return [];
    }
  }

  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    client.setNotificationHandler(
      SERVER_STREAM_RESULT_PATCH_METHOD,
      { params: serverStreamResultPatchNotificationSchema.shape.params },
      params => {
        const listener = this.uiStreamListeners.get(params.streamToken);
        if (!listener) return;
        listener(serverName, params);
      },
    );
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }

  async getPrompt(
    name: string,
    promptName: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }
    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.getPrompt(
        { name: promptName, ...(args ? { arguments: args } : {}) },
        this.getRequestOptions(name, signal),
      );
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    if (isServerDisabled(this.connections.get(name)?.definition)) {
      throw new Error(`MCP server "${name}" is disabled`);
    }
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.readResource({ uri }, this.getRequestOptions(name, signal));
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }

  async close(name: string): Promise<void> {
    this.closeGenerations.set(name, (this.closeGenerations.get(name) ?? 0) + 1);
    this.connectAttempts.get(name)?.abort(new Error(`MCP connection ${name} was closed`));

    const connection = this.connections.get(name);
    if (!connection) {
      const pendingClose = this.closePromises.get(name);
      if (pendingClose) {
        await pendingClose;
        return;
      }
      const pendingConnect = this.connectPromises.get(name);
      if (pendingConnect) {
        try {
          await pendingConnect;
        } catch (error) {
          if (this.containsCleanupFailure(error)) throw error;
        }
      }
      return;
    }

    // Delete before awaiting SDK cleanup so a replacement cannot be removed by
    // an old close operation finishing later.
    connection.status = "closed";
    this.connections.delete(name);
    this.acceptedUrlElicitations.delete(name);
    const closing = this.disposeConnection(connection).finally(() => {
      if (this.closePromises.get(name) === closing) this.closePromises.delete(name);
    });
    this.closePromises.set(name, closing);
    return closing;
  }

  private async disposeConnection(connection: ServerConnection): Promise<void> {
    const results = await Promise.allSettled([
      // Only client.close() is needed; the client owns the transport and will close it internally.
      Promise.resolve().then(() => connection.client.close()),
      this.traceWriter?.flush() ?? Promise.resolve(),
    ]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "MCP connection cleanup failed");
  }

  async closeAll(): Promise<void> {
    this.stopped = true;
    const names = new Set([...this.connections.keys(), ...this.connectPromises.keys()]);
    for (const name of names) {
      this.closeGenerations.set(name, (this.closeGenerations.get(name) ?? 0) + 1);
      this.connectAttempts.get(name)?.abort(new Error(`MCP connection ${name} was closed`));
    }

    const pendingConnects = [...this.connectPromises.values()];
    const currentNames = [...this.connections.keys()];
    const pendingResults = await Promise.allSettled(pendingConnects);
    const results = await Promise.allSettled(currentNames.map(name => this.close(name)));

    // A connect that resolved during the first close snapshot is still fenced;
    // close any handle that was already inserted before its attempt settled.
    const lateNames = [...this.connections.keys()];
    const lateResults = await Promise.allSettled(lateNames.map(name => this.close(name)));
    const failures = [...pendingResults, ...results, ...lateResults]
      .flatMap(result => result.status === "rejected" ? [result.reason] : [])
      .filter(error => this.containsCleanupFailure(error));
    this.uiStreamListeners.clear();
    this.acceptedUrlElicitations.clear();
    this.samplingConfig = undefined;
    this.elicitationConfig = undefined;
    await this.traceWriter?.flush();
    if (failures.length > 0) throw new AggregateError(failures, "MCP manager cleanup failed");
  }

  private containsCleanupFailure(error: unknown): boolean {
    const pending: unknown[] = [error];
    const seen = new Set<unknown>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (!(current instanceof Error) || seen.has(current)) continue;
      seen.add(current);
      if (current instanceof AggregateError) {
        if (/cleanup failed|setup failed/.test(current.message)) return true;
        pending.push(...current.errors);
      }
      if (current.cause !== undefined) pending.push(current.cause);
    }
    return false;
  }

  isConnecting(name: string): boolean {
    return this.connectPromises.has(name);
  }

  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.lastUsedAt = Date.now();
    }
  }

  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.inFlight = (connection.inFlight ?? 0) + 1;
    }
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) {
      connection.inFlight--;
    }
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return false;
    if (connection.inFlight > 0) return false;
    return (Date.now() - connection.lastUsedAt) > timeoutMs;
  }
}

/**
 * Resolve environment variables with interpolation.
 */
function resolveEnv(env: Record<string, string> | undefined, serverName: string, literalEnv = false): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) resolved[key] = value;
  }
  if (literalEnv) return env ? { ...resolved, ...env } : resolved;

  const overrides = resolveCommandSecretsRecord(
    env,
    key => `MCP server "${serverName}" stdio env "${key}"`,
  );
  return overrides ? { ...resolved, ...overrides } : resolved;
}

function normalizeRequestTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : undefined;
}
