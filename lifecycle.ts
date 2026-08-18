import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { isServerDisabled, type ServerDefinition } from "./types.ts";
import type { McpServerManager, ServerConnection } from "./server-manager.ts";
import { hasPendingAuth } from "./mcp-auth-flow.ts";
import { logger } from "./logger.ts";
import { formatTerminalError, parallelLimit, sanitizeTerminalText } from "./utils.ts";
import { isTerminatedSession } from "./session-recovery.ts";

export type ReconnectCallback = (serverName: string) => void | Promise<void>;
export type ReconnectFailureCallback = (serverName: string, error: unknown) => void;
export type HealthRestoredCallback = (serverName: string) => void | Promise<void>;
export type AuthRequiredCallback = (serverName: string) => void | Promise<void>;

const KEEP_ALIVE_RETRY_BASE_MS = 30_000;
const KEEP_ALIVE_RETRY_MAX_MS = 5 * 60_000;
const KEEP_ALIVE_CHECK_CONCURRENCY = 10;

interface RetryState {
  attempts: number;
  nextAttemptAt: number;
  connection: ServerConnection | undefined;
  status: ServerConnection["status"] | undefined;
}

export class McpLifecycleManager {
  private keepAliveServers = new Map<string, ServerDefinition>();
  private allServers = new Map<string, ServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout = 10 * 60 * 1000;
  private healthCheckInterval: NodeJS.Timeout | undefined;
  private onReconnect: ReconnectCallback | undefined;
  private onReconnectFailure: ReconnectFailureCallback | undefined;
  private onHealthRestored: HealthRestoredCallback | undefined;
  private onAuthRequired: AuthRequiredCallback | undefined;
  private onIdleShutdown: ((serverName: string) => void) | undefined;
  private activeHealthCheck: Promise<void> | undefined;
  private activeConvergence: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private retryStates = new Map<string, RetryState>();
  private pendingMetadataPublications = new Set<string>();
  private stopped = false;
  private removeHealthAbortListener: (() => void) | undefined;

  constructor(
    private readonly manager: McpServerManager,
    private readonly hasPendingAuthForServer = hasPendingAuth,
  ) {}

  setReconnectCallback(callback: ReconnectCallback): void {
    this.onReconnect = callback;
  }

  setReconnectFailureCallback(callback: ReconnectFailureCallback): void {
    this.onReconnectFailure = callback;
  }

  setHealthRestoredCallback(callback: HealthRestoredCallback): void {
    this.onHealthRestored = callback;
  }

  setAuthRequiredCallback(callback: AuthRequiredCallback): void {
    this.onAuthRequired = callback;
  }

  markKeepAlive(name: string, definition: ServerDefinition): void {
    if (isServerDisabled(definition)) return;
    this.keepAliveServers.set(name, definition);
  }

  registerServer(name: string, definition: ServerDefinition, settings?: { idleTimeout?: number }): void {
    if (isServerDisabled(definition)) return;
    this.allServers.set(name, definition);
    if (settings?.idleTimeout !== undefined) this.serverSettings.set(name, settings);
  }

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleTimeout = minutes * 60 * 1000;
  }

  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }

  startHealthChecks(signalOrInterval?: AbortSignal | number, maybeIntervalMs = 30000): void {
    const signal = typeof signalOrInterval === "number" ? undefined : signalOrInterval;
    const intervalMs = typeof signalOrInterval === "number" ? signalOrInterval : maybeIntervalMs;
    this.stopped = false;
    if (signal?.aborted) {
      this.stopped = true;
      return;
    }
    const stop = () => {
      this.stopped = true;
      if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    };
    signal?.addEventListener("abort", stop, { once: true });
    this.removeHealthAbortListener = () => signal?.removeEventListener("abort", stop);
    this.healthCheckInterval = setInterval(() => {
      if (this.stopped || signal?.aborted || this.activeHealthCheck) return;
      const check = this.checkConnections(signal)
        .catch(error => {
          console.error(`MCP: Health check failed: ${formatTerminalError(error)}`);
        })
        .finally(() => {
          if (this.activeHealthCheck === check) this.activeHealthCheck = undefined;
        });
      this.activeHealthCheck = check;
    }, intervalMs);
    this.healthCheckInterval.unref();
  }

  async ensureConverged(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return;
    if (this.activeConvergence) return this.activeConvergence;

    const check = this.checkKeepAliveConnections(signal);
    this.activeConvergence = check;
    try {
      await check;
    } finally {
      if (this.activeConvergence === check) this.activeConvergence = undefined;
    }
  }

  private async checkConnections(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return;
    await this.ensureConverged(signal);
    if (this.stopped || signal?.aborted) return;

    for (const [name] of this.allServers) {
      if (this.keepAliveServers.has(name)) continue;
      const timeout = this.getIdleTimeout(name);
      if (timeout > 0 && this.manager.isIdle(name, timeout)) {
        await this.manager.close(name);
        if (this.stopped || signal?.aborted) return;
        this.onIdleShutdown?.(name);
      }
    }
  }

  private async checkKeepAliveConnections(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return;
    await parallelLimit(
      [...this.keepAliveServers],
      KEEP_ALIVE_CHECK_CONCURRENCY,
      ([name, definition]) => this.checkKeepAliveConnection(name, definition, signal),
    );
  }

  private async checkKeepAliveConnection(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
    retrySuperseded = true,
  ): Promise<void> {
    if (isServerDisabled(definition) || this.stopped || signal?.aborted) return;
    const connection = this.manager.getConnection(name);
    if (connection?.status === "needs-auth") {
      this.pendingMetadataPublications.delete(name);
      return;
    }
    if (!this.shouldAttemptConnection(name, connection)) return;
    if (!connection || connection.status !== "connected") {
      if (this.hasPendingAuthForServer(name)) {
        logger.debug(`Skipping reconnect for ${name} while OAuth authorization is pending`);
        return;
      }
      let freshConnection: ServerConnection;
      try {
        freshConnection = await this.manager.connect(name, definition, signal);
      } catch (error) {
        if (this.stopped || signal?.aborted) return;
        this.reportConnectionFailure(name, error, "reconnect", this.manager.getConnection(name));
        return;
      }
      if (this.stopped || signal?.aborted) return;
      if (freshConnection.status === "needs-auth") {
        await this.notifyAuthRequired(name);
        return;
      }
      if (freshConnection.status !== "connected") {
        this.reportConnectionFailure(
          name,
          new Error(`MCP server ${name} did not return a connected session`),
          "reconnect",
          freshConnection,
        );
        return;
      }
      logger.debug(`Reconnected to ${name}`);
      await this.publishConnectedMetadata(name, freshConnection);
      return;
    }

    if (this.pendingMetadataPublications.has(name)) {
      await this.publishConnectedMetadata(name, connection);
      return;
    }
    if (!definition.url) return;
    const hadSessionId = (connection.transport as { sessionId?: string } | undefined)?.sessionId != null;
    let refreshResult: Awaited<ReturnType<McpServerManager["refreshTools"]>>;
    try {
      refreshResult = await this.manager.refreshTools(name, connection, signal);
    } catch (error) {
      if (this.stopped || signal?.aborted) return;
      const current = this.manager.getConnection(name);
      if (current !== connection || connection.status !== "connected") {
        await this.handleSupersededConnection(name, definition, connection, signal, retrySuperseded);
        return;
      }
      if (!shouldReconnectAfterRefresh(error, hadSessionId)) {
        this.reportConnectionFailure(name, error, "refresh", connection);
        return;
      }
      if (this.hasPendingAuthForServer(name)) {
        logger.debug(`Skipping reconnect for ${name} while OAuth authorization is pending`);
        return;
      }
      let freshConnection: ServerConnection;
      try {
        freshConnection = await this.manager.reconnect(name, definition, connection, signal);
      } catch (reconnectError) {
        if (this.stopped || signal?.aborted) return;
        this.reportConnectionFailure(name, reconnectError, "reconnect", this.manager.getConnection(name));
        return;
      }
      if (this.stopped || signal?.aborted) return;
      if (freshConnection.status === "needs-auth") {
        await this.notifyAuthRequired(name);
        return;
      }
      if (freshConnection.status !== "connected") {
        this.reportConnectionFailure(
          name,
          new Error(`MCP server ${name} did not return a connected session`),
          "reconnect",
          freshConnection,
        );
        return;
      }
      logger.debug(`Reconnected stale MCP session for ${name}`);
      await this.publishConnectedMetadata(name, freshConnection);
      return;
    }

    if (refreshResult === "superseded") {
      await this.handleSupersededConnection(name, definition, connection, signal, retrySuperseded);
      return;
    }
    if (this.retryStates.delete(name)) {
      await this.onHealthRestored?.(name);
    }
  }

  private async handleSupersededConnection(
    name: string,
    definition: ServerDefinition,
    staleConnection: ServerConnection,
    signal: AbortSignal | undefined,
    retrySuperseded: boolean,
  ): Promise<void> {
    const current = this.manager.getConnection(name);
    if (current === staleConnection && current.status === "connected") {
      if (this.retryStates.delete(name)) await this.onHealthRestored?.(name);
      return;
    }
    if (current?.status === "connected") {
      await this.publishConnectedMetadata(name, current);
      return;
    }
    if (current?.status === "needs-auth") {
      await this.notifyAuthRequired(name);
      return;
    }
    if (retrySuperseded) {
      await this.checkKeepAliveConnection(name, definition, signal, false);
    }
  }

  private async publishConnectedMetadata(name: string, connection: ServerConnection): Promise<void> {
    this.pendingMetadataPublications.add(name);
    try {
      await this.onReconnect?.(name);
      this.pendingMetadataPublications.delete(name);
      this.retryStates.delete(name);
    } catch (error) {
      if (this.stopped) return;
      this.reportConnectionFailure(name, error, "publish", connection);
    }
  }

  private async notifyAuthRequired(name: string): Promise<void> {
    this.pendingMetadataPublications.delete(name);
    this.retryStates.delete(name);
    try {
      await this.onAuthRequired?.(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`MCP: auth-required callback failed for ${name}: ${sanitizeTerminalText(message)}`);
    }
  }

  private shouldAttemptConnection(name: string, connection: ServerConnection | undefined): boolean {
    const retry = this.retryStates.get(name);
    if (!retry) return true;
    if (retry.connection !== connection || retry.status !== connection?.status) {
      this.retryStates.delete(name);
      return true;
    }
    return Date.now() >= retry.nextAttemptAt;
  }

  private reportConnectionFailure(
    name: string,
    error: unknown,
    action: "refresh" | "reconnect" | "publish",
    connection: ServerConnection | undefined,
  ): void {
    const attempts = (this.retryStates.get(name)?.attempts ?? 0) + 1;
    const delay = Math.min(
      KEEP_ALIVE_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 10),
      KEEP_ALIVE_RETRY_MAX_MS,
    );
    this.retryStates.set(name, {
      attempts,
      nextAttemptAt: Date.now() + delay,
      connection,
      status: connection?.status,
    });
    this.onReconnectFailure?.(name, error);
    const message = error instanceof Error ? error.message : String(error);
    const target = action === "reconnect"
      ? `reconnect to ${name}`
      : action === "publish"
        ? `publish metadata for ${name}`
        : `refresh ${name}`;
    console.error(`MCP: Failed to ${target}: ${sanitizeTerminalText(message)}`);
  }

  private getIdleTimeout(name: string): number {
    const perServer = this.serverSettings.get(name)?.idleTimeout;
    if (perServer !== undefined) return perServer * 60 * 1000;
    return this.globalIdleTimeout;
  }

  async gracefulShutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    this.stopped = true;
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = undefined;
    this.removeHealthAbortListener?.();
    this.removeHealthAbortListener = undefined;
    await this.activeHealthCheck;
    this.activeHealthCheck = undefined;
    await this.activeConvergence;
    this.activeConvergence = undefined;
    this.onReconnect = undefined;
    this.onReconnectFailure = undefined;
    this.onHealthRestored = undefined;
    this.onAuthRequired = undefined;
    this.onIdleShutdown = undefined;
    this.retryStates.clear();
    this.pendingMetadataPublications.clear();
    if (typeof this.manager.closeAll === "function") {
      await this.manager.closeAll();
    }
  }
}

function shouldReconnectAfterRefresh(error: unknown, hadSessionId: boolean): boolean {
  if (isTerminatedSession(error, hadSessionId)) return true;
  return error instanceof SdkError
    && (error.code === SdkErrorCode.NotConnected || error.code === SdkErrorCode.ConnectionClosed);
}
