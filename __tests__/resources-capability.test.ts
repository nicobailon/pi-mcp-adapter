import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { McpServerManager } from "../server-manager.ts";

const managers: McpServerManager[] = [];

describe("resources capability negotiation", () => {
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(m => m.closeAll()));
  });

  it("skips resources/list for servers that omit the capability", async () => {
    const listResources = vi.fn(async () => ({ resources: [{ name: "unreachable", uri: "test://unreachable" }] }));
    const client = {
      getServerCapabilities: () => ({ tools: {} }),
      getProtocolEra: () => "legacy",
      listResources,
    };
    const manager = new McpServerManager({} as any);

    await expect((manager as any).fetchAllResources(client)).resolves.toEqual([]);
    expect(listResources).not.toHaveBeenCalled();
  });

  it("lists resources for servers that advertise the capability", async () => {
    const resource = { name: "readme", uri: "test://readme" };
    const listResources = vi.fn(async () => ({ resources: [resource] }));
    const client = {
      getServerCapabilities: () => ({ tools: {}, resources: {} }),
      getProtocolEra: () => "legacy",
      listResources,
    };
    const manager = new McpServerManager({} as any);

    await expect((manager as any).fetchAllResources(client)).resolves.toEqual([resource]);
    expect(listResources).toHaveBeenCalledTimes(1);
  });

  it("returns an empty resource list for a tools-only server", async () => {
    // The fixture advertises tools only, so fetchAllResources short-circuits
    // without hitting the wire.
    const fixture = fileURLToPath(new URL("./fixtures/tools-only-server.mjs", import.meta.url));
    const manager = new McpServerManager();
    managers.push(manager);
    await manager.connect("tools-only", { command: process.execPath, args: [fixture] });

    const connection = manager.getConnection("tools-only")!;
    expect(connection.tools.map(t => t.name)).toEqual(["noop"]);
    expect(connection.resources).toEqual([]);
  });
});
