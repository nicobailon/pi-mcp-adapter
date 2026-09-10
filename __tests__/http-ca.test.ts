import https from "node:https";
import type { ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "undici";
import { createCaFetch } from "../http-ca.ts";
import { McpServerManager } from "../server-manager.ts";
import type { ServerEntry } from "../types.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/ca/${name}.pem`, import.meta.url));
const caFile = fixture("server");
const servers: https.Server[] = [];
const owners: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function listen(handler: Parameters<typeof https.createServer>[1], cert = "server") {
  const server = https.createServer({ key: readFileSync(fixture("server-key")), cert: readFileSync(fixture(cert)) }, handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return `https://127.0.0.1:${address.port}`;
}

function own(url: string, file = caFile) {
  const owner = createCaFetch({ url, caFile: file })!;
  owners.push(owner);
  return owner;
}

describe("per-origin custom CA", () => {
  it("fails by default, accepts explicit CA, rejects wrong CA and isolates other origins", async () => {
    const url = await listen((_req, res) => res.end("ok"));
    const other = await listen((_req, res) => res.end("other"));
    await expect(fetch(url)).rejects.toThrow();
    await expect(new McpServerManager().connect("default", { url, auth: false })).rejects.toThrow();
    const trusted = own(url);
    expect(await (await trusted.fetch(url)).text()).toBe("ok");
    await expect(own(url, fixture("wrong")).fetch(url)).rejects.toThrow();
    await expect(trusted.fetch(other)).rejects.toThrow();
    await expect(fetch(url)).rejects.toThrow();
    await trusted.close();
    await expect(trusted.fetch(url)).rejects.toThrow();
  });

  it("rejects redirects without reaching their destination", async () => {
    let hits = 0;
    const other = await listen((_req, res) => { hits++; res.end("other"); });
    const url = await listen((_req, res) => res.writeHead(302, { location: other }).end());
    await expect(own(url).fetch(url)).rejects.toThrow();
    expect(hits).toBe(0);
  });

  it("preserves hostname verification", async () => {
    const url = await listen((_req, res) => res.end("ok"), "hostname");
    await expect(own(url, fixture("hostname")).fetch(url)).rejects.toMatchObject({ cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } });
  });

  it("preserves certificate expiry verification", async () => {
    const url = await listen((_req, res) => res.end("ok"), "expired");
    await expect(own(url).fetch(url)).rejects.toMatchObject({ cause: { code: "CERT_HAS_EXPIRED" } });
  });

  it("validates runtime boundaries and reads PEM strictly", async () => {
    const manager = new McpServerManager();
    for (const definition of [
      { url: "https://localhost", caFile: false }, { url: "https://localhost", caFile: " " },
      { url: "http://localhost", caFile }, { command: "echo", caFile }, { socket: "/tmp/mcp", caFile },
    ]) await expect(manager.connect("invalid", definition as ServerEntry)).rejects.toThrow(/caFile/);
    expect(() => own("https://localhost", "/missing/ca.pem")).toThrow(/caFile/);
    expect(() => own("https://localhost", fixture("server-key"))).toThrow(/caFile/);
    vi.stubEnv("MCP_TEST_CA", caFile);
    owners.push(createCaFetch({ url: "https://localhost", caFile: "${MCP_TEST_CA}" })!);
  });

  it.each(["streamable-http", "sse", "fallback"] as const)("connects %s with headers and closes its dispatcher", async kind => {
    const destroy = vi.spyOn(Agent.prototype, "destroy");
    const methods: string[] = [];
    let stream: ServerResponse | undefined;
    const url = await listen(async (req, res) => {
      methods.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== "Bearer token" || req.headers["x-signed"] !== "yes") {
        res.writeHead(403).end(); return;
      }
      if (req.method === "GET") {
        if (kind === "streamable-http") { res.writeHead(405).end(); return; }
        stream = res;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: endpoint\ndata: /messages\n\n"); return;
      }
      if (kind === "fallback" && req.url === "/mcp") { res.writeHead(405).end(); return; }
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tls", version: "1" } }
        : message.method === "tools/list" ? { tools: [] } : { content: [{ type: "text", text: "ok" }] };
      const response = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      if (stream) { stream.write(`event: message\ndata: ${response}\n\n`); res.writeHead(202).end(); }
      else res.writeHead(200, { "content-type": "application/json" }).end(response);
    });
    const manager = new McpServerManager();
    owners.push({ close: () => manager.close("tls") });
    const connection = await manager.connect("tls", {
      url: `${url}/mcp`, caFile, auth: "bearer", bearerToken: "token",
      ...(kind === "fallback" ? {} : { httpTransport: kind }),
      requestHeadersCommand: { command: process.execPath, args: ["-e", 'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({"x-signed":"yes"})))'] },
    });
    expect(connection.status).toBe("connected");
    expect(connection.tools).toEqual([]);
    expect(await connection.client.callTool({ name: "test", arguments: {} })).toMatchObject({ content: [{ text: "ok" }] });
    expect(methods).toContain(kind === "sse" ? "POST /messages" : "POST /mcp");
    if (kind !== "streamable-http") expect(methods).toContain("GET /mcp");
    expect(destroy).not.toHaveBeenCalled();
    await manager.close("tls");
    expect(new Set(destroy.mock.contexts).size).toBe(1);
    expect(destroy.mock.contexts[0].destroyed).toBe(true);
    const destroyCalls = destroy.mock.calls.length;
    await connection.transport.close();
    expect(destroy.mock.calls).toHaveLength(destroyCalls);
  });

  it("destroys the dispatcher after TLS connection failure", async () => {
    const destroy = vi.spyOn(Agent.prototype, "destroy");
    let requests = 0;
    const url = await listen((_req, res) => { requests++; res.end(); });
    await expect(new McpServerManager().connect("wrong", { url, caFile: fixture("wrong"), auth: false })).rejects.toThrow();
    expect(new Set(destroy.mock.contexts).size).toBe(1);
    expect(destroy.mock.contexts[0].destroyed).toBe(true);
    expect(requests).toBe(0);
  });

  // Existing manager signal composition uses AbortSignal.any (Node >=20.3).
  it.skipIf(typeof AbortSignal.any !== "function")("destroys its dispatcher on cancellation", async () => {
    const destroy = vi.spyOn(Agent.prototype, "destroy");
    let arrived!: () => void;
    const request = new Promise<void>(resolve => { arrived = resolve; });
    const url = await listen(() => arrived());
    const controller = new AbortController();
    const connecting = new McpServerManager().connect("cancel", { url, caFile, auth: false }, controller.signal);
    const rejected = expect(connecting).rejects.toThrow();
    await Promise.race([request, connecting.then(() => { throw new Error("connected before abort"); })]);
    controller.abort();
    await rejected;
    expect(new Set(destroy.mock.contexts).size).toBe(1);
    expect(destroy.mock.contexts[0].destroyed).toBe(true);
  });
});
