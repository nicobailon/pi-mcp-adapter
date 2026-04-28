import { beforeEach, describe, expect, it, vi } from "vitest";

type MockServer = {
  once: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  handlers: Map<string, (error?: NodeJS.ErrnoException) => void>;
};

const mocks = vi.hoisted(() => {
  const state = {
    configuredPort: 4337,
    activePort: 4337,
  };

  const runtime = {
    listenImpl: (
      _server: MockServer,
      _port: number,
      onListen: () => void,
      _handlers: Map<string, (error?: NodeJS.ErrnoException) => void>
    ) => {
      onListen();
    },
    servers: [] as MockServer[],
  };

  const createServer = vi.fn((_handler: unknown) => {
    const handlers = new Map<string, (error?: NodeJS.ErrnoException) => void>();
    const server: MockServer = {
      handlers,
      once: vi.fn((event: string, handler: (error?: NodeJS.ErrnoException) => void) => {
        handlers.set(event, handler);
        return server;
      }),
      listen: vi.fn((port: number, _host: string, onListen: () => void) => {
        runtime.listenImpl(server, port, onListen, handlers);
      }),
      close: vi.fn((cb?: () => void) => cb?.()),
      unref: vi.fn(),
    };

    runtime.servers.push(server);
    return server;
  });

  return {
    state,
    runtime,
    createServer,
    getConfiguredOAuthCallbackPort: vi.fn(() => state.configuredPort),
    getOAuthCallbackHost: vi.fn(() => "127.0.0.1"),
    getOAuthCallbackPort: vi.fn(() => state.activePort),
    setOAuthCallbackPort: vi.fn((port: number) => {
      state.activePort = port;
    }),
  };
});

vi.mock("http", () => ({
  createServer: mocks.createServer,
}));

vi.mock("../mcp-oauth-provider.js", () => ({
  OAUTH_CALLBACK_PATH: "/callback",
  getConfiguredOAuthCallbackPort: mocks.getConfiguredOAuthCallbackPort,
  getOAuthCallbackHost: mocks.getOAuthCallbackHost,
  getOAuthCallbackPort: mocks.getOAuthCallbackPort,
  setOAuthCallbackPort: mocks.setOAuthCallbackPort,
}));

describe("mcp-callback-server", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.state.configuredPort = 4337;
    mocks.state.activePort = 4337;
    mocks.runtime.servers = [];
    mocks.runtime.listenImpl = (_server, _port, onListen) => {
      onListen();
    };
    mocks.createServer.mockClear();
    mocks.getConfiguredOAuthCallbackPort.mockClear();
    mocks.getOAuthCallbackHost.mockClear();
    mocks.getOAuthCallbackPort.mockClear();
    mocks.setOAuthCallbackPort.mockClear();
  });

  it("binds the configured callback host and unrefs the callback server after a successful bind", async () => {
    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();

    expect(mocks.runtime.servers[0]?.listen).toHaveBeenCalledWith(4337, "127.0.0.1", expect.any(Function));
    expect(mocks.runtime.servers[0]?.unref).toHaveBeenCalledTimes(1);
  });

  it("does not unref when bind fails", async () => {
    mocks.runtime.listenImpl = (_server, _port, _onListen, handlers) => {
      Promise.resolve().then(() => {
        handlers.get("error")?.(Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
      });
    };

    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await expect(ensureCallbackServer({ strictPort: true })).rejects.toThrow(/already in use/);
    expect(mocks.runtime.servers[0]?.unref).not.toHaveBeenCalled();
  });

  it("rebinds to the configured port when strict mode is requested", async () => {
    let firstConfiguredAttemptBlocked = true;
    mocks.runtime.listenImpl = (_server, port, onListen, handlers) => {
      if (port === mocks.state.configuredPort && firstConfiguredAttemptBlocked) {
        firstConfiguredAttemptBlocked = false;
        Promise.resolve().then(() => {
          handlers.get("error")?.(Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
        });
        return;
      }

      onListen();
    };

    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();
    expect(mocks.state.activePort).toBe(4338);

    await ensureCallbackServer({ strictPort: true });

    expect(mocks.state.activePort).toBe(4337);
  });

  it("does not switch ports in strict mode while callbacks are pending", async () => {
    let firstConfiguredAttemptBlocked = true;
    mocks.runtime.listenImpl = (_server, port, onListen, handlers) => {
      if (port === mocks.state.configuredPort && firstConfiguredAttemptBlocked) {
        firstConfiguredAttemptBlocked = false;
        Promise.resolve().then(() => {
          handlers.get("error")?.(Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
        });
        return;
      }

      onListen();
    };

    const {
      ensureCallbackServer,
      waitForCallback,
      cancelPendingCallback,
    } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();
    const pending = waitForCallback("pending-state");

    await expect(ensureCallbackServer({ strictPort: true })).rejects.toThrow(/cannot be switched while authorizations are pending/);

    cancelPendingCallback("pending-state");
    await expect(pending).rejects.toThrow(/Authorization cancelled/);
  });
});
