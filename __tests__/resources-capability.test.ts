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

    await expect((manager as any).fetchAllResources(client)).resolves.toEqual([]);
    expect(listResources).not.toHaveBeenCalled();
  });

  it("lists resources for servers that advertise the capability", async () => {
    const resource = { name: "readme", uri: "test://readme" };
    const listResources = vi.fn(async () => ({ resources: [resource] }));
    const client = { getServerCapabilities: () => ({ tools: {}, resources: {} }), listResources };
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

describe("tools capability negotiation", () => {
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(m => m.closeAll()));
  });

  it("returns tools for servers that advertise the capability", async () => {
    const tool = { name: "noop", inputSchema: { type: "object" as const } };
    const listTools = vi.fn(async () => ({ tools: [tool] }));
    const client = { getServerCapabilities: () => ({ tools: {} }), listTools };
    const manager = new McpServerManager({} as any);

    await expect((manager as any).fetchAllTools(client)).resolves.toEqual([tool]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("returns an empty tool list when tools/list fails with MethodNotFound", async () => {
    // Spec-correct resources-only servers respond to tools/list with -32601.
    const listTools = vi.fn(async () => {
      throw new Error("MCP error -32601: tools not supported");
    });
    const client = { getServerCapabilities: () => ({ resources: {} }), listTools };
    const manager = new McpServerManager({} as any);

    await expect((manager as any).fetchAllTools(client)).resolves.toEqual([]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("connects to a resources-only server and surfaces an empty tool list", async () => {
    // The fixture advertises resources only — tools/list is not implemented.
    const fixture = fileURLToPath(new URL("./fixtures/resources-only-server.mjs", import.meta.url));
    const manager = new McpServerManager();
    managers.push(manager);
    await manager.connect("resources-only", { command: process.execPath, args: [fixture] });

    const connection = manager.getConnection("resources-only")!;
    expect(connection.tools).toEqual([]);
    expect(connection.resources.map(r => r.name)).toEqual(["current_price"]);
  });
});
