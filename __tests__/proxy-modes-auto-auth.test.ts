import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
  lazyConnect: vi.fn(),
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  updateStatusBar: vi.fn(),
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
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateStatusBar: mocks.updateStatusBar,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (this: any, info: unknown, options: unknown) {
    this.info = info;
    this.options = options;
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn((transport: unknown, requestOptions: unknown) =>
      mocks.connectImpl(transport, requestOptions)
    );
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
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any, options: unknown) {
    this.options = options;
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
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

describe("proxy auto auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
    mocks.lazyConnect.mockReset().mockResolvedValue(false);
    mocks.updateServerMetadata.mockReset();
    mocks.updateMetadataCache.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.updateStatusBar.mockReset();
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

    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map(),
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
    } as any;

    const result = await executeConnect(state, "demo");

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(manager.close).toHaveBeenCalledWith("demo");
    expect(manager.connect).toHaveBeenCalledTimes(2);
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
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/sdk/types.js");
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

    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
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
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const controller = new AbortController();
    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo", undefined, controller.signal);

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(manager.connect).toHaveBeenCalledTimes(1);
    expect(manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(connected.client.callTool).toHaveBeenCalledWith(
      {
        name: "search",
        arguments: { q: "hello" },
        _meta: undefined,
      },
      undefined,
      { timeout: 1234 },
    );
    expect(result.content[0].text).toContain("ok");
  });

  it("surfaces aborted proxy tool calls via the forwarded AbortSignal", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const controller = new AbortController();
    controller.abort();

    const requestOptions = { signal: controller.signal, timeout: 1234 };
    const connection = {
      status: "connected",
      client: {
        callTool: vi.fn(async (_params: unknown, _schema: unknown, options: { signal?: AbortSignal }) => {
          if (options.signal?.aborted) {
            throw new Error("request aborted");
          }
          return { isError: false, content: [{ type: "text", text: "ok" }] };
        }),
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

    const result = await executeCall(state, "demo_search", {}, "demo", undefined, controller.signal);

    expect(manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(connection.client.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: {}, _meta: undefined },
      undefined,
      requestOptions,
    );
    expect(result.details).toMatchObject({ error: "call_failed", message: "request aborted" });
    expect(result.content[0].text).toContain("request aborted");
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
        name: "demo_search",
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
        settings: { toolPrefix: "server" },
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
      executeCall(state, "demo_search", { q: "one" }),
      executeCall(state, "demo_search", { q: "two" }),
    ]);

    expect(mocks.clients).toHaveLength(1);
    const client = mocks.clients[0];
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 5000 });
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(client.listResources).toHaveBeenCalledTimes(1);
    expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(client.callTool).toHaveBeenNthCalledWith(
      1,
      { name: "search", arguments: { q: "one" }, _meta: undefined },
      undefined,
      { timeout: 5000 },
    );
    expect(client.callTool).toHaveBeenNthCalledWith(
      2,
      { name: "search", arguments: { q: "two" }, _meta: undefined },
      undefined,
      { timeout: 5000 },
    );
    expect(first.content[0].text).toContain("ok");
    expect(second.content[0].text).toContain("ok");
  });
});
