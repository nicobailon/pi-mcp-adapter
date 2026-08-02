import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

const managers: McpServerManager[] = [];
const tempDirs: string[] = [];
const legacyExitOnDiscoverServer = `
  const readline = require("node:readline");
  const lines = readline.createInterface({ input: process.stdin });
  const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "server/discover") process.exit(0);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "legacy-exit", version: "1.0.0" },
      } });
      return;
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
      return;
    }
    if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  });
`;

afterEach(async () => {
  await Promise.all(managers.map(manager => manager.closeAll()));
  managers.length = 0;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("McpServerManager legacy handshake", () => {
  it("restarts an exit-on-discover legacy stdio server when tracing is enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-traced-legacy-"));
    tempDirs.push(dir);
    const manager = new McpServerManager(dir);
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    manager.setTraceConfig({ enabled: true, file: "trace.jsonl" });

    const connection = await manager.connect("legacy-traced", {
      command: process.execPath,
      args: ["-e", legacyExitOnDiscoverServer],
    });

    expect(connection.protocolEra).toBe("legacy");
    expect(connection.status).toBe("connected");
  }, 5_000);

  it("reaches classic initialize when the server rejects server/discover", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);

    const connection = await manager.connect("legacy", {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/legacy-no-discover-server.mjs", import.meta.url))],
    });

    expect(connection.status).toBe("connected");
    expect(connection.tools.map(tool => tool.name)).toEqual(["classic_initialize_reached"]);
  }, 5_000);
});
