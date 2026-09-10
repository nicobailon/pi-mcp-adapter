import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";
import { completeAuth, createOAuthRuntime, shutdownOAuth, startAuth } from "../mcp-auth-flow.ts";
import { waitForCallback } from "../mcp-callback-server.ts";
import { getAuthForUrl, resetTestAuthSecretStore, updateTokens } from "../mcp-auth.ts";

const managers: McpServerManager[] = [];
afterEach(async () => {
  for (const manager of managers) await manager.closeAll();
  managers.length = 0;
  resetTestAuthSecretStore();
});

it("requires both service authentication and OAuth for MCP, including refresh and reconnect", async () => {
  resetTestAuthSecretStore();
  const service = "synthetic-service-key";
  let origin = "";
  let tokenNumber = 0;
  let rejectExpiredAccess = false;
  const grants: string[] = [];
  const requests: { path: string; service?: string; authorization?: string }[] = [];
  const json = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const readBody = async (request: IncomingMessage) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    return body;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    requests.push({ path: url.pathname, service: request.headers["x-service-auth"] as string | undefined, authorization: request.headers.authorization });
    // Browser navigation is separate from the service-authenticated backchannel.
    if (url.pathname === "/authorize") {
      expect(request.headers["x-service-auth"]).toBeUndefined();
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "synthetic-code");
      response.writeHead(302, { location: callback.toString() }).end();
      return;
    }
    if (request.headers["x-service-auth"] !== service) {
      response.writeHead(403).end("Service authentication required");
      return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(response, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register") {
      const body = JSON.parse(await readBody(request));
      json(response, { client_id: "synthetic-client", redirect_uris: body.redirect_uris }, 201);
      return;
    }
    if (url.pathname === "/token") {
      grants.push(new URLSearchParams(await readBody(request)).get("grant_type")!);
      tokenNumber++;
      json(response, { access_token: `oauth-${tokenNumber}`, refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600 });
      return;
    }
    if (url.pathname !== "/mcp") { response.writeHead(404).end(); return; }
    if (request.headers.authorization !== `Bearer oauth-${tokenNumber}` || tokenNumber === 0 || (rejectExpiredAccess && tokenNumber === 1)) {
      response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }).end();
      return;
    }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const message = JSON.parse(await readBody(request));
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "two-gate", version: "1.0.0" } }
      : message.method === "tools/list" ? { tools: [] } : undefined;
    if (result) json(response, { jsonrpc: "2.0", id: message.id, result });
    else response.writeHead(202).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const url = `${origin}/mcp`;
  const runtime = createOAuthRuntime();
  const manager = new McpServerManager();
  managers.push(manager);
  manager.setOAuthRuntime(runtime);
  const definition = { url, auth: "oauth" as const, headers: { "x-service-auth": service } };
  try {
    // Service authentication alone cannot access MCP.
    const serviceOnly = await fetch(url, { method: "POST", headers: definition.headers });
    expect(serviceOnly.status).toBe(401);
    await serviceOnly.body?.cancel();

    const started = await startAuth("two-gate", url, definition, { runtime });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const callback = waitForCallback(state);
    const browserResponse = await fetch(started.authorizationUrl);
    expect(browserResponse.ok).toBe(true);
    await browserResponse.body?.cancel();
    await completeAuth("two-gate", await callback, { runtime });

    // OAuth alone cannot pass the service gate either.
    const oauthOnly = await fetch(url, { method: "POST", headers: { Authorization: "Bearer oauth-1" } });
    expect(oauthOnly.status).toBe(403);
    await oauthOnly.body?.cancel();
    expect((await manager.connect("two-gate", definition)).status).toBe("connected");
    await manager.close("two-gate");

    // Expiry exercises the real transport's SDK refresh path on reconnect.
    rejectExpiredAccess = true;
    updateTokens("two-gate", { ...getAuthForUrl("two-gate", url)!.tokens!, expiresAt: Date.now() / 1000 - 3600 }, url);
    expect((await manager.connect("two-gate", definition)).status).toBe("connected");
    expect(grants).toEqual(["authorization_code", "refresh_token"]);
    expect(getAuthForUrl("two-gate", url)?.tokens?.accessToken).toBe("oauth-2");
    expect(requests.some(request => request.path === "/mcp" && request.service === service && request.authorization === "Bearer oauth-2")).toBe(true);
    for (const request of requests.filter(request => request.path.startsWith("/.well-known/") || request.path === "/register" || request.path === "/token")) {
      expect(request.service).toBe(service);
    }
  } finally {
    await manager.closeAll();
    await shutdownOAuth(runtime);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("signs connection-owned cross-origin token and MCP requests, but not provider metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-oauth-signing-"));
  const log = join(directory, "requests.jsonl");
  const script = join(directory, "sign.cjs");
  writeFileSync(script, `
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      require("node:fs").appendFileSync(${JSON.stringify(log)}, input + "\\n");
      process.stdout.write(JSON.stringify({ "x-request-signature": "synthetic-signature", "x-precedence": "command" }));
    });
  `);
  const originalFetch = globalThis.fetch;
  const origin = "https://mcp.example.test";
  const tokenUrl = "https://identity.example.test/token";
  const metadataUrl = `${origin}/oauth-metadata`;
  const seen: { url: string; method: string; bodyBase64: string; headers: Headers }[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    seen.push({ url: request.url, method: request.method, bodyBase64: Buffer.from(body).toString("base64"), headers: request.headers });
    if (request.url === metadataUrl) return json({
      issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: tokenUrl,
      response_types_supported: ["code"], grant_types_supported: ["client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
    if (request.url === tokenUrl) {
      expect(new URLSearchParams(body).get("grant_type")).toBe("client_credentials");
      expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
      return json({ access_token: "synthetic-oauth", token_type: "Bearer", expires_in: 3600 });
    }
    expect(request.url).toBe(`${origin}/mcp`);
    if (request.headers.get("authorization") !== "Bearer synthetic-oauth") return new Response(null, { status: 401 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = JSON.parse(body);
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "signed", version: "1" } }
      : message.method === "tools/list" ? { tools: [] } : undefined;
    return result ? json({ jsonrpc: "2.0", id: message.id, result }) : new Response(null, { status: 202 });
  };
  const manager = new McpServerManager();
  managers.push(manager);
  try {
    const connection = await manager.connect("signed-oauth", {
      url: `${origin}/mcp`, auth: "oauth",
      headers: { "x-service-auth": "service", "x-precedence": "configured", Authorization: "service-auth" },
      oauth: { grantType: "client_credentials", clientId: "client", clientSecret: "secret", authServerMetadataUrl: metadataUrl },
      requestHeadersCommand: { command: process.execPath, args: [script] },
    });
    expect(connection.status).toBe("connected");
    // The SDK opens its GET stream asynchronously. Let its signer reach fetch
    // before teardown can cancel it between logging and request observation.
    await expect.poll(() => seen.some(request => request.url === `${origin}/mcp` && request.method === "GET")).toBe(true);
    await manager.closeAll();
    const metadata = seen.filter(request => request.url === metadataUrl);
    expect(metadata.length).toBeGreaterThan(0);
    for (const request of metadata) {
      expect(request.headers.get("x-request-signature")).toBeNull();
      expect(request.headers.get("x-service-auth")).toBe("service");
    }
    const signed = seen.filter(request => request.url !== metadataUrl);
    expect(signed.some(request => request.url === tokenUrl)).toBe(true);
    expect(signed.some(request => request.url === `${origin}/mcp` && request.headers.get("authorization") === "Bearer synthetic-oauth")).toBe(true);
    for (const request of signed) {
      expect(request.headers.get("x-request-signature")).toBe("synthetic-signature");
      expect(request.headers.get("x-precedence")).toBe("command");
      expect(request.headers.get("x-service-auth")).toBe(request.url === tokenUrl ? null : "service");
    }
    const expected = signed.map(({ url, method, bodyBase64 }) => ({ version: 1, url, method, bodyBase64 }));
    const envelopeKey = ({ version, url, method, bodyBase64 }: typeof expected[number]) =>
      JSON.stringify([version, url, method, bodyBase64]);
    const compareEnvelopes = (a: typeof expected[number], b: typeof expected[number]) => {
      const left = envelopeKey(a);
      const right = envelopeKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    };
    // SDK requests can overlap: preserve exact envelopes and counts, not arrival order.
    expect(readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).sort(compareEnvelopes)).toEqual(
      expected.sort(compareEnvelopes),
    );
  } finally {
    try {
      await manager.closeAll();
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
