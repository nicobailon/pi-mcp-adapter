import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { McpServerManager } from "../server-manager.ts";

describe("McpServerManager connection close ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes a connected stdio transport exactly once via client.close", async () => {
    const manager = new McpServerManager(join(__dirname, ".."));

    const connection = await manager.connect("demo", {
      command: "node",
      args: [join(__dirname, "fixtures", "delayed-mcp-server.mjs")],
    });
    const clientCloseSpy = vi.spyOn(connection.client, "close");
    const transportCloseSpy = vi.spyOn(connection.transport, "close");

    await manager.close("demo");

    expect(clientCloseSpy).toHaveBeenCalledTimes(1);
    expect(transportCloseSpy).toHaveBeenCalledTimes(1);
    expect(clientCloseSpy.mock.invocationCallOrder[0]).toBeLessThan(transportCloseSpy.mock.invocationCallOrder[0]);
  });
});
