import { describe, expect, it, vi } from "vitest";
import { ProtocolError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";

const authCacheMocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
}));

vi.mock("../mcp-auth.ts", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidateAuthEntryCache: authCacheMocks.invalidate,
}));

import { SessionRecoveryAuthRequiredError, isTerminatedSession, withSessionRecovery } from "../session-recovery.ts";
import type { ServerConnection } from "../server-manager.ts";
import type { McpConfig } from "../types.ts";

function httpError(status: number, message: string): SdkHttpError {
  return new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, message, { status });
}

function makeConnection(sessionId: string | undefined): ServerConnection {
  return {
    client: {} as ServerConnection["client"],
    transport: { sessionId } as unknown as ServerConnection["transport"],
    definition: { url: "https://example.test/mcp" },
    tools: [],
    resources: [],
    prompts: [],
    lastUsedAt: Date.now(),
    inFlight: 0,
    status: "connected",
  };
}

describe("isTerminatedSession", () => {
  it("is true for a 404 StreamableHTTPError carrying a session id", () => {
    const err = httpError(404, "Session not found");
    expect(isTerminatedSession(err, true)).toBe(true);
  });

  it("is false for a 404 with no session id (never initialized / wrong URL)", () => {
    const err = httpError(404, "Not found");
    expect(isTerminatedSession(err, false)).toBe(false);
  });

  it("is true for a server-not-initialized MCP error carrying a session id", () => {
    const err = new ProtocolError(-32000, "Server not initialized");
    expect(isTerminatedSession(err, true)).toBe(true);
  });

  it("is true for the SDK's bad-request server-not-initialized MCP error", () => {
    const err = new ProtocolError(-32000, "Bad Request: Server not initialized");
    expect(isTerminatedSession(err, true)).toBe(true);
  });

  it("is true for the SDK's bad-request server-not-initialized HTTP error body", () => {
    const err = httpError(400, 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}');
    expect(isTerminatedSession(err, true)).toBe(true);
  });

  it("is false for other -32000 HTTP 400 error bodies", () => {
    const err = httpError(400, 'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Mcp-Session-Id header is required"},"id":null}');
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for server-not-initialized without a session id", () => {
    const err = new ProtocolError(-32000, "Server not initialized");
    expect(isTerminatedSession(err, false)).toBe(false);
  });

  it("is false for other -32000 MCP errors, even with a session id", () => {
    const err = new ProtocolError(-32000, "Connection closed");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for plain errors with the same message", () => {
    const err = new Error("MCP error -32000: Bad Request: Server not initialized");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for the right message with the wrong MCP error code", () => {
    const err = new ProtocolError(-32603, "Server not initialized");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for 400, even with a session id — ambiguous, never treated as expiry", () => {
    const err = httpError(400, "Bad request");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for a plain Error, even with matching message text", () => {
    const err = new Error("Streamable HTTP error: 404 session not found");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for an AbortError / cancellation", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(isTerminatedSession(err, true)).toBe(false);
  });

  it("is false for a non-Error thrown value", () => {
    expect(isTerminatedSession("boom", true)).toBe(false);
    expect(isTerminatedSession(undefined, true)).toBe(false);
  });
});

describe("withSessionRecovery", () => {
  function makeManager(overrides: {
    getConnection: () => ServerConnection | undefined;
    reconnect: (...args: unknown[]) => Promise<ServerConnection>;
  }) {
    return {
      getConnection: vi.fn(overrides.getConnection),
      reconnect: vi.fn(overrides.reconnect),
      publishMetadataChanged: vi.fn(),
    };
  }

  const config: McpConfig = {
    mcpServers: { demo: { url: "https://example.test/mcp" } },
  };

  it("transparently recovers: fn is retried exactly once against the fresh connection", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });

    const fn = vi.fn(async (conn: ServerConnection) => {
      if (conn === stale) {
        throw httpError(404, "Session not found");
      }
      return "ok";
    });

    const result = await withSessionRecovery({ manager: manager as any, config }, "demo", fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, stale);
    expect(fn).toHaveBeenNthCalledWith(2, fresh);
    expect(manager.reconnect).toHaveBeenCalledWith("demo", config.mcpServers.demo, stale);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(manager.publishMetadataChanged).toHaveBeenCalledWith("demo", fresh, "session-reconnect");
    expect(manager.publishMetadataChanged.mock.invocationCallOrder[0]).toBeLessThan(
      fn.mock.invocationCallOrder[1]!,
    );
  });

  it("transparently recovers server-not-initialized MCP errors", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });

    const fn = vi.fn(async (conn: ServerConnection) => {
      if (conn === stale) {
        throw new ProtocolError(-32000, "Server not initialized");
      }
      return "ok";
    });

    const result = await withSessionRecovery({ manager: manager as any, config }, "demo", fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, stale);
    expect(fn).toHaveBeenNthCalledWith(2, fresh);
    expect(manager.reconnect).toHaveBeenCalledWith("demo", config.mcpServers.demo, stale);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
  });

  it("still replays the tool when replacement metadata publication reports a failure", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });
    manager.publishMetadataChanged.mockImplementationOnce(() => {
      throw new Error("publication failed");
    });
    const fn = vi.fn(async (conn: ServerConnection) => {
      if (conn === stale) throw httpError(404, "Session not found");
      return "ok";
    });

    await expect(withSessionRecovery({ manager: manager as any, config }, "demo", fn)).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("invalidates OAuth credentials after a runtime 401 and preserves the error", async () => {
    const connection = makeConnection("session-1");
    const manager = makeManager({ getConnection: () => connection, reconnect: async () => connection });
    const oauthConfig: McpConfig = {
      mcpServers: { demo: { url: "https://example.test/mcp", auth: "oauth" } },
    };
    const err = httpError(401, "Unauthorized");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withSessionRecovery({ manager: manager as any, config: oauthConfig }, "demo", fn)).rejects.toBe(err);
    expect(authCacheMocks.invalidate).toHaveBeenCalledWith("demo");
    expect(manager.reconnect).not.toHaveBeenCalled();
  });

  it("does not recover unrelated -32000 MCP errors", async () => {
    const connection = makeConnection("session-1");
    const manager = makeManager({ getConnection: () => connection, reconnect: async () => connection });
    const err = new ProtocolError(-32000, "Connection closed");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withSessionRecovery({ manager: manager as any, config }, "demo", fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).not.toHaveBeenCalled();
  });

  it("lets an auth callback replace a needs-auth reconnect before retrying", async () => {
    const stale = makeConnection("session-1");
    const needsAuth = { ...makeConnection("session-2"), status: "needs-auth" as const };
    const authed = makeConnection("session-3");
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: async () => needsAuth,
    });
    const onNeedsAuth = vi.fn(async () => authed);

    const fn = vi.fn(async (conn: ServerConnection) => {
      if (conn === stale) {
        throw httpError(404, "Session not found");
      }
      return conn === authed ? "ok" : "wrong-connection";
    });

    const result = await withSessionRecovery({ manager: manager as any, config, onNeedsAuth }, "demo", fn);

    expect(result).toBe("ok");
    expect(onNeedsAuth).toHaveBeenCalledWith("demo");
    expect(fn).toHaveBeenNthCalledWith(2, authed);
  });

  it("reports auth required when reconnect cannot produce a connected session", async () => {
    const stale = makeConnection("session-1");
    const needsAuth = { ...makeConnection("session-2"), status: "needs-auth" as const };
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: async () => needsAuth,
    });
    const fn = vi.fn(async () => {
      throw httpError(404, "Session not found");
    });

    await expect(withSessionRecovery({ manager: manager as any, config }, "demo", fn))
      .rejects.toBeInstanceOf(SessionRecoveryAuthRequiredError);
  });

  it("passes the abort signal into reconnect", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const signal = new AbortController().signal;
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });
    const fn = vi.fn(async (conn: ServerConnection) => {
      if (conn === stale) {
        throw httpError(404, "Session not found");
      }
      return "ok";
    });

    await expect(withSessionRecovery({ manager: manager as any, config, signal }, "demo", fn)).resolves.toBe("ok");

    expect(manager.reconnect).toHaveBeenCalledWith("demo", config.mcpServers.demo, stale, signal);
  });

  it("does not reconnect after the caller aborts", async () => {
    const stale = makeConnection("session-1");
    const reason = new Error("stop");
    const controller = new AbortController();
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: async () => makeConnection("session-2"),
    });
    const fn = vi.fn(async () => {
      controller.abort(reason);
      throw httpError(404, "Session not found");
    });

    await expect(withSessionRecovery({ manager: manager as any, config, signal: controller.signal }, "demo", fn))
      .rejects.toBe(reason);
    expect(manager.reconnect).not.toHaveBeenCalled();
  });

  it("retries exactly once: a second server-not-initialized MCP error propagates unchanged", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });

    const err1 = new ProtocolError(-32000, "Server not initialized");
    const err2 = new ProtocolError(-32000, "Server not initialized");
    const fn = vi.fn().mockRejectedValueOnce(err1).mockRejectedValueOnce(err2);

    await expect(withSessionRecovery({ manager: manager as any, config }, "demo", fn)).rejects.toBe(err2);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once: a second 404 propagates unchanged", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: async () => fresh,
    });

    const err1 = httpError(404, "Session not found");
    const err2 = httpError(404, "Session not found");
    const fn = vi.fn().mockRejectedValueOnce(err1).mockRejectedValueOnce(err2);

    await expect(withSessionRecovery({ manager: manager as any, config }, "demo", fn)).rejects.toBe(err2);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not recover a resolved tool-result error (isError content is not a thrown error)", async () => {
    const connection = makeConnection("session-1");
    const manager = makeManager({ getConnection: () => connection, reconnect: async () => connection });
    const fn = vi.fn(async () => ({ isError: true, content: [] }));

    const result = await withSessionRecovery({ manager: manager as any, config }, "demo", fn);

    expect(result).toEqual({ isError: true, content: [] });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).not.toHaveBeenCalled();
  });

  it("does not recover a 404 without a session id (never initialized / wrong URL)", async () => {
    const connection = makeConnection(undefined);
    const manager = makeManager({ getConnection: () => connection, reconnect: async () => connection });
    const err = httpError(404, "Not found");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withSessionRecovery({ manager: manager as any, config }, "demo", fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).not.toHaveBeenCalled();
  });

  it("does not recover an AbortError", async () => {
    const connection = makeConnection("session-1");
    const manager = makeManager({ getConnection: () => connection, reconnect: async () => connection });
    const err = new DOMException("aborted", "AbortError");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withSessionRecovery({ manager: manager as any, config }, "demo", fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).not.toHaveBeenCalled();
  });

  it("does not recover a 400 (ambiguous status, never matched)", async () => {
    const connection = makeConnection("session-1");
    const manager = makeManager({ getConnection: () => connection, reconnect: async () => connection });
    const err = httpError(400, "Bad request");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withSessionRecovery({ manager: manager as any, config }, "demo", fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).not.toHaveBeenCalled();
  });

  it("rethrows the original error when the server was removed from config before reconnecting", async () => {
    const connection = makeConnection("session-1");
    const manager = makeManager({ getConnection: () => connection, reconnect: async () => connection });
    const err = httpError(404, "Session not found");
    const fn = vi.fn().mockRejectedValue(err);
    const emptyConfig: McpConfig = { mcpServers: {} };

    await expect(withSessionRecovery({ manager: manager as any, config: emptyConfig }, "demo", fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).not.toHaveBeenCalled();
  });

  it("concurrency: two simultaneous session failures both replay against the same fresh connection", async () => {
    const stale = makeConnection("session-1");
    const fresh = makeConnection("session-2");

    // Simulate McpServerManager.reconnect's real single-flight contract: no
    // matter how many callers ask, they all get the same in-flight promise
    // resolving to the same fresh connection.
    const sharedReconnect = Promise.resolve(fresh);
    const manager = makeManager({
      getConnection: () => stale,
      reconnect: () => sharedReconnect,
    });

    const fn = vi.fn(async (conn: ServerConnection) => {
      if (conn === stale) {
        throw httpError(404, "Session not found");
      }
      return conn === fresh ? "ok" : "unexpected";
    });

    const [r1, r2] = await Promise.all([
      withSessionRecovery({ manager: manager as any, config }, "demo", fn),
      withSessionRecovery({ manager: manager as any, config }, "demo", fn),
    ]);

    expect(r1).toBe("ok");
    expect(r2).toBe("ok");
    // Each caller's own failure triggers its own reconnect() call, but the
    // manager's single-flight dedupes the underlying work; both resolve to
    // the identical fresh connection.
    expect(manager.reconnect).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(4); // 2 failed stale attempts + 2 successful fresh replays
  });
});
