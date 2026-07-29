import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { startUiServer, type UiServerHandle, type UiServerOptions } from "../ui-server.ts";
import type { McpServerManager, ServerConnection } from "../server-manager.ts";
import type { ConsentManager } from "../consent-manager.ts";
import type { UiResourceContent, McpConfig } from "../types.ts";

// Same HTTP helper as __tests__/ui-server.test.ts.
async function request(
  url: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? "GET",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

function createMockConsentManager(): ConsentManager {
  return {
    requiresPrompt: vi.fn().mockReturnValue(false),
    shouldCacheConsent: vi.fn().mockReturnValue(true),
    ensureApproved: vi.fn(),
    registerDecision: vi.fn(),
  } as unknown as ConsentManager;
}

function createMockResource(): UiResourceContent {
  return {
    uri: "ui://test/widget",
    html: "<h1>Test App</h1>",
    mimeType: "text/html",
    meta: { permissions: [] },
  };
}

describe("UiServer /proxy/tools/call session recovery", () => {
  let handle: UiServerHandle | null = null;

  afterEach(() => {
    if (handle) {
      handle.close("test-cleanup");
      handle = null;
    }
  });

  it("recovers a terminated Streamable HTTP session transparently, when config is supplied", async () => {
    const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    const stale = {
      status: "connected",
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found")) },
    } as unknown as ServerConnection;
    const fresh = {
      status: "connected",
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "tool result" }] }) },
    } as unknown as ServerConnection;

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    } as unknown as McpServerManager;

    const config: McpConfig = { mcpServers: { "test-server": { url: "https://api.example.com/mcp" } } };

    const options: UiServerOptions = {
      serverName: "test-server",
      toolName: "test_tool",
      toolArgs: {},
      resource: createMockResource(),
      manager,
      config,
      consentManager: createMockConsentManager(),
    };

    handle = await startUiServer(options);

    const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
      method: "POST",
      body: { token: handle.sessionToken, params: { name: "some_tool", arguments: {} } },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { content: [{ type: "text", text: "tool result" }] } });
    expect((stale.client.callTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((fresh.client.callTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledWith("test-server", config.mcpServers["test-server"], stale);
  });

  it("returns auth guidance when recovery reconnect needs auth and no callback can refresh it", async () => {
    const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    const stale = {
      status: "connected",
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found")) },
    } as unknown as ServerConnection;
    const needsAuth = {
      status: "needs-auth",
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn() },
    } as unknown as ServerConnection;

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => needsAuth),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    } as unknown as McpServerManager;

    handle = await startUiServer({
      serverName: "test-server",
      toolName: "test_tool",
      toolArgs: {},
      resource: createMockResource(),
      manager,
      config: { mcpServers: { "test-server": { url: "https://api.example.com/mcp" } } },
      consentManager: createMockConsentManager(),
    });

    const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
      method: "POST",
      body: { token: handle.sessionToken, params: { name: "some_tool", arguments: {} } },
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      ok: false,
      error: expect.stringContaining('mcp({ action: "auth-start", server: "test-server" })'),
    });
  });

  it("uses the supplied auth callback when recovery reconnect returns needs-auth", async () => {
    const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    const stale = {
      status: "connected",
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found")) },
    } as unknown as ServerConnection;
    const needsAuth = {
      status: "needs-auth",
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn() },
    } as unknown as ServerConnection;
    const fresh = {
      status: "connected",
      transport: { sessionId: "session-3" },
      client: { callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "after auth" }] }) },
    } as unknown as ServerConnection;

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => needsAuth),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    } as unknown as McpServerManager;
    const onNeedsAuth = vi.fn(async () => fresh);

    handle = await startUiServer({
      serverName: "test-server",
      toolName: "test_tool",
      toolArgs: {},
      resource: createMockResource(),
      manager,
      config: { mcpServers: { "test-server": { url: "https://api.example.com/mcp" } } },
      onNeedsAuth,
      consentManager: createMockConsentManager(),
    });

    const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
      method: "POST",
      body: { token: handle.sessionToken, params: { name: "some_tool", arguments: {} } },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: { content: [{ type: "text", text: "after auth" }] } });
    expect(onNeedsAuth).toHaveBeenCalledWith("test-server");
    expect((fresh.client.callTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("runs without recovery (unchanged pre-existing behavior) when config is not supplied", async () => {
    const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

    const stale = {
      status: "connected",
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValue(new StreamableHTTPError(404, "Session not found")) },
    } as unknown as ServerConnection;

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    } as unknown as McpServerManager;

    const options: UiServerOptions = {
      serverName: "test-server",
      toolName: "test_tool",
      toolArgs: {},
      resource: createMockResource(),
      manager,
      // no `config` — recovery must not be attempted
      consentManager: createMockConsentManager(),
    };

    handle = await startUiServer(options);

    const res = await request(`http://localhost:${handle.port}/proxy/tools/call`, {
      method: "POST",
      body: { token: handle.sessionToken, params: { name: "some_tool", arguments: {} } },
    });

    expect(res.status).toBe(500);
    expect(manager.reconnect).not.toHaveBeenCalled();
    expect((stale.client.callTool as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
