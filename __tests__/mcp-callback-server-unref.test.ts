/**
 * Regression: OAuth callback server must call server.unref() after binding so that
 * sub-agent processes (which have no other active work) can exit naturally when done.
 *
 * Without unref(), the HTTP server keeps the Node.js event loop alive and the sub-agent
 * process hangs indefinitely after completing its task.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockServer = {
    listen: vi.fn(),
    once: vi.fn(),
    close: vi.fn(),
    unref: vi.fn(),
  };
  return {
    mockServer,
    createServer: vi.fn(() => mockServer),
    getConfiguredOAuthCallbackPort: vi.fn(() => 4337),
    getOAuthCallbackPort: vi.fn(() => 4337),
    setOAuthCallbackPort: vi.fn(),
  };
});

vi.mock("http", () => ({
  createServer: mocks.createServer,
}));

vi.mock("../mcp-oauth-provider.js", () => ({
  OAUTH_CALLBACK_PATH: "/mcp/oauth/callback",
  getConfiguredOAuthCallbackPort: mocks.getConfiguredOAuthCallbackPort,
  getOAuthCallbackPort: mocks.getOAuthCallbackPort,
  setOAuthCallbackPort: mocks.setOAuthCallbackPort,
}));

describe("ensureCallbackServer: sub-agent process exit", () => {
  beforeEach(() => {
    vi.resetModules();

    mocks.mockServer.listen.mockReset();
    mocks.mockServer.once.mockReset().mockReturnValue(mocks.mockServer);
    mocks.mockServer.unref.mockReset();
    mocks.mockServer.close.mockReset().mockImplementation((cb?: () => void) => cb?.());
    mocks.createServer.mockReset().mockReturnValue(mocks.mockServer);
    mocks.getConfiguredOAuthCallbackPort.mockReset().mockReturnValue(4337);
    mocks.getOAuthCallbackPort.mockReset().mockReturnValue(4337);
    mocks.setOAuthCallbackPort.mockReset();

    // Simulate a successful port bind: resolve the listen promise immediately
    mocks.mockServer.listen.mockImplementation(
      (_port: number, _host: string, cb: () => void) => {
        cb();
      }
    );
  });

  it("calls server.unref() after binding so the OAuth server does not prevent sub-agent exit", async () => {
    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await ensureCallbackServer();

    expect(mocks.mockServer.unref).toHaveBeenCalledTimes(1);
  });

  it("does not call unref() on a failed bind (port in use)", async () => {
    // Simulate EADDRINUSE on every port in the scan range
    mocks.mockServer.listen.mockImplementation(
      (_port: number, _host: string, _cb: () => void) => {
        // Do nothing — the "error" handler will fire instead
      }
    );
    mocks.mockServer.once.mockImplementation(
      (event: string, handler: (err: NodeJS.ErrnoException) => void) => {
        if (event === "error") {
          const err = Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
          // Defer to simulate async error
          Promise.resolve().then(() => handler(err));
        }
        return mocks.mockServer;
      }
    );

    const { ensureCallbackServer } = await import("../mcp-callback-server.ts");

    await expect(ensureCallbackServer({ strictPort: true })).rejects.toThrow();

    expect(mocks.mockServer.unref).not.toHaveBeenCalled();
  });
});
