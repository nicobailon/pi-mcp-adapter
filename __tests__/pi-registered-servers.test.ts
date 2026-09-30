import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  loadMcpConfig: vi.fn(),
  executeCall: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  initializeMcp: mocks.initializeMcp,
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  createOAuthRuntime: vi.fn((signal: AbortSignal) => ({ signal })),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  loadMcpConfig: mocks.loadMcpConfig,
  getLegacyMcpMigrationNotices: () => [],
  setPiMcpConfigEnabled: vi.fn(),
}));

vi.mock("../metadata-cache.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metadata-cache.ts")>()),
  loadMetadataCache: () => null,
}));

vi.mock("../proxy-modes.ts", () => ({
  executeCall: mocks.executeCall,
}));

function createState(mcpServers: Record<string, unknown> = {}) {
  return {
    manager: {
      getAllConnections: () => new Map(),
      getConnection: vi.fn(() => undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      gracefulShutdown: vi.fn().mockResolvedValue(undefined),
      registerServer: vi.fn(),
      markKeepAlive: vi.fn(),
      unregisterServer: vi.fn(),
    },
    toolMetadata: new Map(),
    config: { mcpServers },
    oauthRuntime: { signal: new AbortController().signal },
    failureTracker: new Map(),
  } as any;
}

function createEventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(data);
    },
    on(channel: string, listener: (data: unknown) => void) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(listener);
    },
  };
}

function createPi(registered: Array<{ name: string; config: Record<string, unknown> }> = [], piMcp = true) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools = ["mcp"];
  const api = {
    registerTool: vi.fn(),
    unregisterTool: vi.fn(() => true),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
    }),
    events: createEventBus(),
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => activeTools),
    setActiveTools: vi.fn((next: string[]) => {
      activeTools = next;
    }),
    getMcpServers: vi.fn(() => registered.map((server) => ({ ...server, extensionPath: "/ext/plugin.ts" }))),
    ...(piMcp ? { registerMcpServer: vi.fn() } : {}),
  } as any;
  const notify = vi.fn();
  const ctx = { hasUI: true, cwd: "/tmp/project", ui: { notify, setStatus: vi.fn() } } as any;
  const change = async (servers: Array<{ name: string; config: Record<string, unknown> }>) => {
    await handlers.get("mcp_servers_change")?.({
      type: "mcp_servers_change",
      servers: servers.map((server) => ({ ...server, extensionPath: "/ext/plugin.ts" })),
    }, ctx);
  };
  return { api, handlers, ctx, notify, change };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function callThroughMcp(api: any, ctx: any, server: string) {
  const gateway = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
  return gateway.execute("call-1", { tool: "ping", server }, undefined, undefined, ctx);
}

describe("servers registered with pi.registerMcpServer()", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.initializeMcp.mockReset();
    mocks.loadMcpConfig.mockReset().mockReturnValue({ mcpServers: {} });
    mocks.executeCall.mockReset().mockImplementation(async (state: any, _tool: string, _args: unknown, server: string) => ({
      content: [{ type: "text", text: JSON.stringify(state.config.mcpServers[server] ?? null) }],
      details: {},
    }));
  });

  it("connects servers registered before session_start and during the session through the mcp tool", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const early = { name: "early", config: { url: "https://early.test/mcp" } };
    const { api, handlers, ctx, notify, change } = createPi([early]);
    mcpAdapter(api);
    // Pi reports registered servers as unconnected unless a handler exists once extensions load.
    expect(handlers.has("mcp_servers_change")).toBe(true);

    await handlers.get("session_start")?.({}, ctx);
    await settle();
    await change([early, { name: "late", config: { command: "late-server", exposure: "direct" } }]);

    expect((await callThroughMcp(api, ctx, "early")).content[0].text)
      .toBe(JSON.stringify({ url: "https://early.test/mcp", directTools: false }));
    expect((await callThroughMcp(api, ctx, "late")).content[0].text)
      .toBe(JSON.stringify({ command: "late-server", directTools: false }));
    expect(notify).toHaveBeenCalledWith(
      'MCP server "late" registered by /ext/plugin.ts: ignored settings exposure: direct.',
      "warning",
    );
  });

  it("keeps a configured server of the same name until a later session's config drops it", async () => {
    // The startup config leaves out project servers; the session's config has the approved .pi/mcp.json entry.
    mocks.initializeMcp
      .mockResolvedValueOnce(createState({ shared: { url: "https://project.test/mcp" } }))
      .mockResolvedValueOnce(createState());
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, ctx, notify } = createPi([{ name: "shared", config: { url: "https://registered.test/mcp" } }]);
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, ctx);
    await settle();
    expect(notify).toHaveBeenCalledWith(
      'MCP server "shared" registered by /ext/plugin.ts is overridden by the configured server of the same name.',
      "warning",
    );
    expect((await callThroughMcp(api, ctx, "shared")).content[0].text)
      .toBe(JSON.stringify({ url: "https://project.test/mcp" }));

    await handlers.get("session_start")?.({}, ctx);
    await settle();
    expect((await callThroughMcp(api, ctx, "shared")).content[0].text)
      .toBe(JSON.stringify({ url: "https://registered.test/mcp", directTools: false }));
  });

  it("keeps an earlier adapter registration of the same name", async () => {
    mocks.initializeMcp.mockResolvedValue(createState());
    const { default: mcpAdapter, registerMcpServer } = await import("../index.ts");
    const { api, handlers, ctx, notify, change } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, ctx);
    await settle();

    registerMcpServer({ pi: api, name: "shared", definition: { url: "https://adapter.test/mcp" } });
    await change([{ name: "shared", config: { url: "https://registered.test/mcp" } }]);

    expect(notify).toHaveBeenCalledWith(
      `MCP server "shared" registered by /ext/plugin.ts is overridden by the server registered earlier with pi-mcp-adapter's registerMcpServer().`,
      "warning",
    );
    expect((await callThroughMcp(api, ctx, "shared")).content[0].text)
      .toBe(JSON.stringify({ url: "https://adapter.test/mcp", directTools: false }));
  });

  it("connects an overridden Pi registration once the adapter registration is disposed", async () => {
    mocks.initializeMcp.mockResolvedValue(createState());
    const { default: mcpAdapter, registerMcpServer } = await import("../index.ts");
    const { api, handlers, ctx, change } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, ctx);
    await settle();

    const registration = registerMcpServer({ pi: api, name: "shared", definition: { url: "https://adapter.test/mcp" } });
    await change([{ name: "shared", config: { url: "https://registered.test/mcp" } }]);
    await registration.dispose();

    expect((await callThroughMcp(api, ctx, "shared")).content[0].text)
      .toBe(JSON.stringify({ url: "https://registered.test/mcp", directTools: false }));
  });

  it("connects an overridden Pi registration even when closing the adapter registration fails", async () => {
    const state = createState();
    state.manager.close.mockRejectedValue(new Error("close failed"));
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, registerMcpServer } = await import("../index.ts");
    const { api, handlers, ctx, change } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, ctx);
    await settle();

    const registration = registerMcpServer({ pi: api, name: "shared", definition: { url: "https://adapter.test/mcp" } });
    await change([{ name: "shared", config: { url: "https://registered.test/mcp" } }]);
    await expect(registration.dispose()).rejects.toThrow("close failed");

    expect((await callThroughMcp(api, ctx, "shared")).content[0].text)
      .toBe(JSON.stringify({ url: "https://registered.test/mcp", directTools: false }));
  });

  it("rejects an adapter registration of a name Pi registered during load", async () => {
    mocks.initializeMcp.mockResolvedValue(createState());
    const { default: mcpAdapter, registerMcpServer } = await import("../index.ts");
    const { api, handlers, ctx } = createPi([{ name: "shared", config: { url: "https://registered.test/mcp" } }]);
    mcpAdapter(api);

    expect(() => registerMcpServer({ pi: api, name: "shared", definition: { url: "https://adapter.test/mcp" } }))
      .toThrow('MCP server "shared" is already registered');
    await handlers.get("session_start")?.({}, ctx);
    await settle();

    expect((await callThroughMcp(api, ctx, "shared")).content[0].text)
      .toBe(JSON.stringify({ url: "https://registered.test/mcp", directTools: false }));
  });

  it("replaces a re-registered server and disposes an unregistered one", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, ctx, change } = createPi([{ name: "plugin", config: { url: "https://v1.test/mcp" } }]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, ctx);
    await settle();

    await change([{ name: "plugin", config: { url: "https://v2.test/mcp" } }]);
    expect(state.manager.close).toHaveBeenCalledWith("plugin");
    expect((await callThroughMcp(api, ctx, "plugin")).content[0].text)
      .toBe(JSON.stringify({ url: "https://v2.test/mcp", directTools: false }));

    await change([]);
    expect(state.manager.close).toHaveBeenCalledTimes(2);
    expect((await callThroughMcp(api, ctx, "plugin")).content[0].text).toBe("null");
  });

  it("reports a registration the adapter cannot run and does not connect it", async () => {
    mocks.initializeMcp.mockResolvedValue(createState());
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, ctx, notify } = createPi([{ name: "legacy", config: { type: "sse", url: "https://sse.test/mcp" } }]);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, ctx);
    await settle();

    expect(notify).toHaveBeenCalledWith(
      'MCP server "legacy" registered by /ext/plugin.ts is not connected: legacy SSE transport is not supported; use the streamable HTTP URL.',
      "warning",
    );
    expect((await callThroughMcp(api, ctx, "legacy")).content[0].text).toBe("null");
  });

  it("does nothing on Pi versions without MCP server registration", async () => {
    mocks.initializeMcp.mockResolvedValue(createState());
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, ctx } = createPi([{ name: "plugin", config: { url: "https://plugin.test/mcp" } }], false);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, ctx);
    await settle();

    expect(handlers.has("mcp_servers_change")).toBe(false);
    expect(api.getMcpServers).not.toHaveBeenCalled();
    expect((await callThroughMcp(api, ctx, "plugin")).content[0].text).toBe("null");
  });
});
