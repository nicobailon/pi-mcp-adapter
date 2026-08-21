import { describe, expect, it } from "vitest";
import { executeList, executeSearch, executeStatus } from "../proxy-modes.ts";
import { createMcpStatusSnapshot } from "../mcp-status.ts";
import type { McpExtensionState } from "../state.ts";

function createState() {
  return {
    config: {
      mcpServers: {
        demo: { command: "npx", args: ["demo"] },
        ghost: { command: "npx", args: ["ghost"] },
        idle: { command: "npx", args: ["idle"] },
      },
    },
    toolMetadata: new Map([
      [
        "demo",
        [
          { name: "demo_search", originalName: "search", description: "Search demo records" },
        ],
      ],
      [
        "ghost",
        [
          { name: "ghost_search", originalName: "search", description: "Search ghost records" },
          { name: "ghost_find", originalName: "find", description: "Find ghost records" },
        ],
      ],
    ]),
    manager: {
      getConnection: () => undefined,
      isConnecting: () => false,
    },
    failureTracker: new Map<string, number>(),
  } as unknown as McpExtensionState;
}

describe("failure backoff keeps failed servers out of discovery surfaces (F20)", () => {
  it("excludes a recently-failed server's cached tools from search and says so", () => {
    const state = createState();
    state.failureTracker.set("ghost", Date.now() - 5_000);

    const result = executeSearch(state, "search");

    expect(result.details).toMatchObject({ count: 1, excludedServers: ["ghost"] });
    expect(result.content[0].text).toContain("demo_search");
    expect(result.content[0].text).not.toContain("ghost_search");
    expect(result.content[0].text).toContain("Excluded while failing (retry after reconnect): ghost");
  });

  it("excludes a failed server from regex search", () => {
    const state = createState();
    state.failureTracker.set("ghost", Date.now() - 5_000);

    const result = executeSearch(state, "ghost_", true);

    expect(result.details).toMatchObject({ count: 0, excludedServers: ["ghost"] });
    expect(result.content[0].text).toContain("Excluded while failing");
  });

  it("excludes a failed server from an empty per-server listing query", () => {
    const state = createState();
    state.failureTracker.set("ghost", Date.now() - 5_000);

    const result = executeSearch(state, "", false, "ghost");

    expect(result.details).toMatchObject({ count: 0, excludedServers: ["ghost"] });
    expect(result.content[0].text).toContain("Excluded while failing");
  });

  it("trusts a server again once its failure ages out of the backoff window", () => {
    const state = createState();
    state.failureTracker.set("ghost", Date.now() - 120_000);

    const result = executeSearch(state, "search");

    expect(result.details).toMatchObject({ count: 2 });
    expect(result.details).not.toHaveProperty("excludedServers");
    expect(result.content[0].text).toContain("ghost_search");
  });

  it("withholds a failed server's cached tool list and points at reconnect", () => {
    const state = createState();
    state.failureTracker.set("ghost", Date.now() - 5_000);

    const result = executeList(state, "ghost");

    expect(result.details).toMatchObject({ mode: "list", server: "ghost", count: 0, error: "recent_failure" });
    expect(result.content[0].text).toContain("failed");
    expect(result.content[0].text).toContain('mcp({ connect: "ghost" })');
  });
});

describe("status reporting does not misrepresent availability (F20/N2/N3)", () => {
  it("excludes a failed server's cached tools from the total and flags it", () => {
    const state = createState();
    state.failureTracker.set("ghost", Date.now() - 5_000);

    const result = executeStatus(state);

    expect(result.content[0].text).toContain("0/3 servers, 1 tools (1 failing, excluded from counts; 1 disconnected, counts unknown)");
    expect(result.content[0].text).toContain("✗ ghost (failed");
    expect(result.details).toMatchObject({ totalTools: 1, failingCount: 1 });
  });

  it("does not present a connected zero-tool server as healthy", () => {
    const state = createState();
    state.config.mcpServers = { empty: { command: "npx", args: ["empty"] } };
    state.toolMetadata.delete("demo");
    state.toolMetadata.delete("ghost");
    (state as { manager: { getConnection: (name: string) => unknown } }).manager.getConnection = () => ({
      status: "connected",
      tools: [],
      resources: [],
    });

    const result = executeStatus(state);

    expect(result.content[0].text).toContain("1/1 servers, 0 tools");
    expect(result.content[0].text).toContain("⚠ empty (0 tools)");
    expect(result.content[0].text).not.toContain("✓ empty");
  });

  it("reports a disconnected no-metadata server as unknown, not as zero tools", () => {
    const state = createState();
    state.config.mcpServers = { demo: { command: "npx", args: ["demo"] }, idle: { command: "npx", args: ["idle"] } };
    state.toolMetadata.delete("ghost");

    const result = executeStatus(state);

    expect(result.content[0].text).toContain("0/2 servers, 1 tools (1 disconnected, counts unknown)");
    expect(result.content[0].text).toContain("○ idle (not connected)");
  });

  it("keeps a failed server's cached catalog out of snapshot totals", () => {
    const state = createState();
    state.failureTracker.set("ghost", Date.now() - 5_000);
    state.resourceCounts = new Map();

    const snapshot = createMcpStatusSnapshot(state);

    expect(snapshot.totalTools).toBe(1);
    expect(snapshot.servers.find(server => server.name === "ghost")).toMatchObject({ status: "failed" });
  });
});
