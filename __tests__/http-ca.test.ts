import https from "node:https";
import http from "node:http";
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
const servers: http.Server[] = [];
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

  it.each(["same-origin", "off-origin"] as const)("uses connection CA trust for provider-owned OAuth metadata with %s tokens", async tokenLocation => {
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
    const destroy = vi.spyOn(Agent.prototype, "destroy");
    const seen: string[] = [];
    let tokenEndpoint: string;
    let tokenRequests = 0;
    let challenge = false;
    const handler: http.RequestListener = async (req, res) => {
      seen.push(req.url!);
      const offOrigin = req.url === "/token" && tokenLocation === "off-origin";
      expect(req.headers["x-service"]).toBe(offOrigin ? undefined : "service-secret");
      if (!offOrigin && req.headers["x-service"] !== "service-secret") {
        res.writeHead(403).end(); return;
      }
      if (req.url === "/metadata") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ issuer: url, token_endpoint: tokenEndpoint,
          authorization_endpoint: `${url}/authorize`, response_types_supported: ["code"],
          grant_types_supported: ["client_credentials"], token_endpoint_auth_methods_supported: ["client_secret_basic"] }));
        return;
      }
      if (req.url === "/token") {
        tokenRequests++;
        expect(req.headers.authorization).toBe(`Basic ${Buffer.from("client:secret").toString("base64")}`);
        expect(req.headers["content-type"]).toContain("application/x-www-form-urlencoded");
        let body = "";
        for await (const chunk of req) body += chunk;
        expect(new URLSearchParams(body).get("grant_type")).toBe("client_credentials");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "oauth-token", token_type: "Bearer", expires_in: 3600 }));
        return;
      }
      if (req.headers.authorization !== "Bearer oauth-token" || challenge) {
        challenge = false;
        res.writeHead(401).end(); return;
      }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202).end(); return; }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "oauth-tls", version: "1" } }
        : { tools: [] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    const url = await listen(handler);
    tokenEndpoint = `${url}/token`;
    if (tokenLocation === "off-origin") {
      // Plain loopback needs no custom CA and lets us observe header isolation.
      const tokenServer = http.createServer(handler);
      servers.push(tokenServer);
      await new Promise<void>(resolve => tokenServer.listen(0, "127.0.0.1", resolve));
      const address = tokenServer.address();
      if (!address || typeof address === "string") throw new Error("no token server address");
      tokenEndpoint = `http://127.0.0.1:${address.port}/token`;
    }
    const manager = new McpServerManager();
    owners.push({ close: () => manager.close("oauth-ca") });
    const connection = await manager.connect("oauth-ca", {
      url: `${url}/mcp`, caFile, auth: "oauth",
      headers: { "x-service": "service-secret", Authorization: "service-authorization" },
      oauth: { grantType: "client_credentials", clientId: "client", clientSecret: "secret", authServerMetadataUrl: `${url}/metadata` },
    });
    expect(connection.status).toBe("connected");
    expect(connection.tools).toEqual([]);
    expect(seen).toContain("/metadata");
    expect(seen).toContain("/token");
    challenge = true;
    expect(await connection.client.listTools()).toMatchObject({ tools: [] });
    expect(tokenRequests).toBe(2);
    expect(destroy).not.toHaveBeenCalled();
    await manager.close("oauth-ca");
    expect(new Set(destroy.mock.contexts).size).toBe(1);
    expect(destroy.mock.contexts[0].destroyed).toBe(true);
    const calls = destroy.mock.calls.length;
    await connection.transport.close();
    expect(destroy.mock.calls).toHaveLength(calls);
  });

  it.each(["off-origin", "redirect"] as const)("does not extend provider CA trust through %s metadata", async location => {
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
    const destroy = vi.spyOn(Agent.prototype, "destroy");
    let destinationHits = 0;
    const other = await listen((_req, res) => { destinationHits++; res.end("{}"); });
    const url = await listen((req, res) => {
      if (req.url === "/metadata") res.writeHead(302, { location: `${other}/metadata` }).end();
      else res.writeHead(401).end();
    });
    await expect(new McpServerManager().connect(`oauth-${location}`, {
      url: `${url}/mcp`, caFile, auth: "oauth", headers: { "x-service": "secret" },
      oauth: { grantType: "client_credentials", clientId: "client",
        authServerMetadataUrl: `${location === "off-origin" ? other : url}/metadata` },
    })).rejects.toThrow();
    expect(destinationHits).toBe(0);
    expect(new Set(destroy.mock.contexts).size).toBe(1);
    expect(destroy.mock.contexts[0].destroyed).toBe(true);
  });

  it("destroys CA resources when provider configuration fails", async () => {
    const destroy = vi.spyOn(Agent.prototype, "destroy");
    await expect(new McpServerManager().connect("bad-provider", {
      url: "https://localhost/mcp", caFile, auth: "oauth",
      oauth: { authServerMetadataUrl: "not-a-url" },
    })).rejects.toThrow(/authServerMetadataUrl/);
    expect(new Set(destroy.mock.contexts).size).toBe(1);
    expect(destroy.mock.contexts[0].destroyed).toBe(true);
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
