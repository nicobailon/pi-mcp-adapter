import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpLifecycleManager } from "../lifecycle.ts";
import { createMcpRuntimeOwner, createOwnedUi } from "../runtime-owner.ts";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  transports: [] as any[],
  connectGate: null as null | { promise: Promise<void>; resolve(): void; reject(error: Error): void },
  listToolsGate: null as null | { promise: Promise<void>; resolve(): void },
}));

function deferred(rejectable = false) {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject: rejectable ? reject : reject };
}

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (this: any) {
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn(async () => { await mocks.connectGate?.promise; });
    this.listTools = vi.fn(async () => { await mocks.listToolsGate?.promise; return { tools: [] }; });
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any) {
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: vi.fn() }));
vi.mock("../npx-resolver.ts", () => ({ resolveNpxBinary: vi.fn(async () => null) }));

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.transports.length = 0;
  mocks.connectGate = null;
  mocks.listToolsGate = null;
  vi.useRealTimers();
});

describe("MCP runtime ownership across Pi reload", () => {
  it("reproduces the 2.10.0 stale-context race deterministically", async () => {
    const gate = deferred();
    const staleContext = new Proxy({ hasUI: true, ui: { notify: vi.fn() } }, {
      get(target, property, receiver) {
        if (property === "hasUI") throw new Error("This extension ctx is stale after session replacement or reload");
        return Reflect.get(target, property, receiver);
      },
    });
    const oldInitialization = (async () => {
      await gate.promise;
      return (staleContext as any).hasUI;
    })();

    gate.resolve();
    await expect(oldInitialization).rejects.toThrow("This extension ctx is stale after session replacement or reload");
  });

  it("aborts a delayed successful connect without retaining the old connection", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const gate = deferred();
    mocks.connectGate = gate;
    const owner = createMcpRuntimeOwner();
    const manager = new McpServerManager("/tmp/session");
    manager.setRuntimeSignal(owner.signal);

    const connecting = manager.connect("demo", { command: "node", args: ["server.js"] });
    const stopping = owner.stop("reload");
    gate.resolve();

    await expect(connecting).rejects.toThrow("reload");
    await stopping;
    expect(manager.getAllConnections().size).toBe(0);
    expect(mocks.clients[0].close).toHaveBeenCalled();
    expect(mocks.transports[0].close).toHaveBeenCalled();
  });

  it("aborts a delayed failed connect without reporting an old-runtime failure", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const gate = deferred(true);
    mocks.connectGate = gate;
    const owner = createMcpRuntimeOwner();
    const manager = new McpServerManager("/tmp/session");
    manager.setRuntimeSignal(owner.signal);

    const connecting = manager.connect("demo", { command: "node", args: ["server.js"] });
    const stopping = owner.stop("reload");
    gate.reject(new Error("late connection failure"));

    await expect(connecting).rejects.toThrow();
    await stopping;
    expect(manager.getAllConnections().size).toBe(0);
  });

  it("aborts direct-tool metadata bootstrap during discovery and closes the process", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const gate = deferred();
    mocks.listToolsGate = gate;
    const owner = createMcpRuntimeOwner();
    const manager = new McpServerManager("/tmp/session");
    manager.setRuntimeSignal(owner.signal);

    const connecting = manager.connect("direct", { command: "node", args: ["server.js"] });
    await Promise.resolve();
    const stopping = owner.stop("reload");
    gate.resolve();

    await expect(connecting).rejects.toThrow("reload");
    await stopping;
    expect(manager.getAllConnections().size).toBe(0);
    expect(mocks.clients[0].close).toHaveBeenCalled();
  });

  it("fences health/reconnect callbacks after shutdown and leaves no interval", async () => {
    vi.useFakeTimers();
    const owner = createMcpRuntimeOwner();
    const manager = {
      getConnection: vi.fn(() => undefined),
      connect: vi.fn(async () => ({ status: "connected" })),
      close: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined),
      isIdle: vi.fn(() => false),
    } as any;
    const lifecycle = new McpLifecycleManager(manager);
    const reconnect = vi.fn();
    lifecycle.markKeepAlive("demo", { command: "node" });
    lifecycle.setReconnectCallback(reconnect);
    lifecycle.startHealthChecks(owner.signal, 10);

    await vi.advanceTimersByTimeAsync(10);
    expect(reconnect).toHaveBeenCalledTimes(1);

    await owner.stop("reload");
    await lifecycle.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(100);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences old UI calls and keeps replacement owners independent across repeated reloads", async () => {
    const rawUi = { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: vi.fn((_c, text) => text) } } as any;
    const first = createMcpRuntimeOwner();
    const second = createMcpRuntimeOwner();
    const firstUi = createOwnedUi(rawUi, first);
    const secondUi = createOwnedUi(rawUi, second);

    firstUi.notify("first", "info");
    await first.stop("reload one");
    firstUi.notify("stale", "error");
    secondUi.notify("second", "info");
    await second.stop("reload two");
    secondUi.setStatus("mcp", "stale");

    expect(rawUi.notify).toHaveBeenCalledTimes(2);
    expect(rawUi.notify).toHaveBeenNthCalledWith(1, "first", "info");
    expect(rawUi.notify).toHaveBeenNthCalledWith(2, "second", "info");
    expect(rawUi.setStatus).not.toHaveBeenCalled();
  });
});
