import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpTool,
  McpResource,
  ServerDefinition,
  ServerStreamResultPatchNotification,
  Transport,
} from "./types.js";
import { serverStreamResultPatchNotificationSchema } from "./types.js";
import { getStoredTokens } from "./oauth-handler.js";
import { FileBackedOAuthProvider } from "./oauth-provider.js";
import { startCallbackServer, openBrowser, type CallbackServer } from "./oauth-flow.js";
import { resolveNpxBinary } from "./npx-resolver.js";
import { logger } from "./logger.js";

interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed";
}

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  
  async connect(name: string, definition: ServerDefinition): Promise<ServerConnection> {
    // Dedupe concurrent connection attempts
    if (this.connectPromises.has(name)) {
      return this.connectPromises.get(name)!;
    }
    
    // Reuse existing connection if healthy
    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    
    const promise = this.createConnection(name, definition);
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
    definition: ServerDefinition
  ): Promise<ServerConnection> {
    const client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" });
    
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
        cwd: definition.cwd,
        stderr: definition.debug ? "inherit" : "ignore",
      });
    } else if (definition.url) {
      // HTTP transport with fallback
      transport = await this.createHttpTransport(definition, name);
    } else {
      throw new Error(`Server ${name} has no command or url`);
    }
    
    try {
      await client.connect(transport);
      this.attachAdapterNotificationHandlers(name, client);
      
      // Discover tools and resources
      const [tools, resources] = await Promise.all([
        this.fetchAllTools(client),
        this.fetchAllResources(client),
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
      // Clean up both client and transport on any error
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }
  
  private async createHttpTransport(definition: ServerDefinition, serverName?: string): Promise<Transport> {
    const url = new URL(definition.url!);
    const headers = resolveHeaders(definition.headers) ?? {};
    
    // Add bearer token if configured
    if (definition.auth === "bearer") {
      const token = definition.bearerToken 
        ?? (definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }
    
    // OAuth has a richer flow (loopback callback server, browser open, dynamic
    // client registration, token refresh) so it gets its own helper instead of
    // sharing the simple probe-based fallback path below.
    if (definition.auth === "oauth") {
      if (!serverName) {
        throw new Error("Server name required for OAuth authentication");
      }
      return await this.createOAuthHttpTransport(url, headers, serverName, definition);
    }
    
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    
    // Try StreamableHTTP first (modern MCP servers)
    const streamableTransport = new StreamableHTTPClientTransport(url, { requestInit });
    
    try {
      // Create a test client to verify the transport works
      const testClient = new Client({ name: "pi-mcp-probe", version: "1.0.0" });
      await testClient.connect(streamableTransport);
      await testClient.close().catch(() => {});
      // Close probe transport before creating fresh one
      await streamableTransport.close().catch(() => {});
      
      // StreamableHTTP works - create fresh transport for actual use
      return new StreamableHTTPClientTransport(url, { requestInit });
    } catch {
      // StreamableHTTP failed, close and try SSE fallback
      await streamableTransport.close().catch(() => {});
      
      // SSE is the legacy transport
      return new SSEClientTransport(url, { requestInit });
    }
  }

  /**
   * Build a StreamableHTTP transport for an OAuth-protected MCP server.
   *
   * Flow:
   *   1. Bind a single-shot loopback callback server on a random port.
   *   2. Construct a FileBackedOAuthProvider that points its `redirect_uri`
   *      at that loopback port and persists tokens / client info / PKCE
   *      verifier under `~/.pi/agent/mcp-oauth/<server>/`.
   *   3. Build a StreamableHTTP transport with the provider attached.
   *      The MCP SDK will load any cached tokens and try to connect.
   *   4. If a probe connect succeeds we already had valid tokens — return
   *      a fresh transport bound to the same provider and we're done.
   *   5. If it throws UnauthorizedError, the SDK has already triggered
   *      `provider.redirectToAuthorization(authUrl)` which opened the user's
   *      browser. We block on the loopback server to receive the auth code,
   *      then call `auth(provider, { authorizationCode })` directly to
   *      exchange the code for tokens (which the provider then persists).
   *      Finally, build a fresh transport bound to the same provider and
   *      return it — the next connection will succeed using the new tokens.
   *
   * SSE fallback is intentionally not used here. Servers that speak OAuth
   * are uniformly modern and support StreamableHTTP; legacy SSE servers
   * predate the MCP auth spec.
   */
  private async createOAuthHttpTransport(
    url: URL,
    headers: Record<string, string>,
    serverName: string,
    definition: ServerDefinition,
  ): Promise<Transport> {
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    let callbackServer: CallbackServer | undefined;
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      callbackServer?.close();
    };

    try {
      callbackServer = await startCallbackServer();

      const provider = new FileBackedOAuthProvider(serverName, {
        redirectPort: callbackServer.port,
        clientName: `pi-mcp-adapter (${serverName})`,
        scope: definition.oauthScope,
        onRedirect: async (authUrl) => {
          // The SDK calls this when the user must visit the authorization
          // endpoint. We log the URL (so headless / SSH users can copy it)
          // and best-effort open it in the system browser.
          logger.info(`OAuth: open this URL to authorize "${serverName}":`, {
            server: serverName,
            url: authUrl.toString(),
          });
          await openBrowser(authUrl.toString());
        },
      });

      // First attempt: maybe we already have valid cached tokens.
      const probeTransport = new StreamableHTTPClientTransport(url, {
        requestInit,
        authProvider: provider,
      });
      const probeClient = new Client({ name: "pi-mcp-probe", version: "1.0.0" });

      try {
        await probeClient.connect(probeTransport);
        await probeClient.close().catch(() => {});
        await probeTransport.close().catch(() => {});
        cleanup();
        // Cached tokens worked. Return a fresh transport bound to the
        // same provider for the real connection.
        return new StreamableHTTPClientTransport(url, {
          requestInit,
          authProvider: provider,
        });
      } catch (probeError) {
        await probeClient.close().catch(() => {});
        await probeTransport.close().catch(() => {});

        if (!(probeError instanceof UnauthorizedError)) {
          // Real failure (DNS, TLS, 5xx, etc.) — surface it.
          throw probeError;
        }
        // UnauthorizedError means the SDK has already invoked
        // provider.redirectToAuthorization(authUrl), so the browser is
        // open and the user is being walked through consent. Wait for
        // the loopback callback to fire.
      }

      logger.info(`OAuth: waiting for browser callback for "${serverName}"...`, {
        server: serverName,
      });
      const { code } = await callbackServer.waitForCode();

      // Hand the code back to the SDK, which will exchange it for tokens
      // and persist them via provider.saveTokens().
      const result = await auth(provider, { serverUrl: url, authorizationCode: code });
      if (result !== "AUTHORIZED") {
        throw new Error(`OAuth flow for "${serverName}" did not complete (result=${result})`);
      }

      // The PKCE verifier is single-use; drop it so it doesn't linger on disk.
      await provider.invalidateCredentials("verifier").catch(() => {});

      logger.info(`OAuth: "${serverName}" authorized`, { server: serverName });
      cleanup();

      return new StreamableHTTPClientTransport(url, {
        requestInit,
        authProvider: provider,
      });
    } catch (err) {
      cleanup();
      throw err;
    }
  }
  
  private async fetchAllTools(client: Client): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;
    
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    
    return allTools;
  }
  
  private async fetchAllResources(client: Client): Promise<McpResource[]> {
    try {
      const allResources: McpResource[] = [];
      let cursor: string | undefined;
      
      do {
        const result = await client.listResources(cursor ? { cursor } : undefined);
        allResources.push(...(result.resources ?? []));
        cursor = result.nextCursor;
      } while (cursor);
      
      return allResources;
    } catch {
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

  async readResource(name: string, uri: string): Promise<ReadResourceResult> {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.readResource({ uri });
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
  
  for (const [key, value] of Object.entries(env)) {
    // Support ${VAR} and $env:VAR interpolation
    resolved[key] = value
      .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
      .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
  }
  
  return resolved;
}

/**
 * Resolve headers with environment variable interpolation.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value
      .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
      .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
  }
  return resolved;
}
