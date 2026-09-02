import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  createOAuthRuntime: vi.fn((signal: AbortSignal) => ({ signal })),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
  loadMcpConfig: vi.fn(() => ({ mcpServers: {} })),
  cloneMcpConfig: vi.fn((config: unknown) => structuredClone(config)),
  loadMetadataCache: vi.fn(() => null),
  buildProxyDescription: vi.fn(() => "MCP gateway"),
  createDirectToolExecutor: vi.fn(() => vi.fn()),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
  resolveDirectTools: vi.fn(() => []),
  showStatus: vi.fn(),
  showTools: vi.fn(),
  showPrompts: vi.fn(),
  reconnectServer: vi.fn(),
  reconnectServers: vi.fn(),
  authenticateServer: vi.fn(),
  logoutServer: vi.fn(),
  manageBearerToken: vi.fn(),
  openMcpAuthPanel: vi.fn(),
  openMcpPanel: vi.fn(),
  openMcpSetup: vi.fn(),
  writeProjectServerDisabledOverride: vi.fn(() => ({ path: "/tmp/project/.pi/mcp.json", changed: true })),
  executeAuthComplete: vi.fn(),
  executeAuthStart: vi.fn(),
  executeCall: vi.fn(),
  executeConnect: vi.fn(),
  executeDescribe: vi.fn(),
  executeInstructions: vi.fn(),
  executeList: vi.fn(),
  executeSearch: vi.fn(),
  executeStatus: vi.fn(),
  executeUiMessages: vi.fn(),
  getConfigPathFromArgv: vi.fn(() => undefined),
  normalizeDirectToolInputSchema: vi.fn((schema: unknown) => schema),
  truncateAtWord: vi.fn((text: string) => text),
}));

vi.mock("../init.ts", () => ({
  initializeMcp: mocks.initializeMcp,
  updateStatusBar: mocks.updateStatusBar,
  flushMetadataCache: mocks.flushMetadataCache,
  notifyToolMetadataUpdated: mocks.notifyToolMetadataUpdated,
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  initializeOAuth: mocks.initializeOAuth,
  createOAuthRuntime: mocks.createOAuthRuntime,
  shutdownOAuth: mocks.shutdownOAuth,
}));

vi.mock("../config.ts", () => ({
  loadMcpConfig: mocks.loadMcpConfig,
  cloneMcpConfig: mocks.cloneMcpConfig,
  writeProjectServerDisabledOverride: mocks.writeProjectServerDisabledOverride,
}));

vi.mock("../metadata-cache.ts", () => ({
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../direct-tools.ts", () => ({
  buildProxyDescription: mocks.buildProxyDescription,
  createDirectToolExecutor: mocks.createDirectToolExecutor,
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
  resolveDirectTools: mocks.resolveDirectTools,
}));

vi.mock("../commands.ts", () => ({
  showStatus: mocks.showStatus,
  showTools: mocks.showTools,
  showPrompts: mocks.showPrompts,
  reconnectServer: mocks.reconnectServer,
  reconnectServers: mocks.reconnectServers,
  authenticateServer: mocks.authenticateServer,
  logoutServer: mocks.logoutServer,
  manageBearerToken: mocks.manageBearerToken,
  openMcpAuthPanel: mocks.openMcpAuthPanel,
  openMcpPanel: mocks.openMcpPanel,
  openMcpSetup: mocks.openMcpSetup,
}));

vi.mock("../proxy-modes.ts", () => ({
  executeAuthComplete: mocks.executeAuthComplete,
  executeAuthStart: mocks.executeAuthStart,
  executeCall: mocks.executeCall,
  executeConnect: mocks.executeConnect,
  executeDescribe: mocks.executeDescribe,
  executeInstructions: mocks.executeInstructions,
  executeList: mocks.executeList,
  executeSearch: mocks.executeSearch,
  executeStatus: mocks.executeStatus,
  executeUiMessages: mocks.executeUiMessages,
}));

vi.mock("../utils.ts", () => ({
  formatTerminalError: (error: unknown) => error instanceof Error ? error.message : String(error),
  getConfigPathFromArgv: mocks.getConfigPathFromArgv,
  normalizeDirectToolInputSchema: mocks.normalizeDirectToolInputSchema,
  sanitizeTerminalText: (text: string) => text,
  truncateAtWord: mocks.truncateAtWord,
}));

function createState() {
  return {
    manager: {
      getAllConnections: () => new Map(),
      getConnection: vi.fn(() => undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      gracefulShutdown: vi.fn().mockResolvedValue(undefined),
      ensureConverged: vi.fn().mockResolvedValue(undefined),
      registerServer: vi.fn(),
      markKeepAlive: vi.fn(),
      unregisterServer: vi.fn(),
    },
    toolMetadata: new Map(),
    config: { mcpServers: {} } as { mcpServers: Record<string, unknown> },
    oauthRuntime: { signal: new AbortController().signal },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
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

function createPi(events = createEventBus()) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools = ["bash", "mcp"];
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      unregisterTool: vi.fn(() => true),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      events,
      getAllTools: vi.fn(() => []),
      getActiveTools: vi.fn(() => activeTools),
      setActiveTools: vi.fn((nextActiveTools: string[]) => {
        activeTools = nextActiveTools;
      }),
    } as any,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("runtime MCP server registration", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) value.mockReset();
    }
    mocks.initializeOAuth.mockResolvedValue(undefined);
    mocks.createOAuthRuntime.mockImplementation((signal: AbortSignal) => ({ signal }));
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.cloneMcpConfig.mockImplementation((config: unknown) => structuredClone(config));
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway");
    mocks.createDirectToolExecutor.mockReturnValue(vi.fn());
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.resolveDirectTools.mockReturnValue([]);
    mocks.getConfigPathFromArgv.mockReturnValue(undefined);
    mocks.truncateAtWord.mockImplementation((text: string) => text);
  });

  it("throws when no adapter is installed for the Pi instance", async () => {
    const { registerMcpServer } = await import("../index.ts");
    const { api } = createPi();
    expect(() => registerMcpServer({ pi: api, name: "plugin", definition: { url: "https://example.test/mcp" } }))
      .toThrow("pi-mcp-adapter is not installed for this Pi instance");
  });

  it("registers from a distinct extension wrapper over the shared event bus", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, MCP_RUNTIME_REGISTER_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api: adapterApi, handlers } = createPi(events);
    const { api: consumerApi } = createPi(events);
    mcpAdapter(adapterApi);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const request = {
      version: 1 as const,
      name: "plugin-event",
      definition: { url: "https://event.test/mcp" },
    } as any;
    consumerApi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request);

    expect(request.result).toMatchObject({ ok: true });
    expect(state.config.mcpServers["plugin-event"]).toMatchObject({
      url: "https://event.test/mcp",
      directTools: false,
    });
  });

  it("returns event registration failures in the mutable result", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { configured: { url: "https://configured.test/mcp" } } });
    const state = createState();
    state.config.mcpServers = { configured: { url: "https://configured.test/mcp" } };
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, MCP_RUNTIME_REGISTER_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api, handlers } = createPi(events);
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const request = { version: 1, name: "configured", definition: { url: "https://other.test/mcp" } } as any;
    expect(() => events.emit(MCP_RUNTIME_REGISTER_EVENT, request)).not.toThrow();
    expect(request.result).toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: 'MCP server "configured" is already registered' }),
    });
  });

  it("leaves a prefilled event result untouched", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, MCP_RUNTIME_REGISTER_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api, handlers } = createPi(events);
    mcpAdapter(api);
    const registration = { dispose: vi.fn().mockResolvedValue(undefined) };
    const request = {
      version: 1,
      name: "ignored",
      definition: { url: "https://ignored.test/mcp" },
      result: { ok: true, registration },
    } as any;

    events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
    await handlers.get("session_start")?.({}, {});
    await settle();

    expect(request.result.registration).toBe(registration);
    expect(state.config.mcpServers["ignored"]).toBeUndefined();
  });

  it("falls back to the shared event bus for a distinct extension wrapper", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, registerMcpServer } = await import("../index.ts");
    const events = createEventBus();
    const { api: adapterApi, handlers } = createPi(events);
    const { api: consumerApi } = createPi(events);
    mcpAdapter(adapterApi);
    await handlers.get("session_start")?.({}, {});
    await settle();

    registerMcpServer({ pi: consumerApi, name: "plugin-helper", definition: { url: "https://helper.test/mcp" } });

    expect(state.config.mcpServers["plugin-helper"]).toMatchObject({
      url: "https://helper.test/mcp",
      directTools: false,
    });
  });

  it("returns an isolated snapshot with the original direct-tool definition", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, registerMcpServer, getRuntimeMcpServerSnapshot } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const definition = {
      url: "https://snapshot.test/mcp",
      directTools: ["search"],
      headers: { Authorization: "Bearer test" },
    };
    registerMcpServer({ pi: api, name: "snapshot", definition });

    const first = getRuntimeMcpServerSnapshot({ pi: api, name: "snapshot" });
    expect(first).toEqual({ name: "snapshot", definition, runtime: true, persisted: false });
    expect(state.config.mcpServers["snapshot"]).toMatchObject({ directTools: false });
    expect(first.definition).not.toBe(definition);
    first.definition.headers!.Authorization = "Bearer changed";

    expect(getRuntimeMcpServerSnapshot({ pi: api, name: "snapshot" }).definition).toEqual(definition);
  });

  it("snapshots through a distinct extension wrapper and fails after disposal", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, registerMcpServer, getRuntimeMcpServerSnapshot, MCP_RUNTIME_SNAPSHOT_EVENT } = await import("../index.ts");
    const events = createEventBus();
    const { api: adapterApi, handlers } = createPi(events);
    const { api: consumerApi } = createPi(events);
    mcpAdapter(adapterApi);
    await handlers.get("session_start")?.({}, {});
    await settle();

    expect(() => getRuntimeMcpServerSnapshot({ pi: consumerApi, name: "missing" }))
      .toThrow('MCP runtime server "missing" is not registered or has been disposed');

    const registration = registerMcpServer({ pi: consumerApi, name: "event-snapshot", definition: { url: "https://event-snapshot.test/mcp" } });
    expect(getRuntimeMcpServerSnapshot({ pi: consumerApi, name: "event-snapshot" })).toMatchObject({
      name: "event-snapshot",
      definition: { url: "https://event-snapshot.test/mcp" },
      runtime: true,
      persisted: false,
    });

    const unsupported = { version: 99, name: "event-snapshot" } as any;
    events.emit(MCP_RUNTIME_SNAPSHOT_EVENT, unsupported);
    expect(unsupported.result).toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: "Unsupported MCP runtime snapshot version: 99" }),
    });

    await registration.dispose();
    expect(() => getRuntimeMcpServerSnapshot({ pi: consumerApi, name: "event-snapshot" }))
      .toThrow('MCP runtime server "event-snapshot" is not registered or has been disposed');
  });

  it("registers after init, exposes the server in state, and disposes cleanly", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, registerMcpServer } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await settle();

    const registration = registerMcpServer({ pi: api, name: "plugin-a", definition: { url: "https://example.test/mcp" } });
    expect(state.config.mcpServers["plugin-a"]).toMatchObject({
      url: "https://example.test/mcp",
      directTools: false,
    });
    expect(state.lifecycle.registerServer).toHaveBeenCalledWith(
      "plugin-a",
      expect.objectContaining({ url: "https://example.test/mcp" }),
      undefined,
    );

    await registration.dispose();
    expect(state.config.mcpServers["plugin-a"]).toBeUndefined();
    expect(state.lifecycle.unregisterServer).toHaveBeenCalledWith("plugin-a");
    expect(state.manager.close).toHaveBeenCalledWith("plugin-a");

    // Dispose is idempotent.
    await registration.dispose();
    expect(state.manager.close).toHaveBeenCalledTimes(1);
  });

  it("fails closed on duplicate names against config and other registrations", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: { configured: { url: "https://configured.test/mcp" } },
    });
    const state = createState();
    state.config.mcpServers = { configured: { url: "https://configured.test/mcp" } };
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, registerMcpServer } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await settle();

    expect(() => registerMcpServer({ pi: api, name: "configured", definition: { url: "https://other.test/mcp" } }))
      .toThrow('MCP server "configured" is already registered');
    registerMcpServer({ pi: api, name: "plugin-a", definition: { url: "https://a.test/mcp" } });
    expect(() => registerMcpServer({ pi: api, name: "plugin-a", definition: { url: "https://b.test/mcp" } }))
      .toThrow('MCP server "plugin-a" is already registered');
  });

  it("queues pre-init registrations and drains them when init completes", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { default: mcpAdapter, registerMcpServer, getRuntimeMcpServerSnapshot } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    registerMcpServer({ pi: api, name: "early-plugin", definition: { url: "https://early.test/mcp" } });
    expect(() => getRuntimeMcpServerSnapshot({ pi: api, name: "early-plugin" }))
      .toThrow('MCP runtime server "early-plugin" is unavailable because the adapter has no active state');

    await handlers.get("session_start")?.({}, {});
    await settle();

    expect(state.config.mcpServers["early-plugin"]).toMatchObject({
      url: "https://early.test/mcp",
      directTools: false,
    });
    expect(getRuntimeMcpServerSnapshot({ pi: api, name: "early-plugin" })).toMatchObject({
      name: "early-plugin",
      definition: { url: "https://early.test/mcp" },
      runtime: true,
      persisted: false,
    });
  });

  it("reapplies registrations across session restarts and keeps configured servers on collision", async () => {
    const firstState = createState();
    const secondState = createState();
    secondState.config.mcpServers = { "plugin-a": { url: "https://now-configured.test/mcp" } };
    mocks.initializeMcp.mockResolvedValueOnce(firstState).mockResolvedValueOnce(secondState);
    const { default: mcpAdapter, registerMcpServer, getRuntimeMcpServerSnapshot } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await settle();

    registerMcpServer({ pi: api, name: "plugin-a", definition: { url: "https://plugin.test/mcp" } });
    registerMcpServer({ pi: api, name: "plugin-b", definition: { url: "https://plugin-b.test/mcp" } });

    await handlers.get("session_start")?.({}, {});
    await settle();

    // Collision after restart: the configured server wins, fail closed.
    expect(secondState.config.mcpServers["plugin-a"]).toMatchObject({ url: "https://now-configured.test/mcp" });
    expect(secondState.config.mcpServers["plugin-b"]).toMatchObject({ url: "https://plugin-b.test/mcp" });
    expect(() => getRuntimeMcpServerSnapshot({ pi: api, name: "plugin-a" }))
      .toThrow('MCP runtime server "plugin-a" is shadowed by a configured server');
    expect(getRuntimeMcpServerSnapshot({ pi: api, name: "plugin-b" })).toMatchObject({
      name: "plugin-b",
      runtime: true,
      persisted: false,
    });
  });
});
