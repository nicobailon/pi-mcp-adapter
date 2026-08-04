import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

const managers: McpServerManager[] = [];
const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(managers.map(manager => manager.closeAll()));
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  await Promise.all(temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true })));
  managers.length = 0;
  servers.length = 0;
  temporaryDirectories.length = 0;
});

describe("McpServerManager Unix socket transport", () => {
  it.each([
    { label: "legacy default", protocolVersion: undefined },
    { label: "auto in-place fallback", protocolVersion: "auto" as const },
  ])("connects to an rmcp-mux-compatible socket and discovers tools ($label)", async ({ protocolVersion }) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-mcp-socket-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "shared.sock");
    const server = createServer(socket => {
      const buffer = new ReadBuffer();
      socket.on("data", chunk => {
        buffer.append(chunk);
        while (true) {
          const message = buffer.readMessage();
          if (message === null) break;
          const request = message as JSONRPCMessage & { id?: string | number; method?: string };
          const result = request.method === "initialize"
            ? {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "shared", version: "1.0.0" },
              }
            : request.method === "tools/list"
              ? { tools: [{ name: "shared_tool", inputSchema: { type: "object" } }] }
              : undefined;
          if (result !== undefined) {
            socket.write(serializeMessage({ jsonrpc: "2.0", id: request.id!, result }));
          } else if (request.id !== undefined) {
            socket.write(serializeMessage({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: "Method not found" },
            }));
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));

    const manager = new McpServerManager();
    managers.push(manager);
    const connection = await manager.connect("shared", {
      socket: socketPath,
      ...(protocolVersion ? { protocolVersion } : {}),
    });

    expect(connection.status).toBe("connected");
    expect(connection.tools.map(tool => tool.name)).toEqual(["shared_tool"]);
  });

  it.each([
    { socket: "/tmp/shared.sock", command: "server" },
    { socket: "/tmp/shared.sock", url: "https://example.test/mcp" },
  ])("rejects multiple configured transports", async definition => {
    const manager = new McpServerManager();
    managers.push(manager);
    await expect(manager.connect("invalid", definition)).rejects.toThrow(
      "must configure exactly one of command, url, or socket",
    );
  });
});
