import type { ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { McpEventBus, NOOP_EVENT_BUS, type McpTransportKind } from "./mcp-events.ts";
import { logger } from "./logger.ts";

export type ReconnectCallback = (serverName: string) => void;

/**
 * Best-effort transport label from config alone — used before a connection
 * exists (the `reconnecting` event). The precise sse-vs-http distinction is
 * carried by the connection-lifecycle events emitted from the manager.
 */
function definitionTransportKind(definition: ServerDefinition): McpTransportKind {
  return definition.command ? "stdio" : "http";
}

export class McpLifecycleManager {
  private manager: McpServerManager;
  private keepAliveServers = new Map<string, ServerDefinition>();
  private allServers = new Map<string, ServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout: number = 10 * 60 * 1000;
  private healthCheckInterval?: NodeJS.Timeout;
  private onReconnect?: ReconnectCallback;
  private onIdleShutdown?: (serverName: string) => void;
  private events: McpEventBus = NOOP_EVENT_BUS;

  constructor(manager: McpServerManager) {
    this.manager = manager;
  }

  /** Wire the lifecycle event bus. No-op bus until `init.ts` provides PI's. */
  setEventBus(bus: McpEventBus): void {
    this.events = bus;
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
  
  startHealthChecks(intervalMs = 30000): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkConnections();
    }, intervalMs);
    this.healthCheckInterval.unref();
  }
  
  private async checkConnections(): Promise<void> {
    for (const [name, definition] of this.keepAliveServers) {
      const connection = this.manager.getConnection(name);
      
      if (!connection || connection.status !== "connected") {
        this.events.emitServer(
          name,
          this.manager.getTransportKind(name) ?? definitionTransportKind(definition),
          "reconnecting",
        );
        try {
          await this.manager.connect(name, definition);
          logger.debug(`Reconnected to ${name}`);
          this.events.emitServer(
            name,
            this.manager.getTransportKind(name) ?? definitionTransportKind(definition),
            "reconnected",
          );
          // Notify extension to update metadata
          this.onReconnect?.(name);
        } catch (error) {
          console.error(`MCP: Failed to reconnect to ${name}:`, error);
        }
      }
    }

    for (const [name] of this.allServers) {
      if (this.keepAliveServers.has(name)) continue;
      const timeout = this.getIdleTimeout(name);
      if (timeout > 0 && this.manager.isIdle(name, timeout)) {
        // close() with reason "idle" emits the idle_shutdown phase itself.
        await this.manager.close(name, { reason: "idle" });
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
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    await this.manager.closeAll();
  }
}
