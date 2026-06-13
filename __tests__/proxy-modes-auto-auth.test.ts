import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
  lazyConnect: vi.fn(),
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  updateStatusBar: vi.fn(),
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

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(manager.connect).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("ok");
  });
});
