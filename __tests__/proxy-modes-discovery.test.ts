import { describe, expect, it, vi } from "vitest";
import { executeCall, executeDescribe, executeList, executeSearch, executeStatus } from "../proxy-modes.ts";
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
    serverInstructions: new Map(),
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

  it("finds tools through configured search keywords", () => {
    const state = createState();
    state.config.mcpServers.demo!.searchKeywords = { find: ["zzalias finder"] };

    expect(executeSearch(createState(), "zzalias").details).toMatchObject({ count: 0 });
    expect(executeSearch(state, "zzalias").details).toMatchObject({
      count: 1,
      matches: [{ server: "demo", tool: "demo_find", score: expect.any(Number) }],
    });
  });

  it("matches keyword keys by prefixed name and glob", () => {
    const prefixed = createState();
    prefixed.config.mcpServers.demo!.searchKeywords = { demo_find: ["zzalias"] };
    expect(executeSearch(prefixed, "zzalias").details).toMatchObject({ count: 1, matches: [{ tool: "demo_find" }] });

    const glob = createState();
    glob.config.mcpServers.demo!.searchKeywords = { "*": ["zzalias"] };
    expect(executeSearch(glob, "zzalias").details).toMatchObject({ count: 2 });
  });

  it("matches keywords in regex search mode", () => {
    const state = createState();
    state.config.mcpServers.demo!.searchKeywords = { find: ["zzalias finder"] };

    expect(executeSearch(state, "^zzali", true).details).toMatchObject({
      count: 1,
      matches: [{ server: "demo", tool: "demo_find", score: 0 }],
    });
  });

  it("keeps keywords out of search and describe output", () => {
    const state = createState();
    state.config.mcpServers.demo!.searchKeywords = { find: ["zzalias finder"] };

    const search = executeSearch(state, "zzalias");
    expect(search.content[0].text).toContain("demo_find");
    // Only the echoed query may mention the keyword — never the configured phrase.
    expect(JSON.stringify(search)).not.toContain("zzalias finder");

    const describeResult = executeDescribe(state, "demo_find");
    expect(JSON.stringify(describeResult)).not.toContain("zzalias");
  });

  it("keeps cached failed-backoff tools out of proxy discovery surfaces", () => {
    const state = createState();
    state.failureTracker.set("demo", Date.now());

    expect(executeSearch(state, "demo").details).toMatchObject({ count: 0, matches: [] });
    expect(executeDescribe(state, "demo_search").details).toMatchObject({ mode: "describe", error: "server_backoff", server: "demo" });
    expect(executeList(state, "demo").details).toMatchObject({ mode: "list", error: "server_backoff", tools: [], count: 0 });
    expect(executeStatus(state).details).toMatchObject({
      totalTools: 0,
      servers: [expect.objectContaining({ name: "demo", status: "failed", toolCount: 0 })],
    });
  });

  it("does not filter needs-auth servers with stale failure entries", () => {
    const state = createState();
    state.failureTracker.set("demo", Date.now());
    state.manager.getConnection = () => ({ status: "needs-auth" }) as any;

    expect(executeSearch(state, "demo").details).toMatchObject({ count: 2 });
    expect(executeList(state, "demo").details).toMatchObject({ mode: "list", count: 2 });
    expect(executeStatus(state).details).toMatchObject({
      totalTools: 2,
      servers: [expect.objectContaining({ name: "demo", status: "needs-auth", toolCount: 2 })],
    });
  });

  it("suggests the matching tool for a prefix-mangled describe name", () => {
    const result = executeDescribe(createState(), "demo_sear");

    expect(result.details).toMatchObject({ suggestions: ["demo_search"] });
    expect(result.content[0].text).toContain("Did you mean: demo_search");
  });

  it("does not suggest tools through configured search keywords", async () => {
    const state = createState();
    state.config.mcpServers.demo!.searchKeywords = { find: ["zzalias"] };

    expect(executeSearch(state, "zzalias").details).toMatchObject({ count: 1, matches: [{ tool: "demo_find" }] });
    expect(executeDescribe(state, "zzalias").details).toMatchObject({ suggestions: [] });

    const call = await executeCall(state, "zzalias");
    expect(call.details).toMatchObject({ error: "tool_not_found", suggestions: [] });
  });

  it("prefers an exact describe name over an earlier normalized fallback", () => {
    const state = {
      config: { mcpServers: { "demo-a": { command: "fallback" }, demo: { command: "exact" } } },
      toolMetadata: new Map([
        ["demo-a", [{ name: "demo-a_b", originalName: "b", description: "Fallback" }]],
        ["demo", [{ name: "demo_a_b", originalName: "a_b", description: "Exact" }]],
      ]),
      manager: { getConnection: () => undefined },
      failureTracker: new Map(),
    } as unknown as McpExtensionState;

    expect(executeDescribe(state, "demo_a_b").details).toMatchObject({
      server: "demo",
      tool: { originalName: "a_b" },
    });
  });

  it("fails closed for duplicate unqualified proxy names", async () => {
    const firstCall = vi.fn(async () => ({ content: [{ type: "text", text: "first" }] }));
    const secondCall = vi.fn(async () => ({ content: [{ type: "text", text: "second" }] }));
    const state = {
      config: {
        mcpServers: {
          "my server": { command: "first" },
          my_20_server: { command: "second" },
        },
      },
      toolMetadata: new Map([
        ["my server", [{ name: "my_20_server_get", originalName: "get", description: "First" }]],
        ["my_20_server", [{ name: "my_20_server_get", originalName: "get", description: "Second" }]],
      ]),
      manager: {
        getConnection: (server: string) => ({ status: "connected", client: server === "my server" ? { callTool: firstCall } : { callTool: secondCall } }),
        touch: () => {},
        incrementInFlight: () => {},
        decrementInFlight: () => {},
        getRequestOptions: () => undefined,
      },
      failureTracker: new Map(),
      serverInstructions: new Map(),
      completedUiSessions: [],
    } as unknown as McpExtensionState;

    expect(executeDescribe(state, "my_20_server_get").details).toMatchObject({ error: "ambiguous_tool" });
    await expect(executeCall(state, "my_20_server_get", {})).resolves.toMatchObject({ details: { error: "ambiguous_tool" } });
    expect(firstCall).not.toHaveBeenCalled();
    expect(secondCall).not.toHaveBeenCalled();
    await expect(executeCall(state, "my_20_server_get", {}, "my server")).resolves.toMatchObject({ details: { server: "my server", tool: "get" } });
    expect(firstCall).toHaveBeenCalledTimes(1);
  });

  it("fails closed for same-server normalized fallback collisions", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "called" }] }));
    const state = {
      config: { mcpServers: { demo: { command: "demo" } } },
      toolMetadata: new Map([["demo", [
        { name: "demo_a-b_c", originalName: "a-b_c", description: "First" },
        { name: "demo_a_b-c", originalName: "a_b-c", description: "Second" },
      ]]]),
      manager: {
        getConnection: () => ({ status: "connected", client: { callTool } }),
        touch: () => {},
        incrementInFlight: () => {},
        decrementInFlight: () => {},
        getRequestOptions: () => undefined,
      },
      failureTracker: new Map(),
      serverInstructions: new Map(),
      completedUiSessions: [],
    } as unknown as McpExtensionState;

    expect(executeDescribe(state, "demo_a_b_c").details).toMatchObject({ error: "ambiguous_tool" });
    await expect(executeCall(state, "demo_a_b_c", {})).resolves.toMatchObject({ details: { error: "ambiguous_tool" } });
    await expect(executeCall(state, "demo_a_b_c", {}, "demo")).resolves.toMatchObject({ details: { error: "ambiguous_tool" } });
    expect(callTool).not.toHaveBeenCalled();
    expect(executeDescribe(state, "demo_a-b_c").details).toMatchObject({ server: "demo", tool: { originalName: "a-b_c" } });
    expect(executeDescribe(state, "demo_a_b-c").details).toMatchObject({ server: "demo", tool: { originalName: "a_b-c" } });
    await expect(executeCall(state, "demo_a-b_c", {}, "demo")).resolves.toMatchObject({ details: { server: "demo", tool: "a-b_c" } });
    expect(callTool).toHaveBeenCalledTimes(1);
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
