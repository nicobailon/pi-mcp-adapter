import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeMcpEndpoint } from "../mcp-probe.ts";
import { McpServerManager } from "../server-manager.ts";

const version = "2026-07-28";
const servers: http.Server[] = [];
const managers: McpServerManager[] = [];
interface WireRequest {
  method: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: { id?: string | number; method?: string; params?: { _meta?: Record<string, unknown> } };
}
const discovery = {
  resultType: "complete", supportedVersions: [version], capabilities: {},
  ttlMs: 0, cacheScope: "private",
  _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-wire-fixture", version: "1" } },
};

async function endpoint(reply: (request: WireRequest, response: http.ServerResponse, index: number) => void) {
  const wire: WireRequest[] = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const request = { method: req.method, headers: req.headers, body: text ? JSON.parse(text) : {} };
    wire.push(request);
    reply(request, res, wire.length);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  return { url: `http://127.0.0.1:${address.port}/mcp`, wire };
}

function json(res: http.ServerResponse, request: WireRequest, result: unknown) {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    jsonrpc: "2.0", id: request.body.id, result,
  }));
}

function expectModern(wire: WireRequest[]) {
  expect(wire.length).toBeGreaterThan(0);
  for (const request of wire) {
    expect(request.method).toBe("POST");
    expect(request.body.method).toBe("server/discover");
    expect(request.headers["mcp-protocol-version"]).toBe(version);
    expect(request.headers["mcp-method"]).toBe(request.body.method);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers.accept).toBe("application/json, text/event-stream");
    expect(request.headers["mcp-session-id"]).toBeUndefined();
    expect(request.body.params?._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": version,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: expect.any(String), version: expect.any(String) },
    });
  }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("pinned modern HTTP diagnostics on the wire", () => {
  it("recognizes SDK-valid discovery directly and connects without any legacy or SSE traffic", async () => {
    const { url, wire } = await endpoint((request, res) => json(res, request, discovery));
    await expect(probeMcpEndpoint(url, { protocolVersion: version })).resolves.toEqual({
      isMcp: true, classification: `endpoint supports stateless MCP ${version} server/discover`,
    });
    const manager = new McpServerManager();
    managers.push(manager);
    const connection = await manager.connect("modern", { url, protocolVersion: version });
    expect(connection.status).toBe("connected");
    await manager.closeAll();
    expect(wire).toHaveLength(2);
    expectModern(wire);
    expect(wire.every(request => request.headers.authorization === undefined)).toBe(true);
  });

  it.each(["incompatible", "malformed", "rpc-error", "404", "500", "401"])(
    "keeps %s connection errors and all diagnostic traffic within the pin", async mode => {
      const { url, wire } = await endpoint((request, res) => {
        if (mode === "incompatible") json(res, request, { ...discovery, supportedVersions: ["2025-06-18"] });
        else if (mode === "malformed") json(res, request, { ...discovery, supportedVersions: "invalid" });
        else if (mode === "rpc-error") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", id: request.body.id, error: { code: -32601, message: "Method not found" },
        }));
        else res.writeHead(Number(mode), { "content-type": "text/plain" }).end("fixture failure");
      });
      const manager = new McpServerManager();
      managers.push(manager);
      const error = await manager.connect("modern", { url, protocolVersion: version, headers: { "X-Fixture": "configured" } })
        .then(() => { throw new Error("Expected connection failure"); }, reason => reason as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error.cause).toBeInstanceOf(Error);
      expect(error.message).toContain((error.cause as Error).message);
      expect(error.message).toContain("probe:");
      expect(wire).toHaveLength(2);
      expectModern(wire);
      expect(wire[0]!.headers["x-fixture"]).toBe("configured");
      expect(wire[1]!.headers["x-fixture"]).toBeUndefined();
      expect(wire[1]!.headers.authorization).toBeUndefined();
      expect(error.message).not.toContain("does not appear to speak MCP");
    },
  );

  it("does not mislabel valid modern discovery after an original connection error", async () => {
    const { url, wire } = await endpoint((request, res, index) => {
      if (index === 1) res.writeHead(500).end("initial failure");
      else json(res, request, discovery);
    });
    const manager = new McpServerManager();
    managers.push(manager);
    await expect(manager.connect("modern", { url, protocolVersion: version })).rejects.toThrow(
      `probe: endpoint supports stateless MCP ${version} server/discover`,
    );
    expect(wire).toHaveLength(2);
    expectModern(wire);
  });

  it("recognizes a Bearer challenge without forwarding configured credentials", async () => {
    const { url, wire } = await endpoint((_request, res) => res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end());
    await expect(probeMcpEndpoint(url, { protocolVersion: version })).resolves.toMatchObject({
      isMcp: true, classification: expect.stringContaining("requires Bearer authentication"),
    });
    expect(wire).toHaveLength(1);
    expectModern(wire);
    expect(wire[0]!.headers.authorization).toBeUndefined();
  });

  it("aborts a stalled diagnostic body and retains the original connection error", async () => {
    const controller = new AbortController();
    let bodyClosed!: () => void;
    const closed = new Promise<void>(resolve => { bodyClosed = resolve; });
    const { url, wire } = await endpoint((_request, res, index) => {
      if (index === 1) res.writeHead(500).end("initial failure");
      else {
        res.on("close", bodyClosed);
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"jsonrpc":');
        controller.abort(new Error("fixture cancellation"));
      }
    });
    const manager = new McpServerManager();
    managers.push(manager);
    const error = await manager.connect("modern", { url, protocolVersion: version }, controller.signal)
      .then(() => { throw new Error("Expected failure"); }, reason => reason as Error);
    expect(error.message).toContain("500");
    await closed;
    expect(wire).toHaveLength(2);
    expectModern(wire);
  });

  it("starts no diagnostic request for a pre-cancelled operation", async () => {
    const { url, wire } = await endpoint((request, res) => json(res, request, discovery));
    const signal = AbortSignal.abort(new Error("already cancelled"));
    await expect(probeMcpEndpoint(url, { protocolVersion: version, signal })).rejects.toThrow("already cancelled");
    expect(wire).toHaveLength(0);
  });

  it("times out a stalled diagnostic without replacing the original error or falling back", async () => {
    let bodyClosed!: () => void;
    const closed = new Promise<void>(resolve => { bodyClosed = resolve; });
    const { url, wire } = await endpoint((_request, res, index) => {
      if (index === 1) res.writeHead(500).end("initial failure");
      else res.on("close", bodyClosed);
    });
    const manager = new McpServerManager();
    managers.push(manager);
    const error = await manager.connect("modern", { url, protocolVersion: version })
      .then(() => { throw new Error("Expected failure"); }, reason => reason as Error);
    expect(error.message).toContain("500");
    expect(error.message).not.toContain("probe:");
    await closed;
    expect(wire).toHaveLength(2);
    expectModern(wire);
  }, 10_000);

  it("does not forward configured bearer credentials to diagnostics", async () => {
    const { url, wire } = await endpoint((request, res, index) => {
      if (index === 1) res.writeHead(500).end();
      else json(res, request, discovery);
    });
    const manager = new McpServerManager();
    managers.push(manager);
    await expect(manager.connect("modern", {
      url, protocolVersion: version, auth: "bearer", bearerToken: "fixture-only-token",
    })).rejects.toThrow("probe: endpoint supports stateless MCP");
    expect(wire[0]!.headers.authorization).toBe("Bearer fixture-only-token");
    expect(wire[1]!.headers.authorization).toBeUndefined();
    expectModern(wire);
  });

  it.each(["legacy", "auto"] as const)("retains explicit %s legacy transport diagnostics", async protocolVersion => {
    const { url, wire } = await endpoint((request, res) => {
      if (request.body.method === "initialize") json(res, request, { protocolVersion: "2025-06-18" });
      else res.writeHead(405).end();
    });
    await expect(probeMcpEndpoint(url, { protocolVersion })).resolves.toMatchObject({ isMcp: true });
    expect(wire.map(request => request.body.method)).toEqual(protocolVersion === "legacy"
      ? ["initialize"] : ["server/discover", "initialize"]);
    const legacy = wire.at(-1)!;
    expect(legacy.headers["mcp-protocol-version"]).toBeUndefined();
    expect(legacy.headers["mcp-method"]).toBeUndefined();
    expect(legacy.body.params?._meta).toBeUndefined();
  });

  it("does not follow redirects from unauthenticated diagnostics", async () => {
    const target = await endpoint((request, res) => json(res, request, discovery));
    const source = await endpoint((_request, res) => res.writeHead(307, { Location: target.url }).end());
    await expect(probeMcpEndpoint(source.url, { protocolVersion: version })).rejects.toThrow();
    expect(target.wire).toHaveLength(0);
    expectModern(source.wire);
  });
});
