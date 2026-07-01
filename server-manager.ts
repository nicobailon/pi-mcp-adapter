import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  ElicitationCompleteNotificationSchema,
  type ReadResourceResult,
  type UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  McpTool,
  McpResource,
  ServerDefinition,
  ServerStreamResultPatchNotification,
  Transport,
} from "./types.ts";
import { serverStreamResultPatchNotificationSchema } from "./types.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { logger } from "./logger.ts";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { extractOAuthConfig, supportsOAuth } from "./mcp-auth-flow.ts";
import { registerSamplingHandler, type ServerSamplingConfig } from "./sampling-handler.ts";
import {
  handleUrlElicitation,
  registerElicitationHandler,
  type ServerElicitationConfig,
} from "./elicitation-handler.ts";
import { interpolateEnvRecord, resolveBearerToken, resolveConfigPath } from "./utils.ts";
import { abortable, throwIfAborted } from "./abort.ts";

interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed" | "needs-auth";
}

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  private samplingConfig: ServerSamplingConfig | undefined;
  private elicitationConfig: ServerElicitationConfig | undefined;
  private acceptedUrlElicitations = new Map<string, Set<string>>();

  setSamplingConfig(config: ServerSamplingConfig | undefined): void {
    this.samplingConfig = config;
  }

  setElicitationConfig(config: ServerElicitationConfig | undefined): void {
    this.elicitationConfig = config;
  }

  async connect(name: string, definition: ServerDefinition, signal?: AbortSignal): Promise<ServerConnection> {
    throwIfAborted(signal);
    // Dedupe concurrent connection attempts
    if (this.connectPromises.has(name)) {
      return abortable(this.connectPromises.get(name)!, signal);
    }

    // Reuse existing connection if healthy
    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const promise = this.createConnection(name, definition, signal);
    this.connectPromises.set(name, promise);

    try {
      const connection = await promise;
      this.connections.set(name, connection);
      return connection;
    } finally {
      this.connectPromises.delete(name);
    }
  }

  private async createConnection(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    throwIfAborted(signal);
    const client = this.createClient(name);

    let transport: Transport;

    if (definition.command) {
      let command = definition.command;
      let args = definition.args ?? [];

      if (command === "npx" || command === "npm") {
        const resolved = await resolveNpxBinary(command, args);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
        }
      }

      transport = new StdioClientTransport({
        command,
        args,
        env: resolveEnv(definition.env),
        cwd: resolveConfigPath(definition.cwd),
        stderr: definition.debug ? "inherit" : "ignore",
      });
    } else if (definition.url) {
      // HTTP transport with fallback
      transport = await this.createHttpTransport(definition, name, signal);
    } else {
      throw new Error(`Server ${name} has no command or url`);
    }

    try {
      await client.connect(transport, { signal });
      this.attachAdapterNotificationHandlers(name, client);

      // Discover tools and resources
      const [tools, resources] = await Promise.all([
        this.fetchAllTools(client, signal),
        this.fetchAllResources(client, signal),
      ]);

      return {
        client,
        transport,
        definition,
        tools,
        resources,
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      };
    } catch (error) {
      // Check for UnauthorizedError - server requires OAuth
      if (error instanceof UnauthorizedError && supportsOAuth(definition)) {
        // Clean up both client and transport before reporting needs-auth.
        await client.close().catch(() => {});
        await transport.close().catch(() => {});

        return {
          client,
          transport,
          definition,
          tools: [],
          resources: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
        };
      }

      // Clean up both client and transport on any error
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
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

  private createClient(serverName: string): Client {
    const capabilities = this.buildClientCapabilities();
    const client = new Client(
      { name: `pi-mcp-${serverName}`, version: "1.0.0" },
      Object.keys(capabilities).length > 0 ? { capabilities } : undefined,
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
        client.setNotificationHandler(ElicitationCompleteNotificationSchema, notification => {
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

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
  ): Promise<"accept" | "decline" | "cancel"> {
    if (!this.elicitationConfig?.allowUrl) return "cancel";
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
    let accepted = this.acceptedUrlElicitations.get(serverName);
    if (!accepted) {
      accepted = new Set();
      this.acceptedUrlElicitations.set(serverName, accepted);
    }
    accepted.add(elicitationId);
  }

  private async createHttpTransport(
    definition: ServerDefinition,
    serverName: string,
    signal?: AbortSignal,
  ): Promise<Transport> {
    throwIfAborted(signal);
    const url = new URL(definition.url!);

    // Build headers first (including any bearer token)
    const headers = resolveHeaders(definition.headers) ?? {};

    // For bearer auth, add the token to headers BEFORE creating requestInit
    if (definition.auth === "bearer") {
      const token = resolveBearerToken(definition);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    // Create request init with headers (Authorization now included for bearer auth)
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

    // For OAuth servers, create an auth provider
    let authProvider: McpOAuthProvider | undefined;
    if (supportsOAuth(definition)) {
      const oauthConfig = extractOAuthConfig(definition);
      authProvider = new McpOAuthProvider(
        serverName,
        definition.url!,
        oauthConfig,
        {
          onRedirect: async (_authUrl) => {
            // URL is captured by startAuth, no need to log
          },
        }
      );
    }

    // Try StreamableHTTP first (modern MCP servers)
    const streamableTransport = new StreamableHTTPClientTransport(url, {
      requestInit,
      authProvider,
    });

    try {
      // Create a test client to verify the transport works
      const testClient = new Client({ name: "pi-mcp-probe", version: "2.1.2" });
      await testClient.connect(streamableTransport, { signal });
      await testClient.close().catch(() => {});
      // Close probe transport before creating fresh one
      await streamableTransport.close().catch(() => {});

      // StreamableHTTP works - create fresh transport for actual use
      return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
    } catch (error) {
      // StreamableHTTP failed, close and try SSE fallback
      await streamableTransport.close().catch(() => {});

      // Host cancellation is not transport capability evidence; do not fall
      // through to SSE when the caller is trying to cancel the connect.
      if (signal?.aborted) {
        throwIfAborted(signal);
      }

      // If this was an UnauthorizedError, don't try SSE - the server needs auth
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      // SSE is the legacy transport
      return new SSEClientTransport(url, { requestInit, authProvider });
    }
  }

  private async fetchAllTools(client: Client, signal?: AbortSignal): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { signal });
      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return allTools;
  }

  private async fetchAllResources(client: Client, signal?: AbortSignal): Promise<McpResource[]> {
    try {
      const allResources: McpResource[] = [];
      let cursor: string | undefined;

      do {
        const result = await client.listResources(cursor ? { cursor } : undefined, { signal });
        allResources.push(...(result.resources ?? []));
        cursor = result.nextCursor;
      } while (cursor);

      return allResources;
    } catch {
      if (signal?.aborted) {
        throwIfAborted(signal);
      }
      // Server may not support resources
      return [];
    }
  }

  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    client.setNotificationHandler(serverStreamResultPatchNotificationSchema, (notification) => {
      const listener = this.uiStreamListeners.get(notification.params.streamToken);
      if (!listener) return;
      listener(serverName, notification.params);
    });
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.readResource({ uri }, { signal });
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }

  async close(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;

    // Delete from map BEFORE async cleanup to prevent a race where a
    // concurrent connect() creates a new connection that our deferred
    // delete() would then remove, orphaning the new server process.
    connection.status = "closed";
    this.connections.delete(name);
    this.acceptedUrlElicitations.delete(name);
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map(name => this.close(name)));
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
function resolveEnv(env?: Record<string, string>): Record<string, string> {
  // Copy process.env, filtering out undefined values
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      resolved[key] = value;
    }
  }

  if (!env) return resolved;

  const overrides = interpolateEnvRecord(env);
  return overrides ? { ...resolved, ...overrides } : resolved;
}

/**
 * Resolve headers with environment variable interpolation.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  return interpolateEnvRecord(headers);
}
