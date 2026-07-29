import { afterEach, describe, expect, it, vi } from "vitest";
import { join, dirname } from "node:path";
import { McpServerManager } from "../server-manager.ts";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/delayed-mcp-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };

describe("McpServerManager connection close ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const __dirname = fileURLToPath(new URL("./fixtures/delayed-mcp-server.mjs", import.meta.url));
  it("closes a connected stdio transport exactly once via client.close", async () => {
    const manager = new McpServerManager(join(__dirname, ".."));

    const connection = await manager.connect("demo", definition);
    const clientCloseSpy = vi.spyOn(connection.client, "close");
    const transportCloseSpy = vi.spyOn(connection.transport, "close");

    await manager.close("demo");

    expect(clientCloseSpy).toHaveBeenCalledTimes(1);
    expect(transportCloseSpy).toHaveBeenCalledTimes(1);
    expect(clientCloseSpy.mock.invocationCallOrder[0]).toBeLessThan(transportCloseSpy.mock.invocationCallOrder[0]);
  });
});
