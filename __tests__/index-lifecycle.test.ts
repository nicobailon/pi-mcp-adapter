import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_STATUS_EVENT } from "../types.ts";

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
  prepareDirectToolArguments: vi.fn((_schema: unknown, args: unknown) => args),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
  resolveDirectTools: vi.fn(() => []),
  showStatus: vi.fn(),
  showTools: vi.fn(),
  showPrompts: vi.fn(),
  reconnectServer: vi.fn(),
  reconnectServers: vi.fn(),
  authenticateServer: vi.fn(),
  logoutServer: vi.fn(),
  openMcpAuthPanel: vi.fn(),
  openMcpPanel: vi.fn(),
  openMcpSetup: vi.fn(),
  writeProjectServerDisabledOverride: vi.fn(() => ({ path: "/tmp/project/.pi/mcp.json", changed: true })),
  executeAuthComplete: vi.fn(),
  executeAuthStart: vi.fn(),
  executeCall: vi.fn(),
  executeConnect: vi.fn(),
  executeDescribe: vi.fn(),
  executeList: vi.fn(),
  executeSearch: vi.fn(),
  executeStatus: vi.fn(),
  executeUiMessages: vi.fn(),
  getConfigPathFromArgv: vi.fn(() => undefined),
  normalizeDirectToolInputSchema: vi.fn((schema: unknown) => schema && typeof schema === "object" && !Array.isArray(schema)
    ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "additionalProperties"))
    : { type: "object", properties: {} }),
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

vi.mock("../metadata-cache.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metadata-cache.ts")>()),
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../direct-tools.ts", () => ({
  buildProxyDescription: mocks.buildProxyDescription,
  createDirectToolExecutor: mocks.createDirectToolExecutor,
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
  prepareDirectToolArguments: mocks.prepareDirectToolArguments,
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
  executeList: mocks.executeList,
  executeSearch: mocks.executeSearch,
  executeStatus: mocks.executeStatus,
  executeUiMessages: mocks.executeUiMessages,
}));

vi.mock("../utils.ts", () => ({
  formatTerminalError: (error: unknown) => error instanceof Error ? error.message : String(error),
  getConfigPathFromArgv: mocks.getConfigPathFromArgv,
  interpolateEnvRecord: (value: Record<string, string> | undefined) => value,
  interpolateEnvVars: (value: string | undefined) => value,
  normalizeDirectToolInputSchema: mocks.normalizeDirectToolInputSchema,
  resolveBearerToken: (definition: { bearerToken?: string }) => definition.bearerToken,
  resolveConfigPath: (value: string | undefined) => value,
  resolveServerUrl: (definition: { url?: string }) => definition.url,
  sanitizeTerminalText: (text: string) => text,
  truncateAtWord: mocks.truncateAtWord,
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createState() {
  return {
    manager: { getAllConnections: () => new Map(), getConnection: vi.fn(() => undefined) },
    lifecycle: {
      gracefulShutdown: vi.fn().mockResolvedValue(undefined),
      ensureConverged: vi.fn().mockResolvedValue(undefined),
    },
    toolMetadata: new Map(),
    config: { mcpServers: {} },
    oauthRuntime: { signal: new AbortController().signal },
    failureTracker: new Map(),
    uiResourceHandler: {},
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
  } as any;
}

function createPi(options: { unregisterTool?: false | ((name: string) => boolean) } = {}) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools = ["bash", "mcp", "demo_search"];
  const unregisterTool =
    options.unregisterTool === false
      ? undefined
      : vi.fn(options.unregisterTool ?? (() => true));
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      ...(unregisterTool ? { unregisterTool } : {}),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      getAllTools: vi.fn(() => []),
      getActiveTools: vi.fn(() => activeTools),
      setActiveTools: vi.fn((nextActiveTools: string[]) => {
        activeTools = nextActiveTools;
      }),
    } as any,
  };
}

function createStatusObservingPi() {
  const { api, handlers } = createPi();
  let activeTools = ["bash"];
  const connectedSurfaces: string[][] = [];

  api.registerTool.mockImplementation((tool: { name: string }) => {
    if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
  });
  api.unregisterTool.mockImplementation((toolName: string) => {
    const previousLength = activeTools.length;
    activeTools = activeTools.filter((name) => name !== toolName);
    return activeTools.length !== previousLength;
  });
  api.getActiveTools.mockImplementation(() => [...activeTools]);
  api.setActiveTools.mockImplementation((nextActiveTools: string[]) => {
    activeTools = [...nextActiveTools];
  });
  api.events = {
    emit: vi.fn((channel: string, payload: { connectedCount?: number }) => {
      if (channel !== MCP_STATUS_EVENT || payload.connectedCount !== 1) return;
      connectedSurfaces.push(activeTools
        .filter((name) => name === "mcp" || name.startsWith("demo_"))
        .sort());
    }),
  };

  return { api, handlers, connectedSurfaces };
}

function connectedStatusSnapshot(toolCount: number) {
  return {
    version: 1,
    servers: [{
      name: "demo",
      status: "connected",
      toolCount,
      resourceCount: 0,
      disabled: false,
    }],
    totalTools: toolCount,
    totalResources: 0,
    connectedCount: 1,
    disabledCount: 0,
  };
}

describe("mcpAdapter session lifecycle", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;

  beforeEach(() => {
    delete process.env.MCP_DIRECT_TOOLS;
    vi.resetModules();
    vi.doUnmock("typebox");
    for (const value of Object.values(mocks)) {
      if (typeof value === "function" && "mockReset" in value) {
        value.mockReset();
      }
    }

    mocks.initializeOAuth.mockResolvedValue(undefined);
    mocks.createOAuthRuntime.mockImplementation((signal: AbortSignal) => ({ signal }));
    mocks.shutdownOAuth.mockResolvedValue(undefined);
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.cloneMcpConfig.mockImplementation((config: unknown) => structuredClone(config));
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.buildProxyDescription.mockReturnValue("MCP gateway");
    mocks.createDirectToolExecutor.mockReturnValue(vi.fn());
    mocks.prepareDirectToolArguments.mockImplementation((_schema: unknown, args: unknown) => {
      const input = args as { filter?: unknown };
      return typeof input.filter === "string"
        ? { ...input, filter: JSON.parse(input.filter) }
        : args;
    });
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue([]);
    mocks.resolveDirectTools.mockReturnValue([]);
    mocks.getConfigPathFromArgv.mockReturnValue(undefined);
    mocks.normalizeDirectToolInputSchema.mockImplementation((schema: unknown) => schema && typeof schema === "object" && !Array.isArray(schema)
      ? Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "additionalProperties"))
      : { type: "object", properties: {} });
    mocks.truncateAtWord.mockImplementation((text: string) => text);
  });

  afterEach(() => {
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
  });

  it("registers mcp and pi-mcp commands while keeping mcp-auth separate", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    const commandNames = api.registerCommand.mock.calls.map((call: any[]) => call[0]);
    expect(commandNames.filter((name: string) => name === "mcp")).toHaveLength(1);
    expect(commandNames.filter((name: string) => name === "pi-mcp")).toHaveLength(1);
    expect(commandNames.filter((name: string) => name === "mcp-auth")).toHaveLength(1);
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

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_search",
      renderResult: expect.any(Function),
    }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "mcp",
      renderResult: expect.any(Function),
    }));
  });

  it("uses compact self-rendered rows for proxy and direct tools by default", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
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

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_search",
      renderShell: "self",
    }));
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "mcp",
      renderShell: "self",
    }));
  });

  it("keeps legacy boxed rows when configured", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      settings: { toolResultRendering: "boxed" },
      mcpServers: {},
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "mcp",
      renderShell: "default",
    }));
  });

  it("does not leak TypeBox internal markers into registered tool parameter schemas", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    const collectTildeKeys = (value: unknown, path = "$", keys: string[] = []): string[] => {
      if (value === null || typeof value !== "object") return keys;
      if (Array.isArray(value)) {
        value.forEach((item, index) => collectTildeKeys(item, `${path}[${index}]`, keys));
        return keys;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith("~")) keys.push(`${path}.${key}`);
        collectTildeKeys(child, `${path}.${key}`, keys);
      }
      return keys;
    };

    for (const toolName of ["mcpScript", "mcp"]) {
      const tool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === toolName)?.[0];
      expect(tool, `expected ${toolName} to be registered`).toBeDefined();

      const serialized = JSON.parse(JSON.stringify(tool.parameters));
      expect(
        collectTildeKeys(serialized),
        `${toolName} parameters must not leak TypeBox internal markers (~optional etc.)`,
      ).toEqual([]);

      // Optional numeric fields must still be present with their options and not required.
      for (const key of toolName === "mcpScript" ? ["timeoutMs"] : ["limit", "offset"]) {
        expect(serialized.properties[key]).toMatchObject({ type: "number", description: expect.any(String) });
        expect(serialized.required ?? []).not.toContain(key);
      }
    }
  });

  it("registers direct MCP tools when the host TypeBox shim omits Unsafe", async () => {
    vi.doMock("typebox", () => ({
      Type: {
        Object: (properties: Record<string, unknown>, options?: Record<string, unknown>) => ({ type: "object", properties, ...options }),
        String: (options?: Record<string, unknown>) => ({ type: "string", ...options }),
        Boolean: (options?: Record<string, unknown>) => ({ type: "boolean", ...options }),
        Optional: (schema: Record<string, unknown>) => ({ ...schema, optional: true }),
        Union: (schemas: unknown[], options?: Record<string, unknown>) => ({ anyOf: schemas, ...options }),
      },
    }));
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    const directTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "demo_search")?.[0];
    expect(directTool.parameters).toEqual({ type: "object", properties: { query: { type: "string" } } });
  });

  it("normalizes direct MCP tool schemas before registration", async () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: { type: "string" },
        nested: {
          type: "object",
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    };
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
        inputSchema: schema,
      },
    ]);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    expect(mocks.normalizeDirectToolInputSchema).toHaveBeenCalledWith(schema);
    const directTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "demo_search")?.[0];
    expect(directTool.parameters).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string" },
        nested: {
          type: "object",
          additionalProperties: false,
        },
      },
      required: ["query"],
    });
    expect(directTool.parameters).not.toHaveProperty("$schema");
    expect(directTool.parameters).not.toHaveProperty("additionalProperties");
  });

  it("waits for env-selected cold-cache tools before session startup completes", async () => {
    process.env.MCP_DIRECT_TOOLS = "demo/search";
    const config = {
      mcpServers: {
        demo: { command: "demo-server" },
      },
    };
    const state = createState();
    state.config = config;
    const initialization = createDeferred(state);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["demo"]);
    mocks.initializeMcp.mockReturnValue(initialization.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    let sessionStarted = false;
    const sessionStart = Promise.resolve(handlers.get("session_start")?.({}, { hasUI: false }))
      .then(() => { sessionStarted = true; });
    await new Promise(resolve => setImmediate(resolve));

    expect(sessionStarted).toBe(false);

    mocks.resolveDirectTools.mockReturnValue([{
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search demo",
    }]);
    initialization.resolve(state);
    await sessionStart;

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
  });

  it("waits for keep-alive convergence before Pi processes the next input", async () => {
    const config = {
      mcpServers: {
        demo: { url: "https://example.test/mcp", lifecycle: "keep-alive" },
      },
    };
    const state = createState();
    state.config = config;
    const convergence = createDeferred<void>();
    state.lifecycle.ensureConverged.mockReturnValue(convergence.promise);
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    let inputCompleted = false;
    const input = Promise.resolve(handlers.get("input")?.({ type: "input", text: "hello" }, {}))
      .then(() => { inputCompleted = true; });
    await new Promise(resolve => setImmediate(resolve));

    expect(inputCompleted).toBe(false);
    convergence.resolve();
    await input;
    expect(state.lifecycle.ensureConverged).toHaveBeenCalledTimes(1);
  });

  it("waits for pending lazy-keep-alive initialization before the first input", async () => {
    const config = {
      mcpServers: {
        demo: { url: "https://example.test/mcp", lifecycle: "lazy-keep-alive" },
      },
    };
    const state = createState();
    state.config = config;
    const initialization = createDeferred<typeof state>();
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.initializeMcp.mockReturnValue(initialization.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});

    let inputCompleted = false;
    const input = Promise.resolve(handlers.get("input")?.({ type: "input", text: "hello" }, {}))
      .then(() => { inputCompleted = true; });
    await new Promise(resolve => setImmediate(resolve));

    expect(inputCompleted).toBe(false);
    initialization.resolve(state);
    await input;
    expect(state.lifecycle.ensureConverged).toHaveBeenCalledTimes(1);
  });

  it("bounds the first-input wait when initialization stalls", async () => {
    vi.useFakeTimers();
    try {
      const config = {
        mcpServers: {
          demo: { url: "https://example.test/mcp", lifecycle: "keep-alive" },
        },
      };
      const state = createState();
      const initialization = createDeferred<typeof state>();
      mocks.loadMcpConfig.mockReturnValue(config);
      mocks.initializeMcp.mockReturnValue(initialization.promise);

      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi();
      mcpAdapter(api);
      await handlers.get("session_start")?.({}, {});

      let inputCompleted = false;
      const input = Promise.resolve(handlers.get("input")?.({ type: "input", text: "hello" }, {}))
        .then(() => { inputCompleted = true; });
      await Promise.resolve();
      expect(inputCompleted).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      await input;
      expect(inputCompleted).toBe(true);
      expect(state.lifecycle.ensureConverged).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles direct tools during the keep-alive input barrier", async () => {
    const config = {
      mcpServers: {
        demo: {
          url: "https://example.test/mcp",
          lifecycle: "keep-alive",
          directTools: true,
        },
      },
    };
    const oldTool = {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Old search",
    };
    const newTool = {
      serverName: "demo",
      originalName: "lookup",
      prefixedName: "demo_lookup",
      description: "New lookup",
    };
    const state = createState();
    state.config = config;
    state.lifecycle.ensureConverged.mockImplementation(async () => {
      await state.onToolMetadataUpdated?.("demo", "keep-alive-refresh");
    });
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: {} });
    mocks.resolveDirectTools
      .mockReturnValueOnce([oldTool])
      .mockReturnValueOnce([oldTool])
      .mockReturnValue([newTool]);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    await handlers.get("input")?.({ type: "input", text: "hello" }, {});

    expect(api.unregisterTool).toHaveBeenCalledWith("demo_search");
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_lookup",
      description: "New lookup",
    }));
  });

  it("hot-loads direct tools after session initialization refreshes metadata", async () => {
    const config = {
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache
      .mockReturnValueOnce(null)
      .mockReturnValue({ version: 1, servers: {} });
    mocks.resolveDirectTools
      .mockReturnValueOnce([])
      .mockReturnValue([
        {
          serverName: "demo",
          originalName: "search",
          prefixedName: "demo_search",
          description: "Search demo",
        },
      ]);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "demo_search" }));
  });

  it("does not refresh frozen direct tools on failure-backoff metadata updates", async () => {
    const config = {
      settings: { freezeDirectTools: true },
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools.mockReturnValue([
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search demo",
      },
    ]);
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const callsAfterInitialSync = mocks.resolveDirectTools.mock.calls.length;
    state.onToolMetadataUpdated?.("demo", "failure-backoff-started");

    expect(mocks.resolveDirectTools).toHaveBeenCalledTimes(callsAfterInitialSync);
  });

  it("keeps hidden direct tool names reserved against namespace proxies during backoff", async () => {
    const { computeServerHash } = await import("../metadata-cache.ts");
    const failedDefinition = { command: "failed", directTools: true };
    const proxyDefinition = { command: "foo" };
    const config = {
      settings: { toolPrefix: "mcp" },
      mcpServers: {
        failed: failedDefinition,
        foo: proxyDefinition,
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({
      version: 1,
      servers: {
        foo: {
          configHash: computeServerHash(proxyDefinition),
          cachedAt: Date.now(),
          tools: [{ name: "run" }],
          resources: [],
        },
      },
    });
    mocks.resolveDirectTools.mockImplementation((_config, _cache, _prefix, _env, unavailableServers, reservedNames) => {
      reservedNames?.add("mcp__foo");
      if (unavailableServers?.has("failed")) {
        return [];
      }
      return [{
        serverName: "failed",
        originalName: "foo",
        prefixedName: "mcp__foo",
        description: "Failed direct",
      }];
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, {});
    await Promise.resolve();
    state.failureTracker.set("failed", Date.now());
    state.onToolMetadataUpdated?.("failed", "failure-backoff-started");

    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "mcp__foo",
      description: expect.stringContaining("Namespace-proxy"),
    }));
  });

  it("publishes connected status only after replacing stale cached direct tools", async () => {
    const config = {
      settings: { disableProxyTool: true },
      mcpServers: {
        demo: { command: "demo-server", lifecycle: "keep-alive", directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: { demo: {} } });
    mocks.resolveDirectTools
      .mockReturnValueOnce([{
        serverName: "demo",
        originalName: "stale",
        prefixedName: "demo_stale",
        description: "Cached stale tool",
      }])
      .mockReturnValue([{
        serverName: "demo",
        originalName: "current",
        prefixedName: "demo_current",
        description: "Authoritative current tool",
      }]);
    mocks.initializeMcp.mockImplementation(async (_pi, _ctx, _owner, options) => {
      state.statusEvents = options.statusEvents;
      state.statusEvents?.emit(MCP_STATUS_EVENT, connectedStatusSnapshot(1));
      return state;
    });
    mocks.updateStatusBar.mockImplementation((currentState) => {
      currentState.statusEvents?.emit(MCP_STATUS_EVENT, connectedStatusSnapshot(1));
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, connectedSurfaces } = createStatusObservingPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(connectedSurfaces).toEqual([["demo_current"]]);
  });

  it("publishes an authoritative empty catalog only after removing stale cached direct tools", async () => {
    const config = {
      settings: { disableProxyTool: true },
      mcpServers: {
        demo: { command: "demo-server", lifecycle: "keep-alive", directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.loadMetadataCache.mockReturnValue({ version: 1, servers: { demo: {} } });
    mocks.resolveDirectTools
      .mockReturnValueOnce([{
        serverName: "demo",
        originalName: "stale",
        prefixedName: "demo_stale",
        description: "Cached stale tool",
      }])
      .mockReturnValue([]);
    mocks.initializeMcp.mockImplementation(async (_pi, _ctx, _owner, options) => {
      state.statusEvents = options.statusEvents;
      state.statusEvents?.emit(MCP_STATUS_EVENT, connectedStatusSnapshot(0));
      return state;
    });
    mocks.updateStatusBar.mockImplementation((currentState) => {
      currentState.statusEvents?.emit(MCP_STATUS_EVENT, connectedStatusSnapshot(0));
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers, connectedSurfaces } = createStatusObservingPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(connectedSurfaces).toEqual([["mcp"]]);
  });

  it("removes stale direct tools and registers the proxy after metadata refresh", async () => {
    const config = {
      settings: { disableProxyTool: true },
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ])
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ])
      .mockReturnValue([]);
    mocks.reconnectServers.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "command-reconnect");
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("reconnect demo", { hasUI: false });

    expect(api.unregisterTool).toHaveBeenCalledWith("demo_search");
    expect(api.setActiveTools).toHaveBeenCalledWith(["bash", "mcp"]);
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });

  it("falls back to active-tool deactivation and reactivates re-added tools when unregisterTool is unavailable", async () => {
    const config = {
      settings: { disableProxyTool: true },
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], directTools: true },
      },
    };
    const state = createState();
    state.config = config;
    mocks.loadMcpConfig.mockReturnValue(config);
    mocks.resolveDirectTools
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ])
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo" },
      ])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        { serverName: "demo", originalName: "search", prefixedName: "demo_search", description: "Search demo v2" },
      ]);
    mocks.reconnectServers.mockImplementation(async (currentState: any) => {
      currentState.onToolMetadataUpdated?.("demo", "command-reconnect");
    });
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi({ unregisterTool: false });
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("reconnect demo", { hasUI: false });

    expect(api.unregisterTool).toBeUndefined();
    expect(api.setActiveTools).toHaveBeenCalledWith(["bash", "mcp"]);

    await commandDef.handler("reconnect demo", { hasUI: false });

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_search",
      description: "Search demo v2",
    }));
    expect(api.setActiveTools).toHaveBeenCalledWith(["bash", "mcp", "demo_search"]);
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

    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "demo_search",
      renderResult: expect.any(Function),
    }));
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });

  it("registers proxy args as string or object without patternProperties", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    const argsSchema = proxyTool.parameters.properties.args;
    expect(argsSchema.anyOf).toEqual([
      expect.objectContaining({ type: "string" }),
      expect.objectContaining({ type: "object", additionalProperties: true }),
    ]);
    expect(JSON.stringify(argsSchema)).not.toContain("patternProperties");
  });

  it("forwards native object proxy args into executeCall", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    await proxyTool.execute("call-1", { tool: "demo_search", args: { q: "hello", limit: 10 } });

    expect(mocks.executeCall).toHaveBeenCalledWith(
      state,
      "demo_search",
      { q: "hello", limit: 10 },
      undefined,
      expect.any(Function),
      undefined,
    );
  });

  it("rejects gateway params nested inside proxy args", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    mocks.executeSearch.mockResolvedValue({ content: [{ type: "text", text: "results" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    await expect(proxyTool.execute("call-1", { args: '{"search":"screenshot","limit":3}' })).rejects.toThrow(
      "Gateway params were nested inside `args`; pass them top-level",
    );
    await expect(proxyTool.execute("call-2", { args: { tool: "demo_search", args: { q: "hello" }, server: "demo" } })).rejects.toThrow(
      "Gateway params were nested inside `args`; pass them top-level",
    );

    expect(mocks.executeSearch).not.toHaveBeenCalled();
    expect(mocks.executeCall).not.toHaveBeenCalled();
    expect(mocks.executeStatus).not.toHaveBeenCalled();
  });

  it("rejects non-gateway params nested inside proxy args", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    await expect(proxyTool.execute("call-1", { args: '{"query":"screenshot"}' })).rejects.toThrow(
      "Gateway params were nested inside `args`; pass them top-level",
    );
    await expect(proxyTool.execute("call-2", { args: "" })).rejects.toThrow(
      "Gateway params were nested inside `args`; pass them top-level",
    );
    expect(mocks.executeStatus).not.toHaveBeenCalled();
  });

  it("routes manual auth actions through the proxy tool", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeAuthStart.mockResolvedValue({ content: [{ type: "text", text: "auth url" }] });
    mocks.executeAuthComplete.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    await proxyTool.execute("call-1", { action: "auth-start", server: "demo" });
    await proxyTool.execute("call-2", {
      action: "auth-complete",
      server: "demo",
      args: '{"redirectUrl":"http://localhost:19876/callback?code=abc&state=state"}',
    });

    expect(mocks.executeAuthStart).toHaveBeenCalledWith(state, "demo");
    expect(mocks.executeAuthComplete).toHaveBeenCalledWith(
      state,
      "demo",
      "http://localhost:19876/callback?code=abc&state=state",
    );
  });

  it("forwards the proxy tool AbortSignal into executeCall", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeCall.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, {});
    await Promise.resolve();
    await Promise.resolve();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    const controller = new AbortController();
    await proxyTool.execute(
      "call-1",
      { tool: "demo_search", args: '{"q":"hello"}' },
      controller.signal,
    );

    expect(mocks.executeCall).toHaveBeenCalledWith(
      state,
      "demo_search",
      { q: "hello" },
      undefined,
      expect.any(Function),
      controller.signal,
    );
  });

  it("exports createMcpAdapter while retaining the default adapter export", async () => {
    const adapterModule = await import("../index.ts");
    expect(adapterModule.createMcpAdapter).toBeTypeOf("function");
    expect(adapterModule.default).toBeTypeOf("function");

    const { api } = createPi();
    adapterModule.default(api);
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith(undefined);
  });

  it("uses only the supplied config for early registration and session initialization", async () => {
    const config = {
      mcpServers: {
        memory: { url: "https://memory.example.com/mcp", directTools: true },
      },
      settings: { disableProxyTool: true as const },
    };
    mocks.getConfigPathFromArgv.mockReturnValue("/ambient/argv.json");
    mocks.resolveDirectTools.mockReturnValue([{
      serverName: "memory",
      originalName: "search",
      prefixedName: "memory_search",
      description: "Search",
    }]);
    const state = createState();
    state.config = structuredClone(config);
    mocks.initializeMcp.mockResolvedValue(state);

    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    createMcpAdapter({ config })(api);

    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    expect(mocks.getConfigPathFromArgv).not.toHaveBeenCalled();
    expect(mocks.resolveDirectTools).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: { memory: config.mcpServers.memory } }),
      null,
      "server",
      undefined,
      expect.any(Set),
      expect.any(Set),
    );
    expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "memory_search" }));
    expect(api.registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));

    await handlers.get("session_start")?.({}, { hasUI: false });
    expect(mocks.initializeMcp).toHaveBeenCalledWith(
      api,
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ config: expect.objectContaining({ mcpServers: config.mcpServers }) }),
    );
    expect(mocks.initializeMcp.mock.calls[0][3].config).not.toBe(config);
  });

  it("adds strict direct-tool argument preparation only when configured", async () => {
    const inputSchema = {
      type: "object",
      required: ["filter"],
      properties: {
        filter: {
          type: "object",
          required: ["site"],
          properties: { site: { type: "string" } },
        },
      },
    };
    mocks.resolveDirectTools.mockReturnValue([{
      serverName: "memory",
      originalName: "search",
      prefixedName: "memory_search",
      description: "Search",
      inputSchema,
    }]);
    const { createMcpAdapter } = await import("../index.ts");
    const strictPi = createPi();
    createMcpAdapter({
      config: {
        mcpServers: { memory: { command: "memory", directTools: true } },
        settings: { strictDirectToolArguments: true },
      },
    })(strictPi.api);
    const strictTool = strictPi.api.registerTool.mock.calls.find(
      ([tool]: [Record<string, unknown>]) => tool.name === "memory_search",
    )?.[0];

    expect(strictTool.prepareArguments({ filter: '{"site":"north"}' })).toEqual({
      filter: { site: "north" },
    });

    const leanPi = createPi();
    createMcpAdapter({
      config: { mcpServers: { memory: { command: "memory", directTools: true } } },
    })(leanPi.api);
    const leanTool = leanPi.api.registerTool.mock.calls.find(
      ([tool]: [Record<string, unknown>]) => tool.name === "memory_search",
    )?.[0];
    expect(leanTool).not.toHaveProperty("prepareArguments");
  });

  it("snapshots caller config and isolates separate factories", async () => {
    const firstConfig = { mcpServers: { first: { url: "https://first.example.com/mcp" } } };
    const secondConfig = { mcpServers: { second: { url: "https://second.example.com/mcp" } } };
    const firstAdapter = (await import("../index.ts")).createMcpAdapter({ config: firstConfig });
    const secondAdapter = (await import("../index.ts")).createMcpAdapter({ config: secondConfig });
    firstConfig.mcpServers.first.url = "https://mutated.example.com/mcp";

    const firstPi = createPi();
    const secondPi = createPi();
    firstAdapter(firstPi.api);
    secondAdapter(secondPi.api);

    expect(mocks.resolveDirectTools.mock.calls.at(-2)?.[0]).toEqual({
      mcpServers: { first: { url: "https://first.example.com/mcp" } },
    });
    expect(mocks.resolveDirectTools.mock.calls.at(-1)?.[0]).toEqual(secondConfig);
  });

  it("gives configPath precedence without changing the default argv path", async () => {
    mocks.getConfigPathFromArgv.mockReturnValue("/argv.json");
    const { createMcpAdapter, default: defaultAdapter } = await import("../index.ts");
    const configured = createMcpAdapter({ configPath: "/factory.json" });
    configured(createPi().api);
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith("/factory.json");
    expect(mocks.getConfigPathFromArgv).not.toHaveBeenCalled();

    mocks.loadMcpConfig.mockClear();
    mocks.getConfigPathFromArgv.mockClear();
    defaultAdapter(createPi().api);
    expect(mocks.getConfigPathFromArgv).toHaveBeenCalledTimes(1);
    expect(mocks.loadMcpConfig).toHaveBeenCalledWith("/argv.json");
  });

  it("uses status notifications instead of ambient panels in memory-config mode", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const { createMcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    createMcpAdapter({ config: { mcpServers: { memory: { url: "https://memory.example.com/mcp" } } } })(api);
    const ui = { notify: vi.fn() };
    await handlers.get("session_start")?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("setup", { hasUI: true, ui });
    await commandDef.handler("disable memory", { hasUI: true, ui });
    await commandDef.handler("status", { hasUI: true, ui });
    const authDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await authDef.handler("", { hasUI: true, ui });

    expect(mocks.openMcpSetup).not.toHaveBeenCalled();
    expect(mocks.openMcpPanel).not.toHaveBeenCalled();
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
    expect(mocks.writeProjectServerDisabledOverride).not.toHaveBeenCalled();
    expect(mocks.showStatus).toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("in-memory"), "info");
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
    expect(mocks.shutdownOAuth).not.toHaveBeenCalled();
    const firstRuntime = mocks.createOAuthRuntime.mock.results[0].value;

    await sessionStart?.({}, {});
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(mocks.shutdownOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownOAuth).toHaveBeenCalledWith(firstRuntime);

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

  it("initializes MCP at extension load when a server requests startup connection", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeStatus.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    const loadCtx = mocks.initializeMcp.mock.calls[0][1];
    expect(loadCtx.hasUI).toBe(false);
    expect(loadCtx.mode).toBe("print");
    expect(loadCtx.cwd).toBe(process.cwd());

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    expect(proxyTool).toBeDefined();

    await proxyTool.execute("call-1", {});
    expect(mocks.executeStatus).toHaveBeenCalledWith(state);
  });

  it("does not fail load-time tool sync before Pi action methods are bound", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api } = createPi();
      api.getActiveTools.mockImplementation(() => {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
      });
      mcpAdapter(api);

      await new Promise((resolve) => setImmediate(resolve));
      await Promise.resolve();
      await Promise.resolve();

      expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
      expect(mocks.updateStatusBar).toHaveBeenCalledWith(state);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not initialize at load when startup servers are absent or disabled", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        lazy: { command: "npx", args: ["-y", "demo-server"] },
        disabledEager: { url: "http://localhost:3999/mcp", lifecycle: "eager", disabled: true },
      },
    });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.initializeMcp).not.toHaveBeenCalled();
  });

  it("lets session_start supersede an in-flight load-time init", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "keep-alive" },
      },
    });
    const loadInit = createDeferred<any>();
    const sessionInit = createDeferred<any>();
    mocks.initializeMcp
      .mockReturnValueOnce(loadInit.promise)
      .mockReturnValueOnce(sessionInit.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    const loadRuntime = mocks.createOAuthRuntime.mock.results[0].value;

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: false });
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
    expect(loadRuntime.signal.aborted).toBe(true);
    expect(mocks.shutdownOAuth).toHaveBeenCalledWith(loadRuntime);

    const sessionState = createState();
    sessionInit.resolve(sessionState);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(sessionState);

    const staleState = createState();
    loadInit.resolve(staleState);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState);
    expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("skips load-time initialization when session_start fires first", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: false });
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
  });

  it("shuts down an unresolved load-time initialization during session_shutdown", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const loadInit = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(loadInit.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);
    const loadRuntime = mocks.createOAuthRuntime.mock.results[0].value;

    const sessionShutdown = handlers.get("session_shutdown");
    await sessionShutdown?.();
    expect(loadRuntime.signal.aborted).toBe(true);
    expect(mocks.shutdownOAuth).toHaveBeenCalledWith(loadRuntime);

    const staleState = createState();
    loadInit.resolve(staleState);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.updateStatusBar).not.toHaveBeenCalledWith(staleState);
    expect(mocks.flushMetadataCache).toHaveBeenCalledWith(staleState);
    expect(staleState.lifecycle.gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it("bounds the proxy tool wait when initialization stalls", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { url: "http://localhost:3999/mcp", lifecycle: "eager" },
      },
    });
    const never = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(never.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.initializeMcp).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
      expect(proxyTool).toBeDefined();

      const resultPromise = proxyTool.execute("call-1", { search: "demo" });
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await resultPromise;

      expect(result.details).toEqual({ error: "init_timeout", timeoutMs: 30_000 });
      expect(mocks.executeSearch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries initialization from the proxy tool after an initialization failure", async () => {
    const state = createState();
    mocks.initializeMcp
      .mockRejectedValueOnce(new Error("first boom"))
      .mockResolvedValueOnce(state);
    mocks.executeSearch.mockResolvedValue({ content: [{ type: "text", text: "results" }] });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi();
      mcpAdapter(api);

      await handlers.get("session_start")?.({}, { hasUI: false });
      await new Promise((resolve) => setImmediate(resolve));

      const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
      const callCtx = { hasUI: false, cwd: "/tmp/retry", mode: "print" };
      const result = await proxyTool.execute("call-1", { search: "demo" }, undefined, undefined, callCtx);

      expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
      expect(mocks.initializeMcp.mock.calls[1][1]).toBe(callCtx);
      expect(result).toEqual({ content: [{ type: "text", text: "results" }] });
      expect(mocks.executeSearch).toHaveBeenCalledWith(state, "demo", undefined, undefined, undefined, undefined, undefined);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("returns retry guidance when proxy retry initialization also fails", async () => {
    mocks.initializeMcp
      .mockRejectedValueOnce(new Error("first boom"))
      .mockRejectedValueOnce(new Error("retry boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi();
      mcpAdapter(api);

      await handlers.get("session_start")?.({}, { hasUI: false });
      await new Promise((resolve) => setImmediate(resolve));

      const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
      const result = await proxyTool.execute("call-1", { search: "demo" }, undefined, undefined, { hasUI: false });
      const text = result.content[0].text;

      expect(mocks.initializeMcp).toHaveBeenCalledTimes(2);
      expect(text).not.toBe("MCP not initialized");
      expect(text).toContain("retry boom");
      expect(text).toContain("call mcp(...) again to retry initialization");
      expect(result.details).toEqual({ error: "init_failed", message: "retry boom" });
      expect(mocks.executeSearch).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not turn a shutdown-aborted initialization into retry guidance", async () => {
    const initializing = createDeferred<any>();
    mocks.initializeMcp.mockReturnValue(initializing.promise);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false });

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    const resultPromise = proxyTool.execute("call-1", { search: "demo" }, undefined, undefined, { hasUI: false });

    await handlers.get("session_shutdown")?.();
    initializing.reject(new Error("network down"));

    await expect(resultPromise).rejects.toThrow("network down");
    expect(mocks.executeSearch).not.toHaveBeenCalled();
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

  it("completes current `/mcp` subcommands and server arguments", async () => {
    const state = createState();
    state.config.mcpServers = {
      github: { command: "github-mcp" },
      gitlab: { command: "gitlab-mcp" },
      notion: { command: "notion-mcp" },
    };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    expect(commandDef.getArgumentCompletions("reconnect ")).toBeNull();

    await handlers.get("session_start")?.({}, { hasUI: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(commandDef.getArgumentCompletions("").map(({ value }: { value: string }) => value)).toEqual([
      "reconnect",
      "tools",
      "prompts",
      "setup",
      "logout",
      "token",
      "disable",
      "enable",
      "status",
    ]);
    expect(commandDef.getArgumentCompletions("st")).toEqual([
      { value: "status", label: "status — Show server status" },
    ]);
    expect(commandDef.getArgumentCompletions("reconnect ")).toEqual([
      { value: "reconnect github", label: "github" },
      { value: "reconnect gitlab", label: "gitlab" },
      { value: "reconnect notion", label: "notion" },
    ]);
    expect(commandDef.getArgumentCompletions("  logout git")).toEqual([
      { value: "logout github", label: "github" },
      { value: "logout gitlab", label: "gitlab" },
    ]);
    expect(commandDef.getArgumentCompletions("disable git")).toEqual([
      { value: "disable github", label: "github" },
      { value: "disable gitlab", label: "gitlab" },
    ]);
    expect(commandDef.getArgumentCompletions("enable not")).toEqual([
      { value: "enable notion", label: "notion" },
    ]);
    expect(commandDef.getArgumentCompletions("tools anything")).toBeNull();
    expect(api.registerCommand.mock.calls.some((call: any[]) => call[0] === "mcp-reconnect")).toBe(false);
  });

  it("hot-registers prompt commands after live prompt metadata refresh", async () => {
    const state = createState();
    state.promptMetadata = new Map();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    await handlers.get("session_start")?.({}, { hasUI: false });
    await Promise.resolve();
    await Promise.resolve();

    api.registerCommand.mockClear();
    state.promptMetadata.set("demo", [{
      serverName: "demo",
      originalName: "brief",
      commandName: "mcp__demo__brief",
      description: "Brief",
      arguments: [],
    }]);
    state.onToolMetadataUpdated?.("demo", "prompts-list-changed");

    expect(api.registerCommand).toHaveBeenCalledWith("mcp__demo__brief", expect.objectContaining({
      description: expect.stringContaining("Brief"),
      handler: expect.any(Function),
    }));
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

  it("routes `/mcp logout <server>` to credential logout", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("logout oauth-server", { hasUI: true, ui });

    expect(mocks.logoutServer).toHaveBeenCalledWith("oauth-server", state, expect.any(Object));
  });

  it("writes project-local disabled overrides and rejects unknown servers", async () => {
    const state = createState();
    state.config.mcpServers = { global: { url: "https://example.test/mcp" } };
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);
    await handlers.get("session_start")?.({}, { hasUI: true, cwd: "/tmp/project", ui: { notify: vi.fn() } });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    const ui = { notify: vi.fn() };
    await commandDef.handler("disable global", { hasUI: true, cwd: "/tmp/project", ui });
    expect(mocks.writeProjectServerDisabledOverride).toHaveBeenCalledWith(undefined, "/tmp/project", "global", true);
    await commandDef.handler("disable missing", { hasUI: true, cwd: "/tmp/project", ui });
    expect(ui.notify).toHaveBeenCalledWith("Server \"missing\" not found in effective config", "error");
  });

  it("shows usage for `/mcp logout` without a server", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp")?.[1];
    await commandDef.handler("logout", { hasUI: true, ui });

    expect(mocks.logoutServer).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Usage: /mcp logout <server>", "error");
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

  it("opens the auth picker for `/mcp-auth` without args in UI sessions", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("", { hasUI: true, ui });

    expect(mocks.openMcpAuthPanel).toHaveBeenCalledWith(state, api, expect.any(Object), undefined);
    expect(mocks.authenticateServer).not.toHaveBeenCalled();
  });

  it("reconnects after explicit `/mcp-auth <server>` succeeds", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.authenticateServer.mockResolvedValue({ ok: true });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("github", { hasUI: true, ui });

    expect(mocks.authenticateServer).toHaveBeenCalledWith(
      "github",
      state.config,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.reconnectServer).toHaveBeenCalledWith(state, expect.any(Object), "github");
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
  });

  it("does not reconnect after explicit `/mcp-auth <server>` fails", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.authenticateServer.mockResolvedValue({ ok: false });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const ui = { notify: vi.fn() };
    const sessionStart = handlers.get("session_start");
    await sessionStart?.({}, { hasUI: true, ui });
    await Promise.resolve();
    await Promise.resolve();

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("github", { hasUI: true, ui });

    expect(mocks.authenticateServer).toHaveBeenCalledWith(
      "github",
      state.config,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.reconnectServer).not.toHaveBeenCalled();
    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
  });

  it("documents that no-arg `/mcp-auth` has no non-UI picker or command feedback path", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);

    const { default: mcpAdapter } = await import("../index.ts");
    const { api } = createPi();
    mcpAdapter(api);

    const commandDef = api.registerCommand.mock.calls.find((call: any[]) => call[0] === "mcp-auth")?.[1];
    await commandDef.handler("", { hasUI: false });

    expect(mocks.openMcpAuthPanel).not.toHaveBeenCalled();
    expect(mocks.authenticateServer).not.toHaveBeenCalled();
  });

  it("stops the runtime when initialization rejects before publishing state", async () => {
    mocks.initializeMcp.mockRejectedValue(new Error("init boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { default: mcpAdapter } = await import("../index.ts");
      const { api, handlers } = createPi();
      mcpAdapter(api);

      await handlers.get("session_start")?.({}, {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(mocks.createOAuthRuntime.mock.results[0].value.signal.aborted).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
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

      expect(consoleError).toHaveBeenCalledWith("MCP initialization failed: status boom");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("registers a tool_result handler that re-flags returned MCP tool failures (and leaves other results alone)", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const toolResult = handlers.get("tool_result");
    expect(toolResult).toBeDefined();

    // server returned an error result (direct path) -> tagged tool_error
    expect(toolResult?.({ details: { error: "tool_error", server: "demo" } })).toEqual({ isError: true });
    // the call itself threw and was caught (proxy path) -> tagged call_failed
    expect(toolResult?.({ details: { mode: "call", error: "call_failed", message: "boom" } })).toEqual({ isError: true });
    // a precondition code is not a tool-execution failure -> left untouched
    expect(toolResult?.({ details: { error: "auth_required", server: "demo" } })).toBeUndefined();
  });
});
