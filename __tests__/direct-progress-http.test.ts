import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { McpServerManager } from "../server-manager.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

function sendSse(res: http.ServerResponse, message: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

async function createProgressFixture() {
  const calls: Array<{
    id: string | number;
    progressToken: string | number;
    response: http.ServerResponse;
    closed: boolean;
  }> = [];
  const cancelledRequestIds: Array<string | number> = [];

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body) as {
      id?: string | number;
      method?: string;
      params?: { _meta?: { progressToken?: string | number }; requestId?: string | number };
    };

    if (message.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "progress-fixture", version: "1.0.0" },
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
        result: { tools: [{ name: "slow", inputSchema: { type: "object", properties: {} } }] },
      }));
      return;
    }
    if (message.method === "tools/call") {
      const progressToken = message.params?._meta?.progressToken;
      if (message.id === undefined || progressToken === undefined) throw new Error("missing request progress token");
      const call = { id: message.id, progressToken, response: res, closed: false };
      calls.push(call);
      res.on("close", () => { call.closed = true; });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      sendSse(res, {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken, progress: 1, total: 2, message: "plain text: not JSON" },
      });
      sendSse(res, {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken, progress: 2, total: 2, message: "done streaming" },
      });
      return;
    }
    if (message.method === "notifications/cancelled") {
      if (message.params?.requestId !== undefined) cancelledRequestIds.push(message.params.requestId);
      res.writeHead(202).end();
      return;
    }
    res.writeHead(500).end(`unexpected method: ${message.method}`);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    finish(index = 0, text = "final result") {
      const call = calls[index];
      if (!call) throw new Error("tool call not active");
      sendSse(call.response, {
        jsonrpc: "2.0",
        id: call.id,
        result: { content: [{ type: "text", text }] },
      });
      call.response.end();
    },
    get callRequest() { return calls[0]; },
    get callResponseClosed() { return calls[0]?.closed ?? false; },
    calls,
    cancelledRequestIds,
  };
}

async function createExecutor(url: string) {
  const manager = new McpServerManager();
  const connection = await manager.connect("fixture", { url, httpTransport: "streamable-http", requestTimeoutMs: 30_000 });
  const state = {
    config: { settings: { toolPrefix: "server" }, mcpServers: { fixture: { url, httpTransport: "streamable-http", requestTimeoutMs: 30_000 } } },
    manager,
    toolMetadata: new Map(),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    completedUiSessions: [],
  } as any;
  const execute = createDirectToolExecutor(() => state, () => null, {
    serverName: "fixture",
    originalName: "slow",
    prefixedName: "fixture_slow",
    description: "Slow fixture tool",
    inputSchema: { type: "object", properties: {} },
  });
  return { manager, connection, execute };
}

describe("direct tool HTTP progress", () => {
  it("forwards two request-correlated MCP progress messages before the final result", async () => {
    const fixture = await createProgressFixture();
    const { manager, execute } = await createExecutor(fixture.url);
    const updates: unknown[] = [];
    let settled = false;

    try {
      const resultPromise = execute("pi-call-7", {}, undefined, update => updates.push(update), {} as any)
        .finally(() => { settled = true; });
      for (let attempt = 0; attempt < 50 && updates.length < 2; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      expect(settled).toBe(false);
      expect(fixture.callRequest?.progressToken).toBe(fixture.callRequest?.id);
      expect(updates).toEqual([
        {
          content: [{ type: "text", text: "plain text: not JSON (1/2)" }],
          details: { progress: true, toolCallId: "pi-call-7", server: "fixture", tool: "slow", current: 1, total: 2 },
        },
        {
          content: [{ type: "text", text: "done streaming (2/2)" }],
          details: { progress: true, toolCallId: "pi-call-7", server: "fixture", tool: "slow", current: 2, total: 2 },
        },
      ]);

      fixture.finish();
      await expect(resultPromise).resolves.toMatchObject({ content: [{ type: "text", text: "final result" }] });
    } finally {
      await manager.close("fixture");
    }
  });

  it("closes only the cancelled legacy SSE POST and keeps the connection usable", async () => {
    const fixture = await createProgressFixture();
    const { manager, connection, execute } = await createExecutor(fixture.url);
    const controller = new AbortController();

    try {
      const cancelledPromise = execute("pi-call-abort", { call: 1 }, controller.signal, vi.fn(), {} as any);
      const survivingPromise = execute("pi-call-survive", { call: 2 }, undefined, vi.fn(), {} as any);
      for (let attempt = 0; attempt < 50 && fixture.calls.length < 2; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      controller.abort(new Error("user cancelled"));
      const cancelledResult = await cancelledPromise;
      for (let attempt = 0; attempt < 50 && (fixture.cancelledRequestIds.length === 0 || !fixture.calls[0]?.closed); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      expect(cancelledResult.details).toMatchObject({ error: "aborted" });
      expect(fixture.cancelledRequestIds).toEqual([fixture.calls[0]?.id]);
      expect(fixture.calls[0]?.closed).toBe(true);
      expect(fixture.calls[1]?.closed).toBe(false);
      expect(connection.status).toBe("connected");

      fixture.finish(1, "survived");
      await expect(survivingPromise).resolves.toMatchObject({ content: [{ type: "text", text: "survived" }] });

      const subsequentPromise = execute("pi-call-next", { call: 3 }, undefined, vi.fn(), {} as any);
      for (let attempt = 0; attempt < 50 && fixture.calls.length < 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      fixture.finish(2, "subsequent");
      await expect(subsequentPromise).resolves.toMatchObject({ content: [{ type: "text", text: "subsequent" }] });
    } finally {
      await manager.close("fixture");
    }
  });
});
