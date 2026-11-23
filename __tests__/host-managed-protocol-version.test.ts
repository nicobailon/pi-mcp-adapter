import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHostManagedMcpAdapter, type HostManagedMcpAdapter, type HostManagedMcpServer } from "../host-managed.ts";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";

const version = "2026-07-28";
const marker = "host-modern-marker";
const servers: http.Server[] = [];
const adapters: HostManagedMcpAdapter[] = [];
interface Wire {
  httpMethod: string | undefined;
  headers: http.IncomingHttpHeaders;
  message: { id?: string | number; method?: string; params?: { _meta?: Record<string, unknown> } };
}

async function fixture(mode = "success") {
  const wire: Wire[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message: Wire["message"] = body ? JSON.parse(body) : {};
    wire.push({ httpMethod: req.method, headers: req.headers, message });
    if (req.method !== "POST" || (mode === "legacy-only" && message.method === "server/discover")) return void res.writeHead(405).end();
    if ((mode === "list-error" && message.method === "tools/list") || (mode === "call-error" && message.method === "tools/call")) return void res.writeHead(500).end("fixture error");
    if (mode === "500" || mode === "401" || mode === "404") return void res.writeHead(Number(mode)).end("fixture error");
    if (message.id === undefined) return void res.writeHead(202).end();
    const result = message.method === "server/discover" ? {
      supportedVersions: mode === "incompatible" ? ["2025-06-18"] : mode === "malformed" ? false : [version],
      capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private", resultType: "complete",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "host-wire", version: "1" } },
    } : message.method === "initialize" ? {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy-wire", version: "1" },
    } : message.method === "tools/list" ? {
      resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }],
    } : { resultType: "complete", content: [{ type: "text", text: marker }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      jsonrpc: "2.0", id: message.id, ...(mode === "rpc-error"
        ? { error: { code: -32601, message: "Method not found" } } : { result }),
    }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return { wire, createTransport: () => new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)) };
}

function adapter(server: HostManagedMcpServer) {
  const instance = createHostManagedMcpAdapter({ servers: { fixture: server }, onToolCall: call => call.dispatch(), requestTimeoutMs: 1_000 });
  adapters.push(instance);
  return instance;
}

async function call(instance: HostManagedMcpAdapter) {
  let execute: (id: string, args: unknown, signal: undefined, onUpdate: undefined, context: unknown) => Promise<{ content: Array<{ text?: string }> }>;
  const events = createEventBus();
  events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, event => (event as McpToolApprovalRequest).claim(() => "allow_once"));
  instance.extensionFactory({ events, registerTool: (tool: { execute: typeof execute }) => { execute = tool.execute; } } as unknown as ExtensionAPI);
  return execute!("wire-call", {}, undefined, undefined, {});
}

function expectPinned(wire: Wire[]) {
  for (const request of wire) {
    expect(request.httpMethod).toBe("POST");
    expect(request.message.method).not.toBe("initialize");
    expect(request.headers["mcp-protocol-version"]).toBe(version);
    expect(request.headers["mcp-method"]).toBe(request.message.method);
    expect(request.headers.accept).toBe("application/json, text/event-stream");
    expect(request.headers["mcp-session-id"]).toBeUndefined();
    expect(request.message.params?._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "pi-mcp-fixture", version: "1.0.0" },
    });
  }
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(instance => instance.close()));
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("host-managed per-server protocol version", () => {
  it.each([version, "auto"] as const)("uses true %s SDK negotiation for discovery/list/call and returns the marker", async protocolVersion => {
    const endpoint = await fixture();
    const instance = adapter({ createTransport: endpoint.createTransport, protocolVersion });
    await instance.ready();
    expect((await call(instance)).content).toEqual([{ type: "text", text: marker }]);
    await instance.close();
    expect(endpoint.wire.map(request => request.message.method)).toEqual(["server/discover", "tools/list", "tools/call"]);
    expectPinned(endpoint.wire);
  });

  it.each(["incompatible", "malformed", "rpc-error", "500", "401", "404"])("fails pinned %s without initialize, SSE GET, or diagnostic fallback", async mode => {
    const endpoint = await fixture(mode);
    const instance = adapter({ createTransport: endpoint.createTransport, protocolVersion: version });
    const error = await instance.ready().then(() => { throw new Error("Expected failure"); }, reason => reason as Error);
    expect(error.message).toContain("failed to start");
    expect(error.cause).toBeInstanceOf(Error);
    expect(endpoint.wire).toHaveLength(1);
    expectPinned(endpoint.wire);
  });

  it.each([undefined, "legacy"] as const)("preserves the %s legacy default", async protocolVersion => {
    const endpoint = await fixture();
    const instance = adapter({ createTransport: endpoint.createTransport, protocolVersion });
    await instance.ready();
    expect((await call(instance)).content).toEqual([{ type: "text", text: marker }]);
    await instance.close();
    const posts = endpoint.wire.filter(request => request.httpMethod === "POST");
    expect(posts.map(request => request.message.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(endpoint.wire.some(request => request.message.method === "server/discover")).toBe(false);
    expect(posts[0]!.headers["mcp-protocol-version"]).toBeUndefined();
    expect(posts[0]!.message.params?._meta).toBeUndefined();
  });

  it("retains auto fallback to a legacy-only server", async () => {
    const endpoint = await fixture("legacy-only");
    const instance = adapter({ createTransport: endpoint.createTransport, protocolVersion: "auto" });
    await instance.ready();
    expect((await call(instance)).content).toEqual([{ type: "text", text: marker }]);
    await instance.close();
    expect(endpoint.wire.filter(request => request.httpMethod === "POST").map(request => request.message.method))
      .toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list", "tools/call"]);
  });

  it.each(["list-error", "call-error"])("keeps %s pinned without replay or diagnostics", async mode => {
    const endpoint = await fixture(mode);
    const instance = adapter({ createTransport: endpoint.createTransport, protocolVersion: version });
    if (mode === "list-error") await expect(instance.ready()).rejects.toThrow("failed to start");
    else {
      await instance.ready();
      expect((await call(instance)).content[0]?.text).toContain("may have run");
    }
    expect(endpoint.wire.map(request => request.message.method)).toEqual(mode === "list-error"
      ? ["server/discover", "tools/list"] : ["server/discover", "tools/list", "tools/call"]);
    expectPinned(endpoint.wire);
  });

  it("rejects unknown values before creating that server's transport", async () => {
    const createTransport = vi.fn();
    const instance = adapter({ createTransport, protocolVersion: "unsupported" as HostManagedMcpServer["protocolVersion"] });
    const error = await instance.ready().then(() => { throw new Error("Expected failure"); }, reason => reason as Error);
    expect((error.cause as Error).message).toBe("Unsupported host-managed MCP protocolVersion");
    expect(createTransport).not.toHaveBeenCalled();
  });
});
