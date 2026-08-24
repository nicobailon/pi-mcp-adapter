import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
  lazyConnect: vi.fn(),
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
  markKeepAliveAfterConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  updateStatusBar: vi.fn(),
  clearFailure: vi.fn(),
  recordFailure: vi.fn(),
  clients: [] as any[],
  transports: [] as any[],
  connectImpl: vi.fn(),
  listToolsImpl: vi.fn(),
  listResourcesImpl: vi.fn(),
  callToolImpl: vi.fn(),
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: mocks.authenticate,
  supportsOAuth: mocks.supportsOAuth,
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  updateServerMetadata: mocks.updateServerMetadata,
  updateMetadataCache: mocks.updateMetadataCache,
  notifyToolMetadataUpdated: mocks.notifyToolMetadataUpdated,
  markKeepAliveAfterConnect: mocks.markKeepAliveAfterConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateStatusBar: mocks.updateStatusBar,
  clearFailure: mocks.clearFailure,
  recordFailure: mocks.recordFailure,
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation(function (this: any, info: unknown, options: unknown) {
    this.info = info;
    this.options = options;
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn((transport: unknown, requestOptions: unknown) =>
      mocks.connectImpl(transport, requestOptions)
    );
    this.getServerCapabilities = vi.fn(() => ({ tools: {}, resources: {} }));
    this.listTools = vi.fn((params: unknown, requestOptions: unknown) =>
      mocks.listToolsImpl(params, requestOptions)
    );
    this.listResources = vi.fn((params: unknown, requestOptions: unknown) =>
      mocks.listResourcesImpl(params, requestOptions)
    );
    this.callTool = vi.fn((params: unknown, schema: unknown, requestOptions: unknown) =>
      mocks.callToolImpl(params, schema, requestOptions)
    );
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
  }),
  StreamableHTTPClientTransport: vi.fn(),
  SSEClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any, options: unknown) {
    this.options = options;
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("proxy auto auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
    mocks.lazyConnect.mockReset().mockResolvedValue(false);
    mocks.updateServerMetadata.mockReset();
    mocks.updateMetadataCache.mockReset();
    mocks.markKeepAliveAfterConnect.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.updateStatusBar.mockReset();
    mocks.clearFailure.mockReset();
    mocks.recordFailure.mockReset();
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.connectImpl.mockReset().mockResolvedValue(undefined);
    mocks.listToolsImpl.mockReset().mockResolvedValue({ tools: [] });
    mocks.listResourcesImpl.mockReset().mockResolvedValue({ resources: [] });
    mocks.callToolImpl.mockReset().mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("refreshes an already connected server instead of reusing stale metadata", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

    const stale = {
      status: "connected",
      tools: [{ name: "old", description: "Old tool" }],
      resources: [],
    };
    const fresh = {
      status: "connected",
      tools: [{ name: "fresh", description: "Fresh tool" }],
      resources: [],
    };
    const manager = {
      getConnection: vi.fn(() => fresh),
      connect: vi.fn(async () => {
        throw new Error("connect should not reuse the stale connection");
      }),
      reconnect: vi.fn(async () => fresh),
    };
    manager.getConnection.mockReturnValueOnce(stale);

    const state = {
      config: { mcpServers: { demo: { command: "node", args: ["server.js"] } } },
      manager,
      toolMetadata: new Map(),
      serverInstructions: new Map(),
      failureTracker: new Map(),
      ui: undefined,
    } as any;

    const result = await executeConnect(state, "demo");

    expect(manager.reconnect).toHaveBeenCalledWith("demo", state.config.mcpServers.demo, stale, undefined);
    expect(manager.connect).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ mode: "list", server: "demo", count: 1 });
    expect(result.content[0].text).toContain("demo_fresh");
    expect(state.toolMetadata.get("demo")?.[0]).toMatchObject({ originalName: "fresh" });
  });

  it("keeps a same-server tool when another current sibling matches the selector", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");
    const connection = {
      status: "connected",
      tools: [
        { name: "search-records", description: "Hyphen" },
        { name: "search_records", description: "Underscore" },
      ],
      resources: [],
      prompts: [],
    };
    const state = {
      config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "demo", excludeTools: ["search_records"] } } },
      manager: { getConnection: vi.fn(() => undefined), connect: vi.fn(async () => connection) },
      toolMetadata: new Map(),
      serverInstructions: new Map(),
      failureTracker: new Map(),
      ui: undefined,
    } as any;

    await expect(executeConnect(state, "demo")).resolves.toMatchObject({ details: { mode: "list", server: "demo", count: 1 } });
    expect(state.toolMetadata.get("demo")?.map((tool: any) => tool.name)).toEqual(["demo_search-records"]);
  });

  it("ignores stale same-server metadata during executeConnect", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");
    const definition = { command: "demo", excludeTools: ["demo_search_records"] };
    const state = {
      config: { settings: { toolPrefix: "server" }, mcpServers: { demo: definition } },
      manager: {
        getConnection: vi.fn(() => undefined),
        connect: vi.fn(async () => ({ status: "connected", tools: [{ name: "search-records", description: "New" }], resources: [], prompts: [] })),
      },
      toolMetadata: new Map([["demo", [{ name: "demo_search_records", originalName: "search_records", description: "Old" }]]]),
      serverInstructions: new Map(),
      failureTracker: new Map(),
      ui: undefined,
    } as any;

    await expect(executeConnect(state, "demo")).resolves.toMatchObject({ details: { mode: "list", server: "demo", count: 0 } });
    expect(state.toolMetadata.get("demo")).toEqual([]);
  });

  it("uses known metadata during executeConnect filtering", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");
    const connection = {
      status: "connected",
      tools: [{ name: "search-records", description: "Search" }],
      resources: [],
      prompts: [],
    };
    const state = {
      config: {
        settings: { toolPrefix: "server" },
        mcpServers: {
          "my-server": { command: "hyphen", excludeTools: ["search_records"] },
          my_2d_server: { command: "escaped" },
        },
      },
      manager: {
        getConnection: vi.fn(() => undefined),
        connect: vi.fn(async () => connection),
      },
      toolMetadata: new Map([["my_2d_server", [{ name: "my_2d_server_search_records", originalName: "search_records", description: "Other" }]]]),
      serverInstructions: new Map(),
      failureTracker: new Map(),
      ui: undefined,
    } as any;

    await expect(executeConnect(state, "my-server")).resolves.toMatchObject({ details: { mode: "list", server: "my-server", count: 1 } });
    expect(state.toolMetadata.get("my-server")?.map((tool: any) => tool.name)).toEqual(["my-server_search-records"]);
  });

  it("auto-authenticates and retries executeConnect once", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

    let current: any;
    const connected = {
      status: "connected",
      tools: [{ name: "search", description: "Search" }],
      resources: [],
    };

    const manager = {
      connect: vi
        .fn()
        .mockImplementationOnce(async () => {
          current = { status: "needs-auth" };
          return current;
        })
        .mockImplementationOnce(async () => {
          current = connected;
          return current;
        }),
      close: vi.fn(async () => {
        current = undefined;
      }),
      getConnection: vi.fn(() => current),
    };

    const statuses: string[] = [];
    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "mcp", showStatusIcon: false },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      oauthRuntime: { signal: new AbortController().signal },
      toolMetadata: new Map(),
      serverInstructions: new Map(),
      failureTracker: new Map(),
      ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
    } as any;

    const result = await executeConnect(state, "demo");

    expect(statuses).toContain("MCP: connecting to demo...");
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
      { runtime: state.oauthRuntime },
    );
    expect(manager.close).toHaveBeenCalledWith("demo");
    expect(manager.connect).toHaveBeenCalledTimes(2);
    expect(state.toolMetadata.get("demo")?.[0]).toMatchObject({
      name: "mcp__demo_search",
      originalName: "search",
    });
    expect(result.content[0].text).toContain("demo (1 tools)");
  });

  it("fails fast for non-ui browser auth when autoAuth is enabled", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

    const manager = {
      connect: vi.fn(async () => ({ status: "needs-auth" })),
      close: vi.fn(async () => {}),
      getConnection: vi.fn(() => ({ status: "needs-auth" })),
    };

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map(),
      failureTracker: new Map(),
      ui: undefined,
    } as any;

    const result = await executeConnect(state, "demo");

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("auth-start");
    expect(result.content[0].text).toContain("/mcp-auth demo");
  });

  it("uses custom authRequiredMessage for non-ui autoAuth failures", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

    const state = {
      config: {
        settings: {
          autoAuth: true,
          authRequiredMessage: "Reconnect ${server} from the host app.",
        },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        connect: vi.fn(async () => ({ status: "needs-auth" })),
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => ({ status: "needs-auth" })),
      },
      toolMetadata: new Map(),
      failureTracker: new Map(),
      ui: undefined,
    } as any;

    const result = await executeConnect(state, "demo");

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Reconnect demo from the host app.");
  });

  it("runs URL elicitations returned by proxy tool calls", async () => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/client");
    const { executeCall } = await import("../proxy-modes.ts");
    const error = new UrlElicitationRequiredError([{
      mode: "url",
      message: "Connect your account",
      elicitationId: "connect-1",
      url: "https://example.com/connect",
    }]);
    const connection = {
      status: "connected",
      client: { callTool: vi.fn().mockRejectedValue(error) },
    };
    const manager = {
      getConnection: vi.fn(() => connection),
      handleUrlElicitationRequired: vi.fn().mockResolvedValue("accept"),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };
    const state = {
      config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
      manager,
      toolMetadata: new Map([["demo", [{
        name: "demo_search",
        originalName: "search",
        description: "Search",
        inputSchema: { type: "object", properties: {} },
      }]]]),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", {}, "demo");

    expect(manager.handleUrlElicitationRequired).toHaveBeenCalledWith("demo", error);
    expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
  });

  it("auto-authenticates and retries executeCall once", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    let current: any = { status: "needs-auth" };
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [{ type: "text", text: "ok" }],
        })),
      },
      tools: [{ name: "search", description: "Search" }],
      resources: [],
    };

    const manager = {
      connect: vi.fn(async () => {
        current = connected;
        return connected;
      }),
      close: vi.fn(async () => {
        current = undefined;
      }),
      getConnection: vi.fn(() => current),
      getRequestOptions: vi.fn(() => ({ timeout: 1234 })),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const statuses: string[] = [];
    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server", showStatusIcon: false },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map([
        [
          "demo",
          [
            {
              name: "demo_search",
              originalName: "search",
              description: "Search",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        ],
      ]),
      failureTracker: new Map(),
      ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
      completedUiSessions: [],
    } as any;

    const controller = new AbortController();
    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo", undefined, controller.signal);

    expect(statuses).toContain("MCP: connecting to demo...");
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
      { signal: controller.signal },
    );
    expect(manager.connect).toHaveBeenCalledTimes(1);
    expect(manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(connected.client.callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { q: "hello" },
      _meta: undefined,
    }, expect.objectContaining({ timeout: 1234, onprogress: expect.any(Function) }));
    expect(result.content[0].text).toContain("ok");
  });

  it("rethrows proxy auto-auth cancellation", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    reason.name = "AbortError";
    mocks.authenticate.mockRejectedValueOnce(reason);
    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: { demo: { url: "https://api.example.com/mcp", auth: "oauth" } },
      },
      manager: {
        getConnection: vi.fn(() => ({ status: "needs-auth" })),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      toolMetadata: new Map([["demo", [{ name: "demo_search", originalName: "search", description: "Search", inputSchema: { type: "object" } }]]]),
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    await expect(executeCall(state, "demo_search", {}, "demo", undefined, controller.signal)).rejects.toBe(reason);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
      { signal: controller.signal },
    );
  });

  it("surfaces aborted proxy tool calls via the forwarded AbortSignal", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const controller = new AbortController();

    const requestOptions = { signal: controller.signal, timeout: 1234 };
    const connection = {
      status: "connected",
      client: {
        callTool: vi.fn(() => new Promise<never>(() => {})),
      },
    };
    const manager = {
      getConnection: vi.fn(() => connection),
      getRequestOptions: vi.fn(() => requestOptions),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };
    const state = {
      config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "demo" } } },
      manager,
      toolMetadata: new Map([["demo", [{
        name: "demo_search",
        originalName: "search",
        description: "Search",
        inputSchema: { type: "object", properties: {} },
      }]]]),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const inFlight = executeCall(state, "demo_search", {}, "demo", undefined, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("request aborted"));

    const result = await inFlight;

    expect(manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(connection.client.callTool).toHaveBeenCalledWith({ name: "search", arguments: {}, _meta: undefined }, requestOptions);
    expect(result.details).toMatchObject({ error: "aborted", message: "request aborted" });
    expect(result.content[0].text).toContain("request aborted");
  });

  it("preserves owner cancellation during a proxy tool call", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const owner = new AbortController();
    const connection = {
      status: "connected",
      client: { callTool: vi.fn(() => new Promise<never>(() => {})) },
    };
    const state = {
      config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "demo" } } },
      manager: {
        getConnection: vi.fn(() => connection),
        getRequestOptions: vi.fn((_name: string, signal?: AbortSignal) => signal ? { signal } : undefined),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      owner: { signal: owner.signal },
      toolMetadata: new Map([["demo", [{ name: "demo_search", originalName: "search", description: "Search", inputSchema: { type: "object" } }]]]),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const inFlight = executeCall(state, "demo_search", {}, "demo");
    await Promise.resolve();
    owner.abort(new Error("owner stopped"));
    const result = await inFlight;

    expect(result.details).toMatchObject({ error: "aborted", message: "owner stopped" });
  });

  it("fails closed when lazy metadata has duplicate exact tool names", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const firstCall = vi.fn();
    const secondCall = vi.fn();
    mocks.lazyConnect.mockImplementation(async (state: any, serverName: string) => {
      state.toolMetadata.set(serverName, [{ name: "my_20_server_get", originalName: "get", description: serverName }]);
      return true;
    });
    const state = {
      config: {
        settings: { toolPrefix: "server" },
        mcpServers: { "my server": { command: "first" }, my_20_server: { command: "second" } },
      },
      toolMetadata: new Map(),
      manager: {
        getConnection: (serverName: string) => ({ status: "connected", client: serverName === "my server" ? { callTool: firstCall } : { callTool: secondCall } }),
        getRequestOptions: () => undefined,
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    await expect(executeCall(state, "my_20_server_get", {})).resolves.toMatchObject({ details: { error: "ambiguous_tool" } });
    expect(mocks.lazyConnect).toHaveBeenCalledTimes(2);
    expect(firstCall).not.toHaveBeenCalled();
    expect(secondCall).not.toHaveBeenCalled();
  });

  it("prefers a lazy exact match over a normalized fallback", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const exactCall = vi.fn(async () => ({ content: [{ type: "text", text: "exact" }] }));
    const fallbackCall = vi.fn();
    mocks.lazyConnect.mockImplementation(async (state: any, serverName: string) => {
      state.toolMetadata.set(serverName, [serverName === "foo"
        ? { name: "foo_ge_t", originalName: "ge_t", description: "Exact" }
        : { name: "foo_ge-t", originalName: "ge-t", description: "Fallback" },
      ]);
      return true;
    });
    const state = {
      config: {
        settings: { toolPrefix: "short" },
        mcpServers: { foo: { command: "exact" }, "foo-mcp": { command: "fallback" } },
      },
      toolMetadata: new Map(),
      manager: {
        getConnection: (serverName: string) => ({ status: "connected", client: serverName === "foo" ? { callTool: exactCall } : { callTool: fallbackCall } }),
        getRequestOptions: () => undefined,
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    await expect(executeCall(state, "foo_ge_t", {})).resolves.toMatchObject({ details: { server: "foo", tool: "ge_t" } });
    expect(exactCall).toHaveBeenCalledOnce();
    expect(fallbackCall).not.toHaveBeenCalled();
  });

  it("fails closed when lazy metadata has duplicate normalized tool names", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const callTool = vi.fn();
    mocks.lazyConnect.mockImplementation(async (state: any, serverName: string) => {
      state.toolMetadata.set(serverName, [
        { name: "demo_a-b_c", originalName: "a-b_c", description: "First" },
        { name: "demo_a_b-c", originalName: "a_b-c", description: "Second" },
      ]);
      return true;
    });
    const state = {
      config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "demo" } } },
      toolMetadata: new Map(),
      manager: {
        getConnection: () => ({ status: "connected", client: { callTool } }),
        getRequestOptions: () => undefined,
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    await expect(executeCall(state, "demo_a_b_c", {})).resolves.toMatchObject({ details: { error: "ambiguous_tool" } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("shares one cold connect across concurrent proxy calls and applies timeout during bootstrap", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const { McpServerManager } = await import("../server-manager.ts");

    const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
    mocks.connectImpl.mockImplementation(async () => {
      await pause();
    });
    mocks.listToolsImpl.mockImplementation(async () => {
      await pause();
      return {
        tools: [{
          name: "search",
          description: "Search",
          inputSchema: { type: "object", properties: {} },
        }],
      };
    });
    mocks.listResourcesImpl.mockImplementation(async () => {
      await pause();
      return { resources: [] };
    });
    mocks.lazyConnect.mockImplementation(async (state: any, serverName: string) => {
      const connection = await state.manager.connect(serverName, state.config.mcpServers[serverName]);
      if (connection.status !== "connected") {
        return false;
      }
      state.toolMetadata.set(serverName, [{
        name: "mcp__demo_search",
        originalName: "search",
        description: "Search",
        inputSchema: { type: "object", properties: {} },
      }]);
      return true;
    });

    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);
    const state = {
      config: {
        settings: { toolPrefix: "mcp" },
        mcpServers: {
          demo: { command: "node", args: ["server.js"], requestTimeoutMs: 5000 },
        },
      },
      manager,
      toolMetadata: new Map(),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const [first, second] = await Promise.all([
      executeCall(state, "mcp__demo_search", { q: "one" }),
      executeCall(state, "mcp__demo_search", { q: "two" }),
    ]);

    expect(mocks.clients).toHaveLength(1);
    const client = mocks.clients[0];
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 5000 });
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(client.listResources).toHaveBeenCalledTimes(1);
    expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(client.callTool).toHaveBeenNthCalledWith(1, { name: "search", arguments: { q: "one" }, _meta: undefined }, { timeout: 5000 });
    expect(client.callTool).toHaveBeenNthCalledWith(2, { name: "search", arguments: { q: "two" }, _meta: undefined }, { timeout: 5000 });
    expect(first.content[0].text).toContain("ok");
    expect(second.content[0].text).toContain("ok");
  });
});
