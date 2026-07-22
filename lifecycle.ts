import type { ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { logger } from "./logger.ts";

export type ReconnectCallback = (serverName: string) => void;

export class McpLifecycleManager {
  private manager: McpServerManager;
  private keepAliveServers = new Map<string, ServerDefinition>();
  private allServers = new Map<string, ServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout: number = 10 * 60 * 1000;
  private healthCheckInterval?: NodeJS.Timeout;
  private onReconnect?: ReconnectCallback;
  private onIdleShutdown?: (serverName: string) => void;
  private activeHealthCheck?: Promise<void>;
  private stopped = false;
  
  constructor(manager: McpServerManager) {
    this.manager = manager;
  }
  
  /**
   * Set callback to be invoked after a successful auto-reconnect.
   * Use this to update tool metadata when a server reconnects.
   */
  setReconnectCallback(callback: ReconnectCallback): void {
    this.onReconnect = callback;
  }
  
  markKeepAlive(name: string, definition: ServerDefinition): void {
    this.keepAliveServers.set(name, definition);
  }

  registerServer(name: string, definition: ServerDefinition, settings?: { idleTimeout?: number }): void {
    this.allServers.set(name, definition);
    if (settings?.idleTimeout !== undefined) {
      this.serverSettings.set(name, settings);
    }
  }

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleTimeout = minutes * 60 * 1000;
  }

  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }
  
  startHealthChecks(signal?: AbortSignal, intervalMs = 30000): void {
    this.stopped = false;
    const stop = () => {
      this.stopped = true;
      if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    };
    signal?.addEventListener("abort", stop, { once: true });
    this.healthCheckInterval = setInterval(() => {
      if (this.stopped || signal?.aborted || this.activeHealthCheck) return;
      const check = this.checkConnections(signal).finally(() => {
        if (this.activeHealthCheck === check) this.activeHealthCheck = undefined;
      });
      this.activeHealthCheck = check;
    }, intervalMs);
    this.healthCheckInterval.unref();
  }
  
  private async checkConnections(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return;
    for (const [name, definition] of this.keepAliveServers) {
      const connection = this.manager.getConnection(name);
      
      if (!connection || connection.status !== "connected") {
        try {
          await this.manager.connect(name, definition, signal);
          if (this.stopped || signal?.aborted) return;
          logger.debug(`Reconnected to ${name}`);
          this.onReconnect?.(name);
        } catch (error) {
          if (this.stopped || signal?.aborted) return;
          console.error(`MCP: Failed to reconnect to ${name}:`, error);
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
    this.stopped = true;
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = undefined;
    await this.manager.closeAll();
    await this.activeHealthCheck?.catch(() => {});
    this.onReconnect = undefined;
    this.onIdleShutdown = undefined;
  }
}
