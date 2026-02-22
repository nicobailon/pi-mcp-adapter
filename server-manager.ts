// server-manager.ts - MCP connection management (stdio + HTTP)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpTool, McpResource, ServerDefinition, Transport } from "./types.js";
import { McpOAuthProvider } from "./mcp-oauth-provider.js";
import { resolveNpxBinary } from "./npx-resolver.js";
import { supportsOAuth } from "./mcp-auth-flow.js";

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

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private pendingAuthTransports = new Map<string, StreamableHTTPClientTransport | SSEClientTransport>();
  
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
    const client = new Client({ name: `pi-mcp-${name}`, version: "2.1.2" });
    
    let transport: Transport;
    
    if (definition.command) {
      let command = definition.command;
      let args = definition.args ?? [];

      if (command === "npx" || command === "npm") {
        const resolved = await resolveNpxBinary(command, args);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          console.log(`MCP: ${name} resolved to ${resolved.binPath} (skipping npm parent)`);
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
      // HTTP transport with OAuth support via SDK
      transport = await this.createHttpTransport(definition, name);
    } else {
      throw new Error(`Server ${name} has no command or url`);
    }
    
    try {
      await client.connect(transport);
      
      // Clear any pending auth transport on successful connection
      this.pendingAuthTransports.delete(name);
      
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
      // Check for UnauthorizedError - server requires OAuth
      if (error instanceof UnauthorizedError && supportsOAuth(definition)) {
        // Store transport for later auth completion
        if (transport instanceof StreamableHTTPClientTransport || transport instanceof SSEClientTransport) {
          this.pendingAuthTransports.set(name, transport);
        }
        
        // Clean up the client but keep the transport
        await client.close().catch(() => {});
        
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
  
  private async createHttpTransport(
    definition: ServerDefinition, 
    serverName: string
  ): Promise<Transport> {
    const url = new URL(definition.url!);
    
    // Build request init with headers (excluding Authorization - SDK handles that)
    const headers = resolveHeaders(definition.headers) ?? {};
    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    
    // For OAuth servers, create an auth provider
    let authProvider: McpOAuthProvider | undefined;
    if (supportsOAuth(definition)) {
      // Extract OAuth config (handles both object and false cases)
      const oauthConfig = definition.oauth === false ? {} : {
        clientId: definition.oauth?.clientId,
        clientSecret: definition.oauth?.clientSecret,
        scope: definition.oauth?.scope,
      };
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
    
    // For bearer auth, add the token to headers
    if (definition.auth === "bearer") {
      const token = definition.bearerToken 
        ?? (definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined);
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }
    
    // Try StreamableHTTP first (modern MCP servers)
    const streamableTransport = new StreamableHTTPClientTransport(url, { 
      requestInit,
      authProvider,
    });
    
    try {
      // Create a test client to verify the transport works
      const testClient = new Client({ name: "pi-mcp-probe", version: "2.1.2" });
      await testClient.connect(streamableTransport);
      await testClient.close().catch(() => {});
      // Close probe transport before creating fresh one
      await streamableTransport.close().catch(() => {});
      
      // StreamableHTTP works - create fresh transport for actual use
      return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
    } catch (error) {
      // StreamableHTTP failed, close and try SSE fallback
      await streamableTransport.close().catch(() => {});
      
      // If this was an UnauthorizedError, don't try SSE - the server needs auth
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      
      // SSE is the legacy transport
      return new SSEClientTransport(url, { requestInit, authProvider });
    }
  }
  
  /**
   * Complete OAuth authentication for a server that needs auth.
   * This should be called after the user has authorized in the browser.
   * 
   * @param serverName - The name of the server to complete auth for
   * @param authorizationCode - The authorization code from the callback
   * @returns The updated connection
   */
  async completeAuth(
    serverName: string, 
    authorizationCode: string
  ): Promise<ServerConnection> {
    const transport = this.pendingAuthTransports.get(serverName);
    if (!transport) {
      throw new Error(`No pending OAuth flow for server: ${serverName}`);
    }
    
    // Complete the auth using the transport's finishAuth method
    await transport.finishAuth(authorizationCode);
    
    // Clear the pending transport
    this.pendingAuthTransports.delete(serverName);
    
    // Now create the actual connection
    const definition = this.connections.get(serverName)?.definition;
    if (!definition) {
      throw new Error(`Server ${serverName} not found in connections`);
    }
    
    // Close the old connection if it exists
    const existing = this.connections.get(serverName);
    if (existing) {
      await existing.client.close().catch(() => {});
      await existing.transport.close().catch(() => {});
      this.connections.delete(serverName);
    }
    
    // Create a fresh connection
    return this.connect(serverName, definition);
  }
  
  /**
   * Get the pending auth transport for a server.
   * This is used during the OAuth flow to complete authentication.
   */
  getPendingAuthTransport(serverName: string): StreamableHTTPClientTransport | SSEClientTransport | undefined {
    return this.pendingAuthTransports.get(serverName);
  }
  
  /**
   * Check if a server has a pending OAuth flow.
   */
  hasPendingAuth(serverName: string): boolean {
    return this.pendingAuthTransports.has(serverName);
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
  
  async close(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    
    // Delete from map BEFORE async cleanup to prevent a race where a
    // concurrent connect() creates a new connection that our deferred
    // delete() would then remove, orphaning the new server process.
    connection.status = "closed";
    this.connections.delete(name);
    this.pendingAuthTransports.delete(name);
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
    if (connection.inFlight && connection.inFlight > 0) return false;
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
