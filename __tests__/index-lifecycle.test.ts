import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
  loadMcpConfig: vi.fn(() => ({ mcpServers: {} })),
  loadMetadataCache: vi.fn(() => null),
  buildProxyDescription: vi.fn(() => "MCP gateway"),
  createDirectToolExecutor: vi.fn(() => vi.fn()),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
  resolveDirectTools: vi.fn(() => []),
  showStatus: vi.fn(),
  showTools: vi.fn(),
  reconnectServers: vi.fn(),
  authenticateServer: vi.fn(),
  openMcpPanel: vi.fn(),
  openMcpSetup: vi.fn(),
  executeCall: vi.fn(),
  executeConnect: vi.fn(),
  executeDescribe: vi.fn(),
  executeList: vi.fn(),
  executeSearch: vi.fn(),
  executeStatus: vi.fn(),
  executeUiMessages: vi.fn(),
  getConfigPathFromArgv: vi.fn(() => undefined),
  truncateAtWord: vi.fn((text: string) => text),
}));

vi.mock("../init.js", () => ({
  initializeMcp: mocks.initializeMcp,
  updateStatusBar: mocks.updateStatusBar,
  flushMetadataCache: mocks.flushMetadataCache,
}));

vi.mock("../mcp-auth-flow.js", () => ({
  initializeOAuth: mocks.initializeOAuth,
  shutdownOAuth: mocks.shutdownOAuth,
}));

vi.mock("../config.js", () => ({
  loadMcpConfig: mocks.loadMcpConfig,
}));

vi.mock("../metadata-cache.js", () => ({
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../direct-tools.js", () => ({
  buildProxyDescription: mocks.buildProxyDescription,
  createDirectToolExecutor: mocks.createDirectToolExecutor,
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
  resolveDirectTools: mocks.resolveDirectTools,
}));

vi.mock("../commands.js", () => ({
  showStatus: mocks.showStatus,
  showTools: mocks.showTools,
  reconnectServers: mocks.reconnectServers,
  authenticateServer: mocks.authenticateServer,
  openMcpPanel: mocks.openMcpPanel,
  openMcpSetup: mocks.openMcpSetup,
}));

vi.mock("../proxy-modes.js", () => ({
  executeCall: mocks.executeCall,
  executeConnect: mocks.executeConnect,
  executeDescribe: mocks.executeDescribe,
  executeList: mocks.executeList,
  executeSearch: mocks.executeSearch,
  executeStatus: mocks.executeStatus,
  executeUiMessages: mocks.executeUiMessages,
}));

vi.mock("../utils.js", () => ({
  getConfigPathFromArgv: mocks.getConfigPathFromArgv,
  truncateAtWord: mocks.truncateAtWord,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createState() {
  return {
    manager: { getAllConnections: () => new Map() },
    lifecycle: { gracefulShutdown: vi.fn().mockResolvedValue(undefined) },
    toolMetadata: new Map(),
    config: { mcpServers: {} },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
  } as any;
}

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      getAllTools: vi.fn(() => []),
    } as any,
  };
}

describe("mcpAdapter session lifecycle", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

  beforeEach(() => {
    delete process.env.MCP_DIRECT_TOOLS;
    vi.resetModules();
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) {
        value.mockReset();
      }
    }

    mocks.initializeOAuth.mockResolvedValue(undefined);
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway");
    mocks.createDirectToolExecutor.mockReturnValue(vi.fn());
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.resolveDirectTools.mockReturnValue([]);
    mocks.getConfigPathFromArgv.mockReturnValue(undefined);
    mocks.truncateAtWord.mockImplementation((text: string) => text);
  });

  afterEach(() => {
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
  });

  it("keeps the proxy tool when direct tools are still missing from cache", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
      settings: { disableProxyTool: true },
    });
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
      },
    ]);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });

  it("skips the proxy tool once direct tools are fully available", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
      settings: { disableProxyTool: true },
    });
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
      },
    ]);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });

  it("starts a replacement init immediately and shuts down stale init results", async () => {
    const first = createDeferred<any>();
    const second = createDeferred<any>();
    mocks.initializeMcp
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);

    await sessionStart?.({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(2);

    const activeState = createState();
    second.resolve(activeState);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.updateStatusBar).toHaveBeenCalledWith(activeState);
    expect(activeState.lifecycle.gracefulShutdown).not.toHaveBeenCalled();

    const staleState = createState();
    first.resolve(staleState);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState);
    expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("shuts down OAuth on session_shutdown", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");

    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    mocks.shutdownOAuth.mockClear();

    await sessionShutdown?.();

    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
  });

  it("routes `/mcp setup` to the onboarding flow", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui: { notify: vi.fn() } });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    expect(commandDef).toBeDefined();

    await commandDef.handler("setup", { hasUI: true, ui: { notify: vi.fn() } });

    expect(mocks.openMcpSetup).toHaveBeenCalledWith(state, api, expect.any(Object), undefined, "setup");
  });

  it("triggers core reload after setup changes config", async () => {
    const initialState = createState();
    mocks.initializeMcp.mockResolvedValue(initialState);
    mocks.openMcpSetup.mockResolvedValue({ configChanged: true });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const reload = vi.fn().mockResolvedValue(undefined);
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("setup", { hasUI: true, ui, reload });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    expect(mocks.flushMetadataCache).not.toHaveBeenCalledWith(initialState);
  });

  it("logs initialization errors when updateStatusBar throws", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.updateStatusBar.mockImplementation(() => {
      throw new Error("status boom");
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi();
      mcpAdapter(api);

      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeTypeOf("function");

      await sessionStart?.({}, {});
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      expect(consoleError).toHaveBeenCalledWith("MCP initialization failed:", expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });
});
