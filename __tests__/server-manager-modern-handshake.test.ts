// Verifies MCP 2026-07-28 negotiation through the manager's public connection API.
import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

const managers: McpServerManager[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(managers.map(manager => manager.closeAll()));
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  managers.length = 0;
  servers.length = 0;
});

describe("McpServerManager modern handshake", () => {
  it("rejects an unsupported protocol mode before starting a server", async () => {
    const manager = new McpServerManager();
    managers.push(manager);

    await expect(manager.connect("invalid-mode", {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/modern-only-server.mjs", import.meta.url))],
      protocolMode: "future" as "auto",
    })).rejects.toThrow(/protocolMode.*auto.*legacy.*2026-07-28/);
  });

  it("prefers modern mode by default on a dual-era HTTP server", async () => {
    const methods: string[] = [];
    const server = http.createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
        return;
      }

      let body = "";
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body) as {
        id?: string | number;
        method?: string;
        params?: { _meta?: Record<string, unknown> };
      };
      methods.push(message.method ?? "");

      const sendResult = (value: Record<string, unknown>) => {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { resultType: "complete", ...value },
        }));
      };

      if (message.method === "server/discover") {
        sendResult({
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {}, resources: {} },
          ttlMs: 3 * 24 * 60 * 60 * 1000,
          cacheScope: "public",
          _meta: {
            "io.modelcontextprotocol/serverInfo": { name: "modern-http", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "legacy-http", version: "1.0.0" },
          },
        }));
        return;
      }
      if (message.method === "tools/list") {
        sendResult({
          tools: [{ name: "http_modern_tool", inputSchema: { type: "object", properties: {} } }],
          ttlMs: 2 * 24 * 60 * 60 * 1000,
          cacheScope: "public",
        });
        return;
      }
      if (message.method === "resources/list") {
        sendResult({
          resources: [],
          ttlMs: 25 * 60 * 60 * 1000,
          cacheScope: "public",
        });
        return;
      }
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported method: ${message.method}` },
      }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const manager = new McpServerManager();
    managers.push(manager);
    const connectedAt = Date.now();
    const connection = await manager.connect("modern-http", {
      url: `http://127.0.0.1:${address.port}/mcp`,
      auth: false,
    });

    expect(connection.tools.map(tool => tool.name)).toEqual(["http_modern_tool"]);
    expect(connection.protocolEra).toBe("modern");
    expect(connection.metadataCachePolicy?.cacheScope).toBe("public");
    expect(connection.metadataCachePolicy?.expiresAt).toBeGreaterThan(
      connectedAt + 23 * 60 * 60 * 1000,
    );
    expect(connection.metadataCachePolicy?.expiresAt).toBeLessThanOrEqual(
      Date.now() + 24 * 60 * 60 * 1000,
    );
    expect(methods.filter(method => method === "server/discover")).toHaveLength(1);
    expect(methods).not.toContain("initialize");
  });

  it("connects to a strict MCP 2026-07-28 stdio server without initialize", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const answers = ["Continue", "Enter value", "Submit"];
    manager.setElicitationConfig({
      allowUrl: false,
      ui: {
        select: async () => answers.shift(),
        input: async () => "modern-user",
        notify: () => {},
      } as never,
    });

    const connection = await manager.connect("modern", {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/modern-only-server.mjs", import.meta.url))],
      protocolMode: "2026-07-28",
    });

    expect(connection.status).toBe("connected");
    expect(connection.tools.map(tool => tool.name)).toEqual(["modern_tool"]);
    expect(connection.protocolEra).toBe("modern");
    expect(connection.protocolVersion).toBe("2026-07-28");
    expect(connection.metadataCachePolicy).toEqual({ cacheScope: "private" });
    expect(connection.client.autoOpenedSubscription).toBeDefined();

    const result = await connection.client.callTool({ name: "modern_tool", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "accepted:modern-user" }]);
  }, 5_000);
});
