import { describe, expect, it } from "vitest";
import { executeCall, executeDescribe, executeSearch } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";

function createState(): McpExtensionState {
  return {
    config: {
      mcpServers: {
        demo: { command: "npx", args: ["demo"] },
      },
    },
    toolMetadata: new Map([
      [
        "demo",
        [
          {
            name: "demo_search",
            originalName: "search",
            description: "Search demo records",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "demo_find",
            originalName: "find",
            description: "Find demo records",
          },
        ],
      ],
    ]),
    manager: {
      getConnection: () => undefined,
      isConnecting: () => false,
    },
    failureTracker: new Map(),
  } as unknown as McpExtensionState;
}

describe("proxy discovery", () => {
  it("searches MCP tools only", () => {
    const result = executeSearch(createState(), "read");

    expect(result.content[0].text).toBe('No tools matching "read"');
    expect(result.details).toMatchObject({ count: 0, matches: [] });
  });

  it("reports only the filtered server that is still connecting after a zero-result search", () => {
    const state = createState();
    state.config.mcpServers.other = { command: "npx", args: ["other"] };
    state.manager.isConnecting = () => true;

    const result = executeSearch(state, "read", false, "demo");

    expect(result.content[0].text).toBe(
      'No tools matching "read" in "demo" Server "demo" is still connecting; retry in a moment.',
    );
    expect(result.details).toMatchObject({ count: 0, matches: [], connectingServers: ["demo"] });
  });

  it("reports all enabled servers that are still connecting after an unfiltered zero-result search", () => {
    const state = createState();
    state.config.mcpServers = {
      zeta: { command: "npx", args: ["zeta"] },
      disabled: { command: "npx", args: ["disabled"], disabled: true },
      alpha: { command: "npx", args: ["alpha"] },
    };
    state.manager.isConnecting = name => name !== "disabled";

    const result = executeSearch(state, "read");

    expect(result.content[0].text).toBe(
      'No tools matching "read" Servers "alpha", "zeta" are still connecting; retry in a moment.',
    );
    expect(result.details).toMatchObject({ count: 0, matches: [], connectingServers: ["alpha", "zeta"] });
  });

  it("rejects regex queries longer than the safety cap", () => {
    const result = executeSearch(createState(), "a".repeat(257), true);

    expect(result.details).toMatchObject({ error: "query_too_long", maxLength: 256 });
  });

  it("reports malformed regex queries separately from unsafe patterns", () => {
    const result = executeSearch(createState(), "[", true);

    expect(result.details).toMatchObject({ error: "invalid_pattern" });
  });

  it("rejects catastrophic-backtracking regex queries", () => {
    const result = executeSearch(createState(), "(a+)+$", true);

    expect(result.details).toMatchObject({ error: "unsafe_pattern", safetyStatus: "vulnerable" });
  });

  it("accepts safe regex queries", () => {
    const result = executeSearch(createState(), "^demo_[a-z]+$", true);

    expect(result.details).toMatchObject({ count: 2, query: "^demo_[a-z]+$" });
  });

  it("keeps non-regex searches unaffected by the regex length cap", () => {
    const result = executeSearch(createState(), "search terms ".repeat(40), false);

    expect(result.details).not.toMatchObject({ error: "query_too_long" });
  });

  it("returns ranked paged search details", () => {
    const result = executeSearch(createState(), "demo", false, undefined, false, 1, 0);

    expect(result.details).toMatchObject({
      count: 2,
      hasMore: true,
      nextOffset: 1,
      matches: [{ server: "demo", tool: "demo_find", score: expect.any(Number) }],
    });
  });

  it("paginates regex search results without changing their order", () => {
    const result = executeSearch(createState(), "^demo_", true, undefined, false, 1, 1);

    expect(result.details).toMatchObject({
      count: 2,
      hasMore: false,
      nextOffset: null,
      matches: [{ server: "demo", tool: "demo_find", score: 0 }],
    });
  });

  it("suggests the matching tool for a prefix-mangled describe name", () => {
    const result = executeDescribe(createState(), "demo_sear");

    expect(result.details).toMatchObject({ suggestions: ["demo_search"] });
    expect(result.content[0].text).toContain("Did you mean: demo_search");
  });

  it("tells callers to invoke native Pi tools directly", async () => {
    const result = await executeCall(
      createState(),
      "read",
      undefined,
      undefined,
      () => [{ name: "read", description: "Read a file" } as any],
    );

    expect(result.content[0].text).toBe(
      '"read" is a native Pi tool. Call read directly instead of using mcp({ tool: "read" }).',
    );
    expect(result.details).toMatchObject({ error: "native_tool", requestedTool: "read" });
  });
});
