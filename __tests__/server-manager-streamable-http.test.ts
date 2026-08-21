import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

const servers: http.Server[] = [];
const temporaryDirectories: string[] = [];

async function withAuthStore(value: string, run: () => Promise<void>): Promise<void> {
  const previousStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
  process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = value;
  try {
    await run();
  } finally {
    if (previousStore === undefined) {
      delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    } else {
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = previousStore;
    }
  }
}

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  await Promise.all(temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true })));
  servers.length = 0;
  temporaryDirectories.length = 0;
});

describe("McpServerManager StreamableHTTP transport", () => {
  it("does not read unavailable secure storage for an unauthenticated URL-only server", async () => {
    await withAuthStore("unavailable", async () => {
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
        const message = JSON.parse(body) as { id?: string | number; method?: string };
        const result = message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: "unauthenticated", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? { tools: [] }
            : message.method === "resources/list"
              ? { resources: [] }
              : undefined;

        if (result) {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result,
          }));
          return;
        }
        if (message.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(500).end(`unexpected method: ${message.method}`);
      });
      servers.push(server);

      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

      const manager = new McpServerManager();
      const connection = await manager.connect("unauthenticated", {
        url: `http://127.0.0.1:${address.port}/mcp`,
      });

      expect(connection.status).toBe("connected");
      await manager.close("unauthenticated");
    });
  });

  it("does not multiply a transient initialize 503 inside Pi", async () => {
    const methods: string[] = [];
    let initializeAttempts = 0;
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
      const message = JSON.parse(body) as { id?: string | number; method?: string };
      methods.push(message.method ?? "");

      if (message.method === "initialize") {
        initializeAttempts += 1;
        if (initializeAttempts === 1) {
          res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({
            error: "temporarily_unavailable",
            error_description: "Credential validation is temporarily unavailable",
          }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "transient", version: "1.0.0" },
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
          jsonrpc: "2.0", id: message.id, result: { tools: [] },
        }));
        return;
      }
      if (message.method === "resources/list") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", id: message.id, result: { resources: [] },
        }));
        return;
      }
      res.writeHead(500).end(`unexpected method: ${message.method}`);
    });
    servers.push(server);

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    const manager = new McpServerManager();
    await expect(manager.connect("transient", {
      url: `http://127.0.0.1:${address.port}/mcp`,
    })).rejects.toThrow("endpoint is temporarily unavailable (HTTP 503)");

    expect(initializeAttempts).toBe(1);
    expect(methods).not.toContain("server/discover");
  });

  it("preserves the transient availability diagnosis without retry", async () => {
    const methods: string[] = [];
    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end("Method Not Allowed");
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body) as { method?: string };
      methods.push(message.method ?? "");
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({
        error: "temporarily_unavailable",
        error_description: "Credential validation is temporarily unavailable",
      }));
    });
    servers.push(server);

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    const manager = new McpServerManager();
    const error = await manager.connect("unavailable", {
      url: `http://127.0.0.1:${address.port}/mcp`,
    }).then(
      () => new Error("expected connection failure"),
      reason => reason instanceof Error ? reason : new Error(String(reason)),
    );

    expect(error.message).toContain("endpoint is temporarily unavailable (HTTP 503)");
    expect(error.message).not.toContain("does not appear to speak MCP");
    expect(methods).toEqual(["initialize"]);
  });

  it("fails closed for explicit OAuth when secure storage is unavailable", async () => {
    await withAuthStore("unavailable", async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(401, {
          "WWW-Authenticate": 'Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource"',
        }).end("Unauthorized");
      });
      servers.push(server);

      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

      const manager = new McpServerManager();
      await expect(manager.connect("oauth", {
        url: `http://127.0.0.1:${address.port}/mcp`,
        auth: "oauth",
      })).rejects.toThrow(/Failed to read OAuth credentials.*OS secure credential store/);
    });
  });

  it("does not recover through legacy fallback when a server declares Streamable HTTP", async () => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST") {
        res.writeHead(404).end("Not Found");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end("event: endpoint\ndata: /messages\n\n");
    });
    servers.push(server);

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    const manager = new McpServerManager();
    await expect(manager.connect("agent-plugin-http", {
      url: `http://127.0.0.1:${address.port}/mcp`,
      httpTransport: "streamable-http",
    })).rejects.toThrow();
  });

  it("resolves command-backed HTTP secrets without falling back to SSE on GET 405", async () => {
    const requests: string[] = [];
    const server = http.createServer(async (req, res) => {
      requests.push(`${req.method} ${req.url}`);

      if (req.headers.authorization !== "Bearer command-token" || req.headers["x-command-secret"] !== "command-header") {
        res.writeHead(401).end("Unauthorized");
        return;
      }

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
      const message = JSON.parse(body) as { id?: string | number; method?: string };

      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "post-only", version: "1.0.0" },
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
          result: { tools: [] },
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
    servers.push(server);

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");

    const manager = new McpServerManager();
    const traceDirectory = await mkdtemp(join(tmpdir(), "pi-mcp-trace-"));
    temporaryDirectories.push(traceDirectory);
    manager.setTraceConfig({ enabled: true, file: join(traceDirectory, "mcp.jsonl") });
    try {
      const connection = await manager.connect("post-only", {
        url: `http://127.0.0.1:${address.port}/mcp`,
        auth: "bearer",
        bearerToken: `!node -e "process.stdout.write('command-token')"`,
        headers: {
          "X-Command-Secret": `!node -e "process.stdout.write('command-header')"`,
        },
      });

      for (let attempt = 0; attempt < 20 && !requests.includes("GET /mcp"); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      expect(connection.status).toBe("connected");
      expect(connection.tools).toEqual([]);
      expect(connection.resources).toEqual([]);
      expect(requests).toContain("GET /mcp");
      // The SDK probes the optional GET stream once, then keeps the successful
      // POST-based session without an SSE fallback or retry storm.
      expect(requests.filter(request => request === "GET /mcp")).toHaveLength(1);

      await manager.close("post-only");
      const traceLines = (await readFile(join(traceDirectory, "mcp.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(line => JSON.parse(line) as { direction: string; method?: string });
      expect(traceLines.filter(event => event.direction === "outbound" && event.method === "initialize")).toHaveLength(1);
    } finally {
      await manager.close("post-only").catch(() => {});
    }
  });
});
