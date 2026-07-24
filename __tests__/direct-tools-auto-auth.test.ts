import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildToolMetadata } from "../tool-metadata.ts";

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: mocks.authenticate,
  supportsOAuth: mocks.supportsOAuth,
}));

describe("direct tools auto auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
  });

  it("auto-authenticates and retries direct tool execution once", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    let connection: any = { status: "needs-auth" };
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [{ type: "text", text: "ok" }],
        })),
      },
    };

    mocks.lazyConnect
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => {
        connection = connected;
        return true;
      });

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {
          connection = undefined;
        }),
        getConnection: vi.fn(() => connection),
        getRequestOptions: vi.fn(() => ({ timeout: 4321 })),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const { metadata } = buildToolMetadata(
      [{ name: "namespace.tool", description: "Namespaced tool" }] as any,
      [],
      state.config.mcpServers.demo,
      "demo",
      "server",
    );
    const [tool] = metadata;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: tool.originalName,
        prefixedName: tool.name,
        description: tool.description,
      },
    );

    const controller = new AbortController();
    const result = await executor("id", { q: "hello" }, controller.signal, () => {}, undefined as any);

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(state.manager.close).toHaveBeenCalledWith("demo");
    expect(state.manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(connected.client.callTool).toHaveBeenCalledWith(
      {
        name: "namespace.tool",
        arguments: { q: "hello" },
        _meta: undefined,
      },
      undefined,
      { timeout: 4321 },
    );
    expect(result.content[0].text).toContain("ok");
  });

  it("surfaces aborted direct tool calls via the forwarded AbortSignal", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const controller = new AbortController();

    const requestOptions = { signal: controller.signal, timeout: 4321 };
    const connection = {
      status: "connected",
      client: {
        callTool: vi.fn(() => new Promise<never>(() => {})),
      },
    };
    const state = {
      config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
      manager: {
        getConnection: vi.fn(() => connection),
        getRequestOptions: vi.fn(() => requestOptions),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;
    mocks.lazyConnect.mockResolvedValue(true);

    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });

    const inFlight = executor("id", {}, controller.signal, undefined, undefined as any);
    await Promise.resolve();
    controller.abort(new Error("request aborted"));

    const result = await inFlight;

    expect(state.manager.getRequestOptions).toHaveBeenCalledWith("demo", controller.signal);
    expect(connection.client.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: {}, _meta: undefined },
      undefined,
      requestOptions,
    );
    expect(result.details).toMatchObject({ error: "call_failed", server: "demo" });
    expect(result.content[0].text).toContain("request aborted");
  });

  it("fails fast in non-ui context for browser-based OAuth", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => ({ status: "needs-auth" })),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: undefined,
      completedUiSessions: [],
    } as any;

    mocks.lazyConnect.mockResolvedValue(false);

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("auth-start");
    expect(result.content[0].text).toContain("/mcp-auth demo");
  });

  it("runs URL elicitations returned by a URL-required tool error", async () => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/sdk/types.js");
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
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
    const state = {
      config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
      manager: {
        getConnection: vi.fn(() => connection),
        handleUrlElicitationRequired: vi.fn().mockResolvedValue("accept"),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;
    mocks.lazyConnect.mockResolvedValue(true);

    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });
    const result = await executor("id", {}, undefined, undefined, undefined as any);

    expect(state.manager.handleUrlElicitationRequired).toHaveBeenCalledWith("demo", error);
    expect(result.details).toMatchObject({ error: "url_elicitation_required", action: "accept" });
    expect(result.content[0].text).toContain("retry the tool");
  });

  it("uses custom authRequiredMessage in non-ui direct tool auth failures", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

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
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => ({ status: "needs-auth" })),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: undefined,
      completedUiSessions: [],
    } as any;

    mocks.lazyConnect.mockResolvedValue(false);

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Reconnect demo from the host app.");
  });
});
