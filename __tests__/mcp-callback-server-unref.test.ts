import { beforeEach, describe, expect, it, vi } from "vitest";

type MockServer = {
  once: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
  handlers: Map<string, (error?: NodeJS.ErrnoException) => void>;
};

const mocks = vi.hoisted(() => {
  const state = {
    configuredPort: 4337,
    activePort: 4337,
    callbackPath: "/callback",
  };

  const runtime = {
    assignedPort: 4338,
    listenImpl: (
      _server: MockServer,
      _port: number,
      _host: string,
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
      listen: vi.fn((port: number, host: string, onListen: () => void) => {
        runtime.listenImpl(server, port, host, onListen, handlers);
      }),
      close: vi.fn((cb?: () => void) => cb?.()),
      unref: vi.fn(),
      address: vi.fn(() => ({ address: "127.0.0.1", family: "IPv4", port: runtime.assignedPort })),
    };

    runtime.servers.push(server);
    return server;
  });

  return {
    state,
    runtime,
    createServer,
    getConfiguredOAuthCallbackPort: vi.fn(() => state.configuredPort),
    getOAuthCallbackPort: vi.fn(() => state.activePort),
    getOAuthCallbackPath: vi.fn(() => state.callbackPath),
    setOAuthCallbackPath: vi.fn((path: string) => {
      state.callbackPath = path.startsWith("/") ? path : `/${path}`;
    }),
    setOAuthCallbackPort: vi.fn((port: number) => {
      state.activePort = port;
    }),
  };
});

vi.mock("http", () => ({
  createServer: mocks.createServer,
}));

vi.mock("../mcp-oauth-provider.ts", () => ({
  DEFAULT_OAUTH_CALLBACK_PATH: "/callback",
  getConfiguredOAuthCallbackPort: mocks.getConfiguredOAuthCallbackPort,
  getOAuthCallbackPath: mocks.getOAuthCallbackPath,
  getOAuthCallbackPort: mocks.getOAuthCallbackPort,
  setOAuthCallbackPath: mocks.setOAuthCallbackPath,
  setOAuthCallbackPort: mocks.setOAuthCallbackPort,
}));

describe("mcp-callback-server", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.state.configuredPort = 4337;
    mocks.state.activePort = 4337;
    mocks.state.callbackPath = "/callback";
    mocks.runtime.assignedPort = 4338;
    mocks.runtime.servers = [];
    mocks.runtime.listenImpl = (_server, _port, _host, onListen) => {
      onListen();
    };
    mocks.createServer.mockClear();
    mocks.getConfiguredOAuthCallbackPort.mockClear();
    mocks.getOAuthCallbackPath.mockClear();
    mocks.getOAuthCallbackPort.mockClear();
    mocks.setOAuthCallbackPath.mockClear();
    mocks.setOAuthCallbackPort.mockClear();
  });

  it("binds localhost on an OS-assigned port and unrefs after a successful non-strict bind", async () => {
    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();

    expect(mocks.runtime.servers[0]?.listen).toHaveBeenCalledWith(0, "localhost", expect.any(Function));
    expect(mocks.runtime.servers[0]?.unref).toHaveBeenCalledTimes(1);
    expect(mocks.state.activePort).toBe(4338);
  });

  it("binds the configured localhost port exactly in strict mode", async () => {
    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer({ strictPort: true });

    expect(mocks.runtime.servers[0]?.listen).toHaveBeenCalledWith(4337, "localhost", expect.any(Function));
    expect(mocks.runtime.servers[0]?.listen).not.toHaveBeenCalledWith(0, "localhost", expect.any(Function));
    expect(mocks.state.activePort).toBe(4337);
  });

  it("binds an explicit loopback host and port exactly in strict mode", async () => {
    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer({ strictPort: true, port: 3118, callbackHost: "127.0.0.1", callbackPath: "/custom/callback" });

    expect(mocks.runtime.servers[0]?.listen).toHaveBeenCalledWith(3118, "127.0.0.1", expect.any(Function));
    expect(mocks.runtime.servers[0]?.listen).not.toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
    expect(mocks.state.activePort).toBe(3118);
    expect(mocks.state.callbackPath).toBe("/custom/callback");
  });

  it("does not unref when bind fails", async () => {
    mocks.runtime.listenImpl = (_server, _port, _host, _onListen, handlers) => {
      Promise.resolve().then(() => {
        handlers.get("error")?.(Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
      });
    };

    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await expect(ensureCallbackServer({ strictPort: true })).rejects.toThrow(/already in use/);
    expect(mocks.runtime.servers[0]?.unref).not.toHaveBeenCalled();
  });

  it("serializes concurrent callback server startup", async () => {
    let resolveListen: (() => void) | undefined;
    mocks.runtime.listenImpl = (_server, _port, _host, onListen) => {
      resolveListen = onListen;
    };

    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    const first = ensureCallbackServer();
    const second = ensureCallbackServer();
    expect(mocks.runtime.servers).toHaveLength(1);

    resolveListen?.();
    await Promise.all([first, second]);

    expect(mocks.runtime.servers).toHaveLength(1);
    expect(mocks.runtime.servers[0]?.unref).toHaveBeenCalledTimes(1);
    expect(mocks.state.activePort).toBe(4338);
  });

  it("waits for an in-progress bind before stopping and permits later reuse", async () => {
    let resolveListen: (() => void) | undefined;
    mocks.runtime.listenImpl = (_server, _port, _host, onListen) => {
      resolveListen = onListen;
    };

    const { ensureCallbackServer, stopCallbackServer, isCallbackServerRunning } = await import("../mcp-callback-server.ts");
    const starting = ensureCallbackServer();
    await Promise.resolve();
    const stopping = stopCallbackServer();
    resolveListen?.();

    await Promise.all([starting, stopping]);
    expect(isCallbackServerRunning()).toBe(false);
    expect(mocks.runtime.servers[0]?.close).toHaveBeenCalledTimes(1);

    mocks.runtime.listenImpl = (_server, _port, _host, onListen) => {
      onListen();
    };
    await ensureCallbackServer();
    expect(isCallbackServerRunning()).toBe(true);
    expect(mocks.runtime.servers).toHaveLength(2);
  });

  it("rejects callback startup queued before shutdown", async () => {
    let resolveListen: (() => void) | undefined;
    mocks.runtime.listenImpl = (_server, _port, _host, onListen) => {
      resolveListen = onListen;
    };

    const { ensureCallbackServer, stopCallbackServer, isCallbackServerRunning } = await import("../mcp-callback-server.ts");
    const starting = ensureCallbackServer();
    await Promise.resolve();
    const queued = ensureCallbackServer({ strictPort: true });
    const queuedResult = expect(queued).rejects.toThrow("OAuth callback server stopped");
    const stopping = stopCallbackServer();
    resolveListen?.();

    await expect(starting).resolves.toBeUndefined();
    await queuedResult;
    await expect(stopping).resolves.toBeUndefined();
    expect(isCallbackServerRunning()).toBe(false);
    expect(mocks.runtime.servers).toHaveLength(1);
    expect(mocks.runtime.servers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("rejects callback startup issued while shutdown is closing the server", async () => {
    const { ensureCallbackServer, stopCallbackServer, isCallbackServerRunning } = await import("../mcp-callback-server.ts");
    await ensureCallbackServer();
    let finishClose: (() => void) | undefined;
    mocks.runtime.servers[0].close.mockImplementation((callback?: () => void) => {
      finishClose = callback;
    });

    const stopping = stopCallbackServer();
    await expect(ensureCallbackServer({ strictPort: true, reserveState: true, oauthState: "stale" }))
      .rejects.toThrow("OAuth callback server stopped");
    expect(mocks.runtime.servers).toHaveLength(1);

    finishClose?.();
    await expect(stopping).resolves.toBeUndefined();
    expect(isCallbackServerRunning()).toBe(false);

    await ensureCallbackServer();
    expect(isCallbackServerRunning()).toBe(true);
    expect(mocks.runtime.servers).toHaveLength(2);
  });

  it("waits for idle shutdown before starting a new callback server", async () => {
    const {
      ensureCallbackServer,
      isCallbackServerRunning,
      stopCallbackServerIfIdle,
    } = await import("../mcp-callback-server.ts");
    await ensureCallbackServer();
    let finishClose: (() => void) | undefined;
    mocks.runtime.servers[0].close.mockImplementation((callback?: () => void) => {
      finishClose = callback;
    });

    const stopping = stopCallbackServerIfIdle();
    const restarting = ensureCallbackServer({ reserveState: true, oauthState: "new-flow" });
    expect(mocks.runtime.servers).toHaveLength(1);

    finishClose?.();
    await stopping;
    await restarting;

    expect(isCallbackServerRunning()).toBe(true);
    expect(mocks.runtime.servers).toHaveLength(2);
    await expect(ensureCallbackServer({ callbackPath: "/other/callback" }))
      .rejects.toThrow(/cannot be switched while authorizations are pending/);
  });

  it("forced shutdown revokes a restart waiting on idle shutdown", async () => {
    const {
      ensureCallbackServer,
      isCallbackServerRunning,
      stopCallbackServer,
      stopCallbackServerIfIdle,
    } = await import("../mcp-callback-server.ts");
    await ensureCallbackServer();
    let finishClose: (() => void) | undefined;
    mocks.runtime.servers[0].close.mockImplementation((callback?: () => void) => {
      finishClose = callback;
    });

    const idleStopping = stopCallbackServerIfIdle();
    const restarting = ensureCallbackServer({ reserveState: true, oauthState: "stopped-flow" });
    const restartResult = expect(restarting).rejects.toThrow("OAuth callback server stopped");
    const forcedStopping = stopCallbackServer();

    finishClose?.();
    await Promise.all([idleStopping, forcedStopping]);
    await restartResult;

    expect(isCallbackServerRunning()).toBe(false);
    expect(mocks.runtime.servers).toHaveLength(1);
  });

  it("does not stop while a concurrent bind is reserving callback state", async () => {
    const {
      ensureCallbackServer,
      isCallbackServerRunning,
      stopCallbackServerIfIdle,
    } = await import("../mcp-callback-server.ts");
    await ensureCallbackServer();

    let finishRebind: (() => void) | undefined;
    mocks.runtime.listenImpl = (_server, _port, _host, onListen) => {
      finishRebind = onListen;
    };
    const rebinding = ensureCallbackServer({
      strictPort: true,
      reserveState: true,
      oauthState: "concurrent-state",
    });

    await stopCallbackServerIfIdle();
    finishRebind?.();
    await rebinding;

    expect(isCallbackServerRunning()).toBe(true);
    expect(mocks.runtime.servers[1]?.close).not.toHaveBeenCalled();
    await expect(ensureCallbackServer({ callbackPath: "/other/callback" }))
      .rejects.toThrow(/cannot be switched while authorizations are pending/);
  });

  it("rebinds to the configured port when strict mode is requested", async () => {
    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();
    expect(mocks.state.activePort).toBe(4338);

    await ensureCallbackServer({ strictPort: true });

    expect(mocks.runtime.servers[0]?.close).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.servers[1]?.listen).toHaveBeenCalledWith(4337, "localhost", expect.any(Function));
    expect(mocks.state.activePort).toBe(4337);
  });

  it("keeps the existing callback server when strict rebind fails", async () => {
    const { ensureCallbackServer, isCallbackServerRunning } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();
    expect(mocks.state.activePort).toBe(4338);

    mocks.runtime.listenImpl = (_server, port, _host, onListen, handlers) => {
      if (port === mocks.state.configuredPort) {
        Promise.resolve().then(() => {
          handlers.get("error")?.(Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
        });
        return;
      }

      onListen();
    };

    await expect(ensureCallbackServer({ strictPort: true })).rejects.toThrow(/already in use/);

    expect(isCallbackServerRunning()).toBe(true);
    expect(mocks.runtime.servers[0]?.close).not.toHaveBeenCalled();
    expect(mocks.state.activePort).toBe(4338);
  });

  it("does not switch ports in strict mode while an authorization URL can reference the active port", async () => {
    const {
      ensureCallbackServer,
      reserveCallbackServer,
      releaseCallbackServer,
    } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();
    reserveCallbackServer("reserved-state");

    await expect(ensureCallbackServer({ strictPort: true })).rejects.toThrow(/cannot be switched while authorizations are pending/);
    expect(mocks.runtime.servers).toHaveLength(1);

    releaseCallbackServer("reserved-state");
  });

  it("reserves callback state inside ensureCallbackServer before releasing the startup lock", async () => {
    const {
      ensureCallbackServer,
      releaseCallbackServer,
    } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer({ oauthState: "atomic-reserved-state", reserveState: true });

    await expect(ensureCallbackServer({ strictPort: true })).rejects.toThrow(/cannot be switched while authorizations are pending/);
    expect(mocks.runtime.servers).toHaveLength(1);

    releaseCallbackServer("atomic-reserved-state");
  });

  it("does not switch host or path while callback state reserved by ensureCallbackServer", async () => {
    const {
      ensureCallbackServer,
      releaseCallbackServer,
    } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer({ callbackPath: "/first/callback", oauthState: "reserved-endpoint-state", reserveState: true });

    await expect(ensureCallbackServer({ callbackHost: "127.0.0.1" })).rejects.toThrow(/cannot be switched while authorizations are pending/);
    await expect(ensureCallbackServer({ callbackPath: "/second/callback" })).rejects.toThrow(/cannot be switched while authorizations are pending/);
    expect(mocks.runtime.servers).toHaveLength(1);
    expect(mocks.state.callbackPath).toBe("/first/callback");

    releaseCallbackServer("reserved-endpoint-state");
  });

  it("does not switch ports in strict mode while callbacks are pending", async () => {
    const {
      ensureCallbackServer,
      waitForCallback,
      cancelPendingCallback,
    } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();
    const pending = waitForCallback("pending-state");

    await expect(ensureCallbackServer({ strictPort: true })).rejects.toThrow(/cannot be switched while authorizations are pending/);
    expect(mocks.runtime.servers).toHaveLength(1);

    cancelPendingCallback("pending-state");
    await expect(pending).rejects.toThrow(/Authorization cancelled/);
  });

  it("stops only when no pending or reserved auth state remains", async () => {
    const {
      ensureCallbackServer,
      reserveCallbackServer,
      releaseCallbackServer,
      waitForCallback,
      cancelPendingCallback,
      isCallbackServerRunning,
      stopCallbackServerIfIdle,
    } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();
    reserveCallbackServer("reserved-state");
    await stopCallbackServerIfIdle();
    expect(isCallbackServerRunning()).toBe(true);

    releaseCallbackServer("reserved-state");
    const pending = waitForCallback("pending-state");
    await stopCallbackServerIfIdle();
    expect(isCallbackServerRunning()).toBe(true);
    cancelPendingCallback("pending-state");
    await expect(pending).rejects.toThrow(/Authorization cancelled/);
    await stopCallbackServerIfIdle();
    expect(isCallbackServerRunning()).toBe(false);
  });
});
