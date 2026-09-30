import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadMcpConfig } from "../config.ts";
import { getFailureMessage, initializeMcp } from "../init.ts";
import { executeCall, executeConnect } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";

type SeenRequest = { method: string | undefined; path: string | undefined; authorization: string | undefined };

const servers: http.Server[] = [];
const states: McpExtensionState[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-mcp-provider-auth-"));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "home", ".pi", "agent"));
  vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
});

afterEach(async () => {
  await Promise.all(states.map(state => state.owner.stop("test done")));
  await Promise.all(servers.map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  states.length = 0;
  servers.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function listen(handler: http.RequestListener): Promise<{ url: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  return { url: `http://127.0.0.1:${address.port}/mcp`, seen };
}

async function mcpHandler(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body) as { id?: number; method?: string };
  if (message.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "provider", version: "1.0.0" } }
    : message.method === "tools/call"
      ? { content: [{ type: "text", text: "ok" }] }
      : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}

async function boot(url: string, modelRegistry: unknown): Promise<McpExtensionState> {
  const state = await initializeMcp(
    { getFlag: vi.fn() } as unknown as ExtensionAPI,
    { cwd: root, hasUI: false, mode: "print", modelRegistry, signal: undefined } as unknown as ExtensionContext,
    undefined,
    {
      config: {
        settings: { autoAuth: true },
        mcpServers: { api: { url, auth: { provider: "github" }, lifecycle: "eager" } },
      },
    },
  );
  states.push(state);
  return state;
}

describe("auth.provider servers", () => {
  it("reads the token from the session's model registry on every request", async () => {
    const { url, seen } = await listen(mcpHandler);
    let issued = 0;
    const getApiKeyForProvider = vi.fn(async () => `token-${++issued}`);
    const state = await boot(url, { getApiKeyForProvider });

    const connection = state.manager.getConnection("api");
    expect(connection?.status).toBe("connected");
    const before = seen.length;
    await connection!.client.listTools();
    await connection!.client.listTools();

    const listed = seen.slice(before).map(request => request.authorization);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatch(/^Bearer token-\d+$/);
    expect(listed[1]).toMatch(/^Bearer token-\d+$/);
    expect(listed[0]).not.toBe(listed[1]);
    expect(getApiKeyForProvider).toHaveBeenCalledTimes(seen.length);
    expect(getApiKeyForProvider.mock.calls.every(([provider]) => provider === "github")).toBe(true);
  });

  it("shows needs sign-in with the /login hint when the provider has no token, and sends nothing", async () => {
    const { url, seen } = await listen(mcpHandler);
    const state = await boot(url, { getApiKeyForProvider: async () => undefined });

    const hint = 'MCP server "api" needs sign-in. Run /login github, then /mcp-adapter reconnect api.';
    expect(state.manager.getConnection("api")?.status).toBe("needs-auth");
    expect(getFailureMessage(state, "api")).toBe(hint);
    const result = await executeConnect(state, "api");
    expect(result.content[0]).toMatchObject({ text: hint });
    // No MCP request, and no OAuth discovery or authorization, even with autoAuth on.
    expect(seen).toEqual([]);
  });

  it("reports needs sign-in when the token disappears from an established connection", async () => {
    const { url } = await listen(mcpHandler);
    let token: string | undefined = "token";
    const state = await boot(url, { getApiKeyForProvider: async () => token });
    expect(state.manager.getConnection("api")?.status).toBe("connected");

    token = undefined;
    const result = await executeCall(state, "echo", {}, "api");

    expect(result.content[0]).toMatchObject({ text: 'MCP server "api" needs sign-in. Run /login github, then /mcp-adapter reconnect api.' });
    expect(state.manager.getConnection("api")?.status).toBe("needs-auth");
  });

  it("keeps a malformed token out of errors and notices", async () => {
    const { url } = await listen(mcpHandler);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await boot(url, { getApiKeyForProvider: async () => "s3cr3t\nt0k3n" });

    const reported = [getFailureMessage(state, "api"), ...logged.mock.calls.flat()].map(String).join("\n");
    expect(state.manager.getConnection("api")).toBeUndefined();
    expect(reported).toContain("not a valid header value");
    expect(reported).not.toMatch(/s3cr3t|t0k3n/);
  });

  it("does not connect without a model registry that provides provider tokens", async () => {
    const { url, seen } = await listen(mcpHandler);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await boot(url, {});

    expect(state.manager.getConnection("api")).toBeUndefined();
    expect(getFailureMessage(state, "api")).toContain("auth.provider isn't available here");
    expect(seen.some(request => request.method === "POST")).toBe(false);
  });

  it("loads an env-interpolated URL and checks the resolved URL when connecting", async () => {
    const { url, seen } = await listen(mcpHandler);
    vi.stubEnv("PORT", new URL(url).port);
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
    const agentDir = join(root, "home", ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "mcp-adapter.json"), JSON.stringify({
      mcpServers: {
        local: { url: "http://127.0.0.1:${PORT}/mcp", auth: { provider: "github" } },
        remote: { url: "http://example.com:${PORT}/mcp", auth: { provider: "github" } },
      },
    }));
    const { mcpServers } = loadMcpConfig(undefined, root);
    const manager = new McpServerManager();
    manager.setProviderToken(async () => "token");

    expect((await manager.connect("local", mcpServers.local!)).status).toBe("connected");
    expect(seen.every(request => request.authorization === "Bearer token")).toBe(true);
    await expect(manager.connect("remote", mcpServers.remote!)).rejects.toThrow("auth.provider requires an https URL");
    await manager.closeAll();
  });

  it("refuses redirects and never sends the token to the redirect target", async () => {
    const target = await listen(mcpHandler);
    const origin = await listen((_req, res) => {
      res.writeHead(307, { Location: target.url }).end();
    });
    const manager = new McpServerManager();
    manager.setProviderToken(async () => "secret-token");

    const error = await manager.connect("api", { url: origin.url, auth: { provider: "github" } }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("secret-token");
    expect(manager.getConnection("api")).toBeUndefined();
    expect(origin.seen[0]?.authorization).toBe("Bearer secret-token");
    expect(target.seen.every(request => request.authorization === undefined)).toBe(true);
    await manager.closeAll();
  });
});
