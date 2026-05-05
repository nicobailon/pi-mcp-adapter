import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
}));

vi.mock("../init.js", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
}));

vi.mock("../mcp-auth-flow.js", () => ({
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
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
      sessionId: "pi-session-direct",
    } as any;

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

    const result = await executor("id", { q: "hello" }, undefined as any, () => {}, undefined as any);

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(state.manager.close).toHaveBeenCalledWith("demo");
    expect(connected.client.callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { q: "hello" },
      _meta: { "pi/session_id": "pi-session-direct" },
    });
    expect(result.content[0].text).toContain("ok");
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
    expect(result.content[0].text).toContain("interactive session");
    expect(result.content[0].text).toContain("/mcp-auth demo");
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
