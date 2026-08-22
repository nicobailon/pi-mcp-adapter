import { ProtocolError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

function httpError(status: number, message: string): SdkHttpError {
  return new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, message, { status });
}

// direct-tools.ts calls lazyConnect() before touching the connection; mock
// it the same way __tests__/direct-tools-auto-auth.test.ts does so we can
// drive the "already connected" path directly.
const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: vi.fn(() => null),
}));

describe("session recovery — Streamable HTTP wire path", () => {
  it("recovers a JSON-RPC server-not-initialized response from the SDK transport", async () => {
    const { createServer } = await import("node:http");
    const { McpServerManager } = await import("../server-manager.ts");
    const { withSessionRecovery } = await import("../session-recovery.ts");

    let sessionCount = 0;
    let toolCalls = 0;
    const toolCallSessionIds: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "GET") {
        res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body) as { id?: string | number; method?: string };

      if (message.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": `session-${++sessionCount}`,
        }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "stale-session", version: "1.0.0" },
          },
        }));
        return;
      }

      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      if (message.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{
              name: sessionCount === 1 ? "search" : "lookup",
              inputSchema: { type: "object", properties: {} },
            }],
          },
        }));
        return;
      }

      if (message.method === "resources/list") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { resources: [] },
        }));
        return;
      }

      if (message.method === "tools/call") {
        toolCalls += 1;
        const sessionId = req.headers["mcp-session-id"];
        toolCallSessionIds.push(Array.isArray(sessionId) ? sessionId[0] : sessionId ?? "");
        if (toolCalls === 1) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Bad Request: Server not initialized" },
          }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "ok" }] },
        }));
        return;
      }

      res.writeHead(500).end(`unexpected method: ${message.method}`);
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    const manager = new McpServerManager();
    const definition = { url: `http://127.0.0.1:${address.port}/mcp` };
    const publishedCatalogs: string[][] = [];
    manager.setMetadataListChangedListener((_serverName, reason) => {
      if (reason === "session-reconnect") {
        publishedCatalogs.push(manager.getConnection("demo")?.tools.map(tool => tool.name) ?? []);
      }
    });
    let recoveryAttempts = 0;
    let replaySawPublishedCatalog = false;
    try {
      await manager.connect("demo", definition);
      const result = await withSessionRecovery(
        { manager, config: { mcpServers: { demo: definition } } },
        "demo",
        connection => {
          recoveryAttempts += 1;
          if (recoveryAttempts === 2) {
            replaySawPublishedCatalog = publishedCatalogs.some(tools => tools.includes("lookup"));
          }
          return connection.client.callTool({ name: "search", arguments: {} });
        },
      );

      expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
      expect(toolCalls).toBe(2);
      expect(toolCallSessionIds).toHaveLength(2);
      expect(toolCallSessionIds[0]).not.toBe(toolCallSessionIds[1]);
      expect(publishedCatalogs).toEqual([["lookup"]]);
      expect(replaySawPublishedCatalog).toBe(true);
    } finally {
      await manager.close("demo").catch(() => {});
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("polls without a notification stream and reconnects when that session later expires", async () => {
    const { createServer } = await import("node:http");
    const { McpLifecycleManager } = await import("../lifecycle.ts");
    const { McpServerManager } = await import("../server-manager.ts");

    let generation = 1;
    let rejectStaleSession = false;
    const listedSessionIds: string[] = [];
    const server = createServer(async (req, res) => {
      if (req.method === "GET") {
        res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body) as { id?: string | number; method?: string };
      const requestSessionId = Array.isArray(req.headers["mcp-session-id"])
        ? req.headers["mcp-session-id"][0]
        : req.headers["mcp-session-id"];

      if (message.method === "initialize") {
        res.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": `session-${generation}`,
        }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "replaceable", version: `${generation}.0.0` },
          },
        }));
        return;
      }

      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      if (message.method === "tools/list") {
        listedSessionIds.push(requestSessionId ?? "");
        if (rejectStaleSession && requestSessionId !== `session-${generation}`) {
          res.writeHead(404).end("Session not found");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{
              name: generation === 1
                ? "old_tool"
                : generation === 2
                  ? "refreshed_tool"
                  : "new_tool",
              inputSchema: { type: "object", properties: {} },
            }],
          },
        }));
        return;
      }

      if (message.method === "resources/list") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { resources: [] },
        }));
        return;
      }

      res.writeHead(500).end(`unexpected method: ${message.method}`);
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    const manager = new McpServerManager();
    const definition = {
      url: `http://127.0.0.1:${address.port}/mcp`,
      lifecycle: "keep-alive" as const,
    };
    const lifecycle = new McpLifecycleManager(manager);
    const reconnected = vi.fn();
    lifecycle.setReconnectCallback(reconnected);
    lifecycle.markKeepAlive("demo", definition);

    try {
      const staleConnection = await manager.connect("demo", definition);
      expect(staleConnection.tools.map(tool => tool.name)).toEqual(["old_tool"]);

      generation = 2;
      await lifecycle.ensureConverged();
      expect(manager.getConnection("demo")).toBe(staleConnection);
      expect(staleConnection.tools.map(tool => tool.name)).toEqual(["refreshed_tool"]);
      expect(reconnected).not.toHaveBeenCalled();

      generation = 3;
      rejectStaleSession = true;
      await lifecycle.ensureConverged();

      const freshConnection = manager.getConnection("demo");
      expect(freshConnection).not.toBe(staleConnection);
      expect(freshConnection?.tools.map(tool => tool.name)).toEqual(["new_tool"]);
      expect(listedSessionIds).toContain("session-1");
      expect(listedSessionIds).toContain("session-3");
      expect(reconnected).toHaveBeenCalledWith("demo");
    } finally {
      await lifecycle.gracefulShutdown().catch(() => {});
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

describe("session recovery — proxy path (proxy-modes.ts executeCall)", () => {
  it("recovers a terminated Streamable HTTP session transparently mid tool-call", async () => {
    const { executeCall } = await import("../proxy-modes.ts");


    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: {
        callTool: vi.fn().mockRejectedValueOnce(httpError(404, "Session not found")),
      },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: {
        callTool: vi.fn().mockResolvedValue({ isError: false, content: [{ type: "text", text: "ok" }] }),
      },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      toolMetadata: new Map([
        ["demo", [{ name: "demo_search", originalName: "search", description: "Search" }]],
      ]),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledWith("demo", state.config.mcpServers.demo, stale);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("ok");
  });

  it("recovers a server-not-initialized MCP error transparently mid tool-call", async () => {
    const { executeCall } = await import("../proxy-modes.ts");


    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: {
        callTool: vi.fn().mockRejectedValueOnce(new ProtocolError(-32000, "Server not initialized")),
      },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: {
        callTool: vi.fn().mockResolvedValue({ isError: false, content: [{ type: "text", text: "ok" }] }),
      },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      toolMetadata: new Map([
        ["demo", [{ name: "demo_search", originalName: "search", description: "Search" }]],
      ]),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledWith("demo", state.config.mcpServers.demo, stale);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("ok");
  });

  it("gives up after one reconnect attempt: a second server-not-initialized MCP error propagates as call_failed", async () => {
    const { executeCall } = await import("../proxy-modes.ts");


    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValue(new ProtocolError(-32000, "Server not initialized")) },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn().mockRejectedValue(new ProtocolError(-32000, "Server not initialized")) },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      toolMetadata: new Map([
        ["demo", [{ name: "demo_search", originalName: "search", description: "Search" }]],
      ]),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", {}, "demo");

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ mode: "call", error: "call_failed" });
  });

  it("gives up after one reconnect attempt: a second terminated session propagates as call_failed", async () => {
    const { executeCall } = await import("../proxy-modes.ts");


    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValue(httpError(404, "Session not found")) },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn().mockRejectedValue(httpError(404, "Session not found")) },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      toolMetadata: new Map([
        ["demo", [{ name: "demo_search", originalName: "search", description: "Search" }]],
      ]),
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", {}, "demo");

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ mode: "call", error: "call_failed" });
  });
});

describe("session recovery — direct-tools path (direct-tools.ts createDirectToolExecutor)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
  });

  it("recovers a terminated Streamable HTTP session transparently for a direct tool call", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");


    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: {
        callTool: vi.fn().mockRejectedValueOnce(httpError(404, "Session not found")),
      },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: {
        callTool: vi.fn().mockResolvedValue({ isError: false, content: [{ type: "text", text: "ok" }] }),
      },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });

    const result = await executor("id", { q: "hello" }, undefined, undefined, undefined as any);

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledWith("demo", state.config.mcpServers.demo, stale);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("ok");
  });

  it("recovers a server-not-initialized MCP error transparently for a direct tool call", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");


    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: {
        callTool: vi.fn().mockRejectedValueOnce(new ProtocolError(-32000, "Server not initialized")),
      },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: {
        callTool: vi.fn().mockResolvedValue({ isError: false, content: [{ type: "text", text: "ok" }] }),
      },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });

    const result = await executor("id", { q: "hello" }, undefined, undefined, undefined as any);

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledWith("demo", state.config.mcpServers.demo, stale);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("ok");
  });

  it("gives up after one reconnect attempt: a second terminated session propagates as call_failed", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");


    const stale = {
      status: "connected" as const,
      transport: { sessionId: "session-1" },
      client: { callTool: vi.fn().mockRejectedValue(httpError(404, "Session not found")) },
    };
    const fresh = {
      status: "connected" as const,
      transport: { sessionId: "session-2" },
      client: { callTool: vi.fn().mockRejectedValue(httpError(404, "Session not found")) },
    };

    const manager = {
      getConnection: vi.fn(() => stale),
      reconnect: vi.fn(async () => fresh),
      close: vi.fn(async () => {}),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: { settings: {}, mcpServers: { demo: { url: "https://api.example.com/mcp" } } },
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });

    const result = await executor("id", {}, undefined, undefined, undefined as any);

    expect(stale.client.callTool).toHaveBeenCalledTimes(1);
    expect(fresh.client.callTool).toHaveBeenCalledTimes(1);
    expect(manager.reconnect).toHaveBeenCalledTimes(1);
    expect(manager.close).toHaveBeenCalledWith("demo");
    expect(result.details).toMatchObject({ error: "call_failed", server: "demo" });
  });
});
