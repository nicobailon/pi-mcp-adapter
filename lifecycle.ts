import { isServerDisabled, type ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { hasPendingAuth } from "./mcp-auth-flow.ts";
import { logger } from "./logger.ts";
import { formatTerminalError, sanitizeTerminalText } from "./utils.ts";

export type ReconnectCallback = (serverName: string) => void;
export type ReconnectFailureCallback = (serverName: string, error: unknown) => void;

export class McpLifecycleManager {
  private keepAliveServers = new Map<string, ServerDefinition>();
  private allServers = new Map<string, ServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout = 10 * 60 * 1000;
  private healthCheckInterval: NodeJS.Timeout | undefined;
  private onReconnect: ReconnectCallback | undefined;
  private onReconnectFailure: ReconnectFailureCallback | undefined;
  private onIdleShutdown: ((serverName: string) => void) | undefined;
  private activeHealthCheck: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
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

  private async checkConnections(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return;
    for (const [name, definition] of this.keepAliveServers) {
      if (isServerDisabled(definition)) continue;
      const connection = this.manager.getConnection(name);
      if (!connection || connection.status !== "connected") {
        if (this.hasPendingAuthForServer(name)) {
          logger.debug(`Skipping reconnect for ${name} while OAuth authorization is pending`);
          continue;
        }
        try {
          await this.manager.connect(name, definition, signal);
          if (this.stopped || signal?.aborted) return;
          logger.debug(`Reconnected to ${name}`);
          this.onReconnect?.(name);
        } catch (error) {
          if (this.stopped || signal?.aborted) return;
          this.onReconnectFailure?.(name, error);
          const message = error instanceof Error ? error.message : String(error);
          console.error(`MCP: Failed to reconnect to ${name}: ${sanitizeTerminalText(message)}`);
        }
      }
    }

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
    this.onReconnect = undefined;
    this.onReconnectFailure = undefined;
    this.onIdleShutdown = undefined;
    if (typeof this.manager.closeAll === "function") {
      await this.manager.closeAll();
    }
  }
}
