import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

const managers: McpServerManager[] = [];

afterEach(async () => {
  await Promise.all(managers.map(manager => manager.closeAll()));
  managers.length = 0;
});

describe("McpServerManager legacy handshake", () => {
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
