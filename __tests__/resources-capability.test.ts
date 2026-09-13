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
    const client = { getServerCapabilities: () => ({ tools: {} }), listResources };
    const manager = new McpServerManager({} as any);

    await expect((manager as any).fetchAllResources(client)).resolves.toEqual({ resources: [], failed: false });
    expect(listResources).not.toHaveBeenCalled();
  });

  it("lists resources for servers that advertise the capability", async () => {
    const resource = { name: "readme", uri: "test://readme" };
    const listResources = vi.fn(async () => ({ resources: [resource] }));
    const client = { getServerCapabilities: () => ({ tools: {}, resources: {} }), listResources };
    const manager = new McpServerManager({} as any);

    await expect((manager as any).fetchAllResources(client)).resolves.toEqual({ resources: [resource], failed: false });
    expect(listResources).toHaveBeenCalledTimes(1);
  });

  it("distinguishes failed discovery from an authoritative empty list", async () => {
    const failedClient = {
      getServerCapabilities: () => ({ resources: {} }),
      listResources: vi.fn(async () => { throw new Error("unavailable"); }),
    };
    const emptyClient = {
      getServerCapabilities: () => ({ resources: {} }),
      listResources: vi.fn(async () => ({ resources: [] })),
    };
    const manager = new McpServerManager({} as any);

    await expect((manager as any).fetchAllResources(failedClient)).resolves.toEqual({ resources: [], failed: true });
    await expect((manager as any).fetchAllResources(emptyClient)).resolves.toEqual({ resources: [], failed: false });
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
