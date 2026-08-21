import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { lazyConnect } from "../init.ts";
import { McpLifecycleManager } from "../lifecycle.ts";
import { executeCall } from "../proxy-modes.ts";
import { reconnectServers } from "../commands.ts";
import type { ToolRefreshResult } from "../server-manager.ts";
import type { ServerDefinition } from "../types.ts";

interface FakeConnection {
  status: "connected" | "closed" | "needs-auth";
  transport?: { sessionId?: string };
}

class FakeManager {
  connections = new Map<string, FakeConnection>();
  connectCalls: string[] = [];
  refreshToolsCalls: string[] = [];
  reconnectCalls: Array<{ name: string; staleConnection: FakeConnection }> = [];
  closeCalls: string[] = [];
  idleResponses = new Map<string, boolean>();
  connectError: Error | undefined;
  refreshToolsError: Error | undefined;
  refreshToolsResult: ToolRefreshResult = "unchanged";
  reconnectError: Error | undefined;
  reconnectStatus: FakeConnection["status"] = "connected";

  setConnection(name: string, status: FakeConnection["status"] | null, sessionId?: string): FakeConnection | undefined {
    if (status === null) {
      this.connections.delete(name);
      return undefined;
    } else {
      const connection = { status, transport: { sessionId } };
      this.connections.set(name, connection);
      return connection;
    }
  }

  getConnection(name: string): FakeConnection | undefined {
    return this.connections.get(name);
  }

  async connect(name: string): Promise<FakeConnection> {
    this.connectCalls.push(name);
    if (this.connectError) throw this.connectError;
    const connection: FakeConnection = { status: "connected" };
    this.connections.set(name, connection);
    return connection;
  }

  async refreshTools(name: string): Promise<ToolRefreshResult> {
    this.refreshToolsCalls.push(name);
    if (this.refreshToolsError) throw this.refreshToolsError;
    return this.refreshToolsResult;
  }

  async reconnect(name: string, _definition: ServerDefinition, staleConnection: FakeConnection): Promise<FakeConnection> {
    this.reconnectCalls.push({ name, staleConnection });
    if (this.reconnectError) {
      this.connections.delete(name);
      throw this.reconnectError;
    }
    const connection: FakeConnection = { status: this.reconnectStatus, transport: { sessionId: "fresh-session" } };
    this.connections.set(name, connection);
    return connection;
  }

  async close(name: string): Promise<void> {
    this.closeCalls.push(name);
    this.connections.delete(name);
  }

  isIdle(name: string): boolean {
    return this.idleResponses.get(name) ?? false;
  }
}

function makeDefinition(lifecycle: ServerDefinition["lifecycle"]): ServerDefinition {
  return { command: "echo", args: [], lifecycle };
}

describe("lazy-keep-alive lifecycle", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tempAgentDir: string;
  let fake: FakeManager;
  let lifecycle: McpLifecycleManager;

  beforeEach(() => {
    tempAgentDir = mkdtempSync(join(tmpdir(), "pi-mcp-lifecycle-"));
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;
    fake = new FakeManager();
    lifecycle = new McpLifecycleManager(fake as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(tempAgentDir, { recursive: true, force: true });
  });

  it("does not install a health interval for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    lifecycle.startHealthChecks(controller.signal, 1000);
    expect((lifecycle as any).healthCheckInterval).toBeUndefined();
  });

  it("consumes health-check rejections without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const def = makeDefinition("lazy");
    lifecycle.registerServer("srv", def, { idleTimeout: 1 });
    fake.setConnection("srv", "connected");
    fake.idleResponses.set("srv", true);
    fake.close = vi.fn(async () => { throw new Error("idle close failed \u001b]52;c;secret\u0007"); });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      lifecycle.startHealthChecks(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith("MCP: Health check failed: idle close failed");
    } finally {
      process.removeListener("unhandledRejection", unhandled);
      await lifecycle.gracefulShutdown().catch(() => {});
    }
  });

  it("reconnects after first spawn when the process dies", async () => {
    const def = makeDefinition("lazy-keep-alive");
    lifecycle.registerServer("srv", def, { idleTimeout: 0 });

    lifecycle.startHealthChecks(1000);
    await Promise.resolve();
    expect(fake.connectCalls).not.toContain("srv");

    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected");

    fake.setConnection("srv", null);
    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.connectCalls).toContain("srv");
  });

  it("actively refreshes connected keep-alive servers instead of trusting local status", async () => {
    const def = makeDefinition("keep-alive");
    def.url = "https://example.test/mcp";
    delete def.command;
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected");

    await lifecycle.ensureConverged();

    expect(fake.refreshToolsCalls).toEqual(["srv"]);
  });

  it("checks multiple connected keep-alive servers concurrently", async () => {
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("one", def);
    lifecycle.markKeepAlive("two", def);
    fake.setConnection("one", "connected");
    fake.setConnection("two", "connected");
    const resolvers = new Map<string, () => void>();
    const refreshTools = vi.spyOn(fake, "refreshTools").mockImplementation((name) =>
      new Promise<"unchanged">((resolve) => {
        resolvers.set(name, () => resolve("unchanged"));
      })
    );

    const convergence = lifecycle.ensureConverged();
    await Promise.resolve();

    expect(refreshTools).toHaveBeenCalledTimes(2);
    resolvers.get("one")?.();
    resolvers.get("two")?.();
    await convergence;
  });

  it("does not couple the input convergence barrier to unrelated idle shutdowns", async () => {
    const def = makeDefinition("lazy");
    lifecycle.registerServer("idle", def, { idleTimeout: 1 });
    fake.setConnection("idle", "connected");
    fake.idleResponses.set("idle", true);

    await lifecycle.ensureConverged();

    expect(fake.closeCalls).toEqual([]);
  });

  it("reconnects an apparently connected server when refresh proves its HTTP session expired", async () => {
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    const staleConnection = fake.setConnection("srv", "connected", "stale-session")!;
    fake.refreshToolsError = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "Session not found",
      { status: 404 },
    );

    await lifecycle.ensureConverged();

    expect(fake.reconnectCalls).toEqual([{ name: "srv", staleConnection }]);
  });

  it("publishes metadata when a concurrent recovery replaces the connection during refresh", async () => {
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "stale-session");
    const freshConnection: FakeConnection = {
      status: "connected",
      transport: { sessionId: "fresh-session" },
    };
    vi.spyOn(fake, "refreshTools").mockImplementation(async () => {
      fake.connections.set("srv", freshConnection);
      return "superseded";
    });
    const onReconnect = vi.fn();
    lifecycle.setReconnectCallback(onReconnect);

    await lifecycle.ensureConverged();

    expect(onReconnect).toHaveBeenCalledWith("srv");
  });

  it("rechecks when a refresh is superseded by the same connection closing", async () => {
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    const connection = fake.setConnection("srv", "connected", "stale-session")!;
    vi.spyOn(fake, "refreshTools").mockImplementation(async () => {
      connection.status = "closed";
      return "superseded";
    });

    await lifecycle.ensureConverged();

    expect(fake.connectCalls).toEqual(["srv"]);
  });

  it("publishes a concurrent replacement when the stale refresh rejects", async () => {
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "stale-session");
    const freshConnection: FakeConnection = {
      status: "connected",
      transport: { sessionId: "fresh-session" },
    };
    vi.spyOn(fake, "refreshTools").mockImplementation(async () => {
      fake.connections.set("srv", freshConnection);
      throw new Error("stale request closed");
    });
    const onReconnect = vi.fn();
    lifecycle.setReconnectCallback(onReconnect);

    await lifecycle.ensureConverged();

    expect(onReconnect).toHaveBeenCalledWith("srv");
  });

  it("retries metadata publication after a concurrent replacement hook fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "stale-session");
    const freshConnection: FakeConnection = {
      status: "connected",
      transport: { sessionId: "fresh-session" },
    };
    vi.spyOn(fake, "refreshTools").mockImplementation(async () => {
      fake.connections.set("srv", freshConnection);
      return "superseded";
    });
    const onReconnect = vi.fn()
      .mockRejectedValueOnce(new Error("metadata cache unavailable"))
      .mockResolvedValue(undefined);
    lifecycle.setReconnectCallback(onReconnect);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await lifecycle.ensureConverged();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    await lifecycle.ensureConverged();

    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("backs off repeated refresh failures and retries after the bounded delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "session");
    fake.refreshToolsError = new Error("temporarily unavailable");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onHealthRestored = vi.fn();
    lifecycle.setHealthRestoredCallback(onHealthRestored);

    await lifecycle.ensureConverged();
    await lifecycle.ensureConverged();
    expect(fake.refreshToolsCalls).toEqual(["srv"]);

    vi.advanceTimersByTime(30_000);
    fake.refreshToolsError = undefined;
    await lifecycle.ensureConverged();
    expect(fake.refreshToolsCalls).toEqual(["srv", "srv"]);
    expect(onHealthRestored).toHaveBeenCalledWith("srv");
  });

  it("backs off tools/list refresh timeouts without marking the connection failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "session");
    fake.refreshToolsResult = "refresh-timeout";
    const onFailure = vi.fn();
    lifecycle.setReconnectFailureCallback(onFailure);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await lifecycle.ensureConverged();
    await lifecycle.ensureConverged();

    expect(fake.refreshToolsCalls).toEqual(["srv"]);
    expect(onFailure).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(fake.getConnection("srv")?.status).toBe("connected");
  });

  it("reports one terminal warning per outage while preserving health callbacks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "session");
    fake.refreshToolsError = new Error("temporarily unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn();
    const onHealthRestored = vi.fn();
    lifecycle.setReconnectFailureCallback(onFailure);
    lifecycle.setHealthRestoredCallback(onHealthRestored);

    await lifecycle.ensureConverged();
    vi.advanceTimersByTime(30_000);
    await lifecycle.ensureConverged();

    expect(fake.refreshToolsCalls).toEqual(["srv", "srv"]);
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledTimes(1);

    fake.refreshToolsError = undefined;
    vi.advanceTimersByTime(60_000);
    await lifecycle.ensureConverged();
    expect(onHealthRestored).toHaveBeenCalledWith("srv");

    fake.refreshToolsError = new Error("temporarily unavailable again");
    await lifecycle.ensureConverged();
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it("silences transient HTTP 503 refresh failures but reports later permanent failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "session");
    fake.refreshToolsError = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "Error POSTing to endpoint: temporarily unavailable",
      { status: 503 },
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn();
    lifecycle.setReconnectFailureCallback(onFailure);

    await lifecycle.ensureConverged();
    vi.advanceTimersByTime(30_000);
    await lifecycle.ensureConverged();

    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(consoleError).not.toHaveBeenCalled();

    fake.refreshToolsError = new Error("permanent failure");
    vi.advanceTimersByTime(60_000);
    await lifecycle.ensureConverged();
    vi.advanceTimersByTime(120_000);
    await lifecycle.ensureConverged();

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("MCP: Failed to refresh srv: permanent failure");
  });

  it("silences transient HTTP 503 reconnect failures wrapped by the server manager", async () => {
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "stale-session");
    fake.refreshToolsError = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "Session not found",
      { status: 404 },
    );
    const unavailable = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "temporarily unavailable",
      { status: 503 },
    );
    fake.reconnectError = new Error("endpoint is temporarily unavailable (HTTP 503)", {
      cause: unavailable,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn();
    lifecycle.setReconnectFailureCallback(onFailure);

    await lifecycle.ensureConverged();

    expect(onFailure).toHaveBeenCalledWith("srv", fake.reconnectError);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reconnects immediately when a backed-off connection closes in place", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    const connection = fake.setConnection("srv", "connected", "session")!;
    fake.refreshToolsError = new Error("temporarily unavailable");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await lifecycle.ensureConverged();
    connection.status = "closed";
    await lifecycle.ensureConverged();

    expect(fake.connectCalls).toEqual(["srv"]);
  });

  it("keeps backoff after a stale-session reconnect closes the old connection and fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "stale-session");
    fake.refreshToolsError = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "Session not found",
      { status: 404 },
    );
    fake.reconnectError = new Error("replacement unavailable");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await lifecycle.ensureConverged();
    await lifecycle.ensureConverged();

    expect(fake.refreshToolsCalls).toEqual(["srv"]);
    expect(fake.reconnectCalls).toHaveLength(1);
    expect(fake.connectCalls).toEqual([]);
  });

  it("parks a reconnect that returns needs-auth instead of reporting success or retrying", async () => {
    const def: ServerDefinition = { url: "https://example.test/mcp", lifecycle: "keep-alive" };
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "connected", "stale-session");
    fake.refreshToolsError = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "Session not found",
      { status: 404 },
    );
    fake.reconnectStatus = "needs-auth";
    const onReconnect = vi.fn();
    const onAuthRequired = vi.fn();
    lifecycle.setReconnectCallback(onReconnect);
    lifecycle.setAuthRequiredCallback(onAuthRequired);

    await lifecycle.ensureConverged();
    await lifecycle.ensureConverged();

    expect(fake.reconnectCalls).toHaveLength(1);
    expect(fake.connectCalls).toEqual([]);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(onAuthRequired).toHaveBeenCalledWith("srv");
  });

  it("records reconnect failures and clears them after a later success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const def = makeDefinition("keep-alive");
    lifecycle.markKeepAlive("srv", def);
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    lifecycle.setReconnectFailureCallback(onFailure);
    lifecycle.setReconnectCallback(onSuccess);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.connectError = new Error("server exited \x1b]52;c;clipboard-secret\x07safely");

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(onFailure).toHaveBeenCalledWith("srv", fake.connectError);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("MCP: Failed to reconnect to srv: server exited safely");
    expect(consoleError.mock.calls[0][0]).not.toContain("clipboard-secret");

    fake.connectError = undefined;
    vi.advanceTimersByTime(30_000);
    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(onSuccess).toHaveBeenCalledWith("srv");
  });

  it("does not reconnect keep-alive servers while OAuth authorization is pending", async () => {
    const def = makeDefinition("keep-alive");
    lifecycle = new McpLifecycleManager(fake as never, name => name === "srv");
    lifecycle.registerServer("srv", def, { idleTimeout: 0 });
    lifecycle.markKeepAlive("srv", def);
    fake.setConnection("srv", "needs-auth");

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.connectCalls).not.toContain("srv");
  });

  it("never idle-shuts a server registered with idleTimeout 0", async () => {
    const def = makeDefinition("lazy-keep-alive");
    lifecycle.registerServer("srv", def, { idleTimeout: 0 });
    fake.setConnection("srv", "connected");
    fake.idleResponses.set("srv", true);

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.closeCalls).not.toContain("srv");
  });

  it("idle-shuts a plain lazy server past its timeout", async () => {
    const def = makeDefinition("lazy");
    lifecycle.registerServer("srv", def, { idleTimeout: 1 });
    fake.setConnection("srv", "connected");
    fake.idleResponses.set("srv", true);

    await (lifecycle as never as { checkConnections: () => Promise<void> }).checkConnections();

    expect(fake.closeCalls).toContain("srv");
  });

  it("marks lazyConnect first spawns for health-check reconnects", async () => {
    const connection = {
      status: "connected" as const,
      tools: [],
      resources: [],
    };
    let current: typeof connection | undefined;
    const manager = {
      getConnection: vi.fn(() => current),
      getAllConnections: vi.fn(() => current ? new Map([["srv", current]]) : new Map()),
      connect: vi.fn(async () => {
        current = connection;
        return connection;
      }),
      isIdle: vi.fn(() => false),
    };
    const setStatus = vi.fn();
    const state = {
      config: { settings: { showStatusIcon: false }, mcpServers: { srv: makeDefinition("lazy-keep-alive") } },
      manager,
      lifecycle: new McpLifecycleManager(manager as never),
      ui: { setStatus },
      toolMetadata: new Map(),
      serverInstructions: new Map(),
      failureTracker: new Map(),
    } as never;

    await lazyConnect(state, "srv");
    expect(setStatus).toHaveBeenCalledWith("mcp", "MCP: connecting to srv...");
    current = undefined;
    await (state as any).lifecycle.checkConnections();

    expect(manager.connect).toHaveBeenCalledTimes(2);
  });

  it("marks cached proxy first-use connects for health-check reconnects", async () => {
    const connection = {
      status: "connected" as const,
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
      resources: [],
      client: { callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })) },
    };
    let current: typeof connection | undefined;
    const manager = {
      getConnection: vi.fn(() => current),
      connect: vi.fn(async () => {
        current = connection;
        return connection;
      }),
      isIdle: vi.fn(() => false),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    };
    const state = {
      config: { settings: { toolPrefix: "server" }, mcpServers: { srv: makeDefinition("lazy-keep-alive") } },
      manager,
      lifecycle: new McpLifecycleManager(manager as never),
      toolMetadata: new Map([["srv", [{ name: "srv_search", originalName: "search", description: "Search" }]]]),
      serverInstructions: new Map(),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as never;

    const result = await executeCall(state, "srv_search", {}, "srv");
    expect(result.content[0]?.text).toBe("ok");

    current = undefined;
    await (state as any).lifecycle.checkConnections();

    expect(manager.connect).toHaveBeenCalledTimes(2);
  });

  it("marks manual reconnects for lazy-keep-alive servers", async () => {
    const connection = {
      status: "connected" as const,
      tools: [],
      resources: [],
    };
    let current: typeof connection | undefined;
    const manager = {
      close: vi.fn(async () => {
        current = undefined;
      }),
      getConnection: vi.fn(() => current),
      connect: vi.fn(async () => {
        current = connection;
        return connection;
      }),
      isIdle: vi.fn(() => false),
    };
    const state = {
      config: { settings: {}, mcpServers: { srv: makeDefinition("lazy-keep-alive") } },
      manager,
      lifecycle: new McpLifecycleManager(manager as never),
      toolMetadata: new Map(),
      serverInstructions: new Map(),
      failureTracker: new Map(),
    } as never;

    await reconnectServers(state, { hasUI: false } as never, "srv");
    current = undefined;
    await (state as any).lifecycle.checkConnections();

    expect(manager.connect).toHaveBeenCalledTimes(2);
  });

  it("closes a keep-alive connection when the server is unregistered mid-connect", async () => {
    const def = makeDefinition("keep-alive");
    lifecycle.registerServer("srv", def);
    lifecycle.markKeepAlive("srv", def);

    let resolveConnect!: (connection: FakeConnection) => void;
    fake.connect = vi.fn((name: string) => {
      fake.connectCalls.push(name);
      return new Promise<FakeConnection>((resolve) => {
        resolveConnect = (connection) => {
          fake.connections.set(name, connection);
          resolve(connection);
        };
      });
    }) as never;

    const convergence = lifecycle.ensureConverged();
    await Promise.resolve();
    expect(fake.connectCalls).toContain("srv");

    lifecycle.unregisterServer("srv");
    resolveConnect({ status: "connected" });
    await convergence;

    expect(fake.closeCalls).toContain("srv");
    expect(fake.connections.has("srv")).toBe(false);
  });

  it("does not record retry state from a stale pass against a same-name replacement", async () => {
    const def = makeDefinition("keep-alive");
    lifecycle.registerServer("srv", def);
    lifecycle.markKeepAlive("srv", def);

    let rejectConnect!: (error: Error) => void;
    fake.connect = vi.fn((name: string) => {
      fake.connectCalls.push(name);
      return new Promise<FakeConnection>((_resolve, reject) => {
        rejectConnect = reject;
      });
    }) as never;

    const convergence = lifecycle.ensureConverged();
    await Promise.resolve();
    expect(fake.connectCalls).toContain("srv");

    // Dispose, then immediately register a replacement under the same name.
    lifecycle.unregisterServer("srv");
    const replacement = makeDefinition("keep-alive");
    lifecycle.registerServer("srv", replacement);
    lifecycle.markKeepAlive("srv", replacement);

    rejectConnect(new Error("connection closed during dispose"));
    await convergence;

    expect((lifecycle as any).retryStates.has("srv")).toBe(false);
  });
});
