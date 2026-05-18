import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpEventBus, type McpEventSink } from "../mcp-events.ts";
import { McpServerManager } from "../server-manager.ts";
import { McpLifecycleManager } from "../lifecycle.ts";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  listTools: vi.fn(async () => ({ tools: [{ name: "alpha" }, { name: "beta" }] })),
  listResources: vi.fn(async () => ({ resources: [] })),
  close: vi.fn(async () => undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    setRequestHandler: vi.fn(),
    setNotificationHandler: vi.fn(),
    connect: mocks.connect,
    listTools: mocks.listTools,
    listResources: mocks.listResources,
    close: mocks.close,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({ close: vi.fn(async () => undefined) })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

type Emitted = { channel: string; data: any };

function spyBus() {
  const emitted: Emitted[] = [];
  const sink: McpEventSink = { emit: (channel, data) => emitted.push({ channel, data }) };
  return { bus: new McpEventBus(sink), emitted };
}

function phases(emitted: Emitted[]): string[] {
  return emitted.map((e) => `${e.channel}:${e.data.phase ?? e.data.source ?? ""}`);
}

describe("McpServerManager lifecycle events", () => {
  beforeEach(() => {
    mocks.connect.mockReset().mockResolvedValue(undefined);
    mocks.listTools.mockReset().mockResolvedValue({ tools: [{ name: "alpha" }, { name: "beta" }] });
    mocks.listResources.mockReset().mockResolvedValue({ resources: [] });
    mocks.close.mockReset().mockResolvedValue(undefined);
  });

  it("emits connecting → connected → tools for connect → tools-load", async () => {
    const { bus, emitted } = spyBus();
    const manager = new McpServerManager();
    manager.setEventBus(bus);

    await manager.connect("local", { command: "demo-server" });

    expect(phases(emitted)).toEqual([
      "mcp:server:connecting",
      "mcp:server:connected",
      "mcp:tools:connect",
    ]);
    const toolsEvent = emitted[2].data;
    expect(toolsEvent).toMatchObject({
      serverId: "local",
      transport: "stdio",
      toolCount: 2,
      toolNames: ["alpha", "beta"],
      source: "connect",
    });
  });

  it("emits disconnected on close and idle_shutdown on idle close", async () => {
    const { bus, emitted } = spyBus();
    const manager = new McpServerManager();
    manager.setEventBus(bus);

    await manager.connect("local", { command: "demo-server" });
    await manager.close("local");

    expect(phases(emitted).at(-1)).toBe("mcp:server:disconnected");

    await manager.connect("local", { command: "demo-server" });
    await manager.close("local", { reason: "idle" });

    expect(phases(emitted).at(-1)).toBe("mcp:server:idle_shutdown");
  });

  it("emits connecting then errored when the transport fails", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("spawn failed"));
    const { bus, emitted } = spyBus();
    const manager = new McpServerManager();
    manager.setEventBus(bus);

    await expect(manager.connect("local", { command: "demo-server" })).rejects.toThrow("spawn failed");

    expect(phases(emitted)).toEqual(["mcp:server:connecting", "mcp:server:errored"]);
    expect(emitted[1].data.error).toMatchObject({ message: "spawn failed" });
  });
});

describe("McpLifecycleManager lifecycle events", () => {
  it("emits reconnecting → reconnected and labels reconnecting with the last known transport", async () => {
    const { bus, emitted } = spyBus();

    // A URL server previously observed as SSE: the manager retains that kind
    // across disconnect, so `reconnecting` must not fall back to http.
    const fakeManager = {
      getConnection: vi.fn(() => undefined),
      connect: vi.fn(async () => ({ status: "connected" })),
      getTransportKind: vi.fn(() => "sse" as const),
      isIdle: vi.fn(() => false),
      close: vi.fn(async () => undefined),
    };

    const lifecycle = new McpLifecycleManager(fakeManager as any);
    lifecycle.setEventBus(bus);
    lifecycle.markKeepAlive("keep", { url: "https://example.test/mcp" });

    await (lifecycle as any).checkConnections();

    expect(phases(emitted)).toEqual(["mcp:server:reconnecting", "mcp:server:reconnected"]);
    expect(emitted.map((e) => e.data.transport)).toEqual(["sse", "sse"]);
    expect(fakeManager.connect).toHaveBeenCalledWith("keep", { url: "https://example.test/mcp" });
  });

  it("retains the last observed transport kind across disconnect", async () => {
    const { bus } = spyBus();
    const manager = new McpServerManager();
    manager.setEventBus(bus);

    expect(manager.getTransportKind("local")).toBeUndefined();

    await manager.connect("local", { command: "demo-server" });
    expect(manager.getTransportKind("local")).toBe("stdio");

    await manager.close("local");
    // No live connection, but the kind is still known for a precise
    // `reconnecting` label instead of a config-derived guess.
    expect(manager.getTransportKind("local")).toBe("stdio");
  });

  it("closes idle servers with the idle reason so close() emits idle_shutdown", async () => {
    const { bus } = spyBus();

    const fakeManager = {
      getConnection: vi.fn(() => ({ status: "connected" })),
      connect: vi.fn(async () => ({ status: "connected" })),
      getTransportKind: vi.fn(() => "stdio" as const),
      isIdle: vi.fn(() => true),
      close: vi.fn(async () => undefined),
    };

    const lifecycle = new McpLifecycleManager(fakeManager as any);
    lifecycle.setEventBus(bus);
    lifecycle.registerServer("idle", { command: "demo" });
    lifecycle.setGlobalIdleTimeout(1);

    await (lifecycle as any).checkConnections();

    expect(fakeManager.close).toHaveBeenCalledWith("idle", { reason: "idle" });
  });
});
