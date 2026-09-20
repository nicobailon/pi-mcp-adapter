import { describe, expect, it, vi } from "vitest";
import { executeCall, executeDescribe, executeList, executeSearch, executeStatus } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import type { ServerEntry } from "../types.ts";

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
    state.config.mcpServers.demo!.searchKeywords = { find: ["zzalias finder", "天气预报"] };

    expect(executeSearch(createState(), "zzalias").details).toMatchObject({ count: 0 });
    expect(executeSearch(state, "zzalias").details).toMatchObject({
      count: 1,
      matches: [{ server: "demo", tool: "demo_find", score: expect.any(Number) }],
    });
    expect(executeSearch(state, "天气预报").details).toMatchObject({ count: 1, matches: [{ tool: "demo_find" }] });
  });

  it("matches useful CJK sentence terms while rejecting unrelated text", () => {
    const state = createState();
    state.toolMetadata.set("demo", [{
      name: "demo_calendar",
      originalName: "calendar",
      description: "创建和管理日历事件",
    }]);

    expect(executeSearch(state, "创建日历事件").details).toMatchObject({ count: 1, matches: [{ tool: "demo_calendar" }] });
    expect(executeSearch(state, "查询天气预报").details).toMatchObject({ count: 0, matches: [] });
  });

  it("matches adjacent CJK and ASCII terms without separators", () => {
    const state = createState();
    state.toolMetadata.set("demo", [
      {
        name: "demo_bilingual_calendar",
        originalName: "bilingual_calendar",
        description: "Manage calendar and 日历事件",
      },
      {
        name: "demo_ascii_calendar",
        originalName: "ascii_calendar",
        description: "Manage calendar records",
      },
    ]);

    expect(executeSearch(state, "calendar日历").details)
      .toMatchObject({ count: 1, matches: [{ tool: "demo_bilingual_calendar" }] });
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
    const list = executeList(state, "demo");
    expect(list.details).toMatchObject({ mode: "list", count: 2 });
    expect(list.content[0].text).toContain(
      'demo (2 tools (needs auth — run mcp({ action: "auth-start", server: "demo" }))):',
    );
    expect(executeStatus(state).details).toMatchObject({
      totalTools: 2,
      servers: [expect.objectContaining({ name: "demo", status: "needs-auth", toolCount: 2 })],
    });
  });

  it("explains when a lazy server's tools come from cache", () => {
    const result = executeList(createState(), "demo");

    expect(result.content[0].text).toContain(
      'demo (2 tools (lazy: tools from cache, not connected yet — mcp({ connect: "demo" }) to connect)):',
    );
  });

  describe.each(["global", "server"] as const)("%s toolPrefix discovery", scope => {
    it.each([
      ["server", "demo-mcp_search"],
      ["short", "demo_search"],
      ["none", "search"],
      ["mcp", "mcp__demo-mcp_search"],
    ] as const)("describes the exact search result with %s prefixes", (prefix, expectedName) => {
      const state = createState();
      const server = "demo-mcp";
      const definition: ServerEntry = { command: "demo" };
      const globalPrefix = scope === "global" ? prefix : "none";
      if (scope === "server") definition.toolPrefix = prefix;
      state.config = {
        mcpServers: { [server]: definition },
        settings: { toolPrefix: globalPrefix },
      };
      const inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
      const { metadata } = buildToolMetadata(
        [{ name: "search", description: "Search demo records", inputSchema }],
        [],
        definition,
        server,
        globalPrefix,
      );
      state.toolMetadata = new Map([[server, metadata]]);

      const search = executeSearch(state, "search", false, server);
      expect(search.details).toMatchObject({ count: 1, matches: [{ tool: expectedName }] });
      const matches = search.details.matches as Array<{ tool: string }>;
      const result = executeDescribe(state, matches[0]!.tool);

      expect(result.details).toMatchObject({
        mode: "describe",
        server,
        tool: { name: expectedName, originalName: "search", inputSchema },
      });
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

  it("resolves displayed and raw upstream names for an explicitly selected server", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "called" }] }));
    const state = {
      config: { mcpServers: { codegraph: { command: "codegraph" } } },
      toolMetadata: new Map([["codegraph", [
        { name: "codegraph_codegraph_explore", originalName: "codegraph_explore", description: "Explore code" },
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

    expect(executeDescribe(state, "codegraph_codegraph_explore", "codegraph").details).toMatchObject({
      server: "codegraph",
      tool: { originalName: "codegraph_explore" },
    });
    expect(executeDescribe(state, "codegraph_explore", "codegraph").details).toMatchObject({
      server: "codegraph",
      tool: { originalName: "codegraph_explore" },
    });

    const result = await executeCall(state, "codegraph_explore", { query: "identity provider" }, "codegraph");

    expect(result.details).toMatchObject({
      server: "codegraph",
      tool: "codegraph_explore",
      canonicalTool: "codegraph_codegraph_explore",
    });
    expect(result.details).not.toMatchObject({ error: "tool_not_found" });
    expect(callTool).toHaveBeenCalledWith(
      { name: "codegraph_explore", arguments: { query: "identity provider" }, _meta: undefined },
      undefined,
    );
  });

  it("gives an exact canonical name precedence over a same-server alias", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "called" }] }));
    const state = {
      config: { mcpServers: { demo: { command: "demo" } } },
      toolMetadata: new Map([["demo", [
        { name: "demo_search", originalName: "search", description: "Displayed match" },
        { name: "demo_demo_search", originalName: "demo_search", description: "Raw match" },
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

    expect(executeDescribe(state, "demo_search", "demo").details).toMatchObject({
      server: "demo",
      tool: { originalName: "search" },
    });
    await expect(executeCall(state, "demo_search", {}, "demo")).resolves.toMatchObject({
      details: { server: "demo", tool: "search", canonicalTool: "demo_search" },
    });
    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: {}, _meta: undefined },
      undefined,
    );

    expect(executeDescribe(state, "demo_search").details).toMatchObject({
      server: "demo",
      tool: { originalName: "search" },
    });
  });

  it("fails closed when a bare candidate alias is globally ambiguous", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "called" }] }));
    const state = {
      config: { mcpServers: { first: { command: "first" }, second: { command: "second" } } },
      toolMetadata: new Map([
        ["first", [{ name: "first_search", originalName: "search", description: "First" }]],
        ["second", [{ name: "second_search", originalName: "search", description: "Second" }]],
      ]),
      manager: { getConnection: () => ({ status: "connected", client: { callTool } }) },
      failureTracker: new Map(),
    } as unknown as McpExtensionState;

    await expect(executeCall(state, "search", {})).resolves.toMatchObject({
      details: { error: "ambiguous_tool", requestedTool: "search" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("gives a global exact canonical name precedence over another server's alias", async () => {
    const exactCall = vi.fn(async () => ({ content: [{ type: "text", text: "exact" }] }));
    const aliasCall = vi.fn();
    const state = {
      config: { mcpServers: { demo: { command: "demo" }, other: { command: "other" } } },
      toolMetadata: new Map([
        ["demo", [{ name: "demo_search", originalName: "search", description: "Exact" }]],
        ["other", [{ name: "other_demo_search", originalName: "demo_search", description: "Alias" }]],
      ]),
      manager: {
        getConnection: (server: string) => ({
          status: "connected",
          client: { callTool: server === "demo" ? exactCall : aliasCall },
        }),
        getRequestOptions: () => undefined,
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as unknown as McpExtensionState;

    await expect(executeCall(state, "demo_search", {})).resolves.toMatchObject({
      details: { server: "demo", tool: "search", canonicalTool: "demo_search" },
    });
    expect(exactCall).toHaveBeenCalledOnce();
    expect(aliasCall).not.toHaveBeenCalled();
  });

  it("gives a global exact upstream name precedence over another server's prefix", async () => {
    const exactCall = vi.fn(async () => ({ content: [{ type: "text", text: "exact" }] }));
    const state = {
      config: { mcpServers: { foo: { command: "foo" }, other: { command: "other" } } },
      toolMetadata: new Map([
        ["foo", [{ name: "foo_unrelated", originalName: "unrelated", description: "Unrelated" }]],
        ["other", [{ name: "other_foo_bar", originalName: "foo_bar", description: "Exact" }]],
      ]),
      manager: {
        getConnection: () => ({ status: "connected", client: { callTool: exactCall } }),
        getRequestOptions: () => undefined,
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as unknown as McpExtensionState;

    await expect(executeCall(state, "foo_bar", {})).resolves.toMatchObject({
      details: { server: "other", tool: "foo_bar", canonicalTool: "other_foo_bar" },
    });
    expect(executeDescribe(state, "foo_bar").details).toMatchObject({
      server: "other",
      tool: { originalName: "foo_bar" },
    });
    expect(exactCall).toHaveBeenCalledWith({ name: "foo_bar", arguments: {}, _meta: undefined }, undefined);
  });

  it("ignores lower-tier and unavailable ambiguities when describing an exact upstream owner", () => {
    const exact = { name: "other_foo__bar", originalName: "foo__bar", description: "Exact" };
    const collisions = [
      { name: "foo--bar", originalName: "first", description: "First" },
      { name: "foo-_bar", originalName: "second", description: "Second" },
    ];
    const state = {
      config: {
        mcpServers: {
          other: { command: "other" },
          lower: { command: "lower" },
          disabled: { command: "disabled", enabled: false },
          failed: { command: "failed" },
        },
      },
      toolMetadata: new Map([
        ["other", [exact]],
        ["lower", collisions],
        ["disabled", collisions],
        ["failed", collisions],
      ]),
      manager: { getConnection: () => undefined },
      failureTracker: new Map([["failed", Date.now()]]),
    } as unknown as McpExtensionState;

    expect(executeDescribe(state, "foo__bar").details).toMatchObject({
      server: "other",
      tool: { originalName: "foo__bar" },
    });
  });

  it("fails closed for same-server normalized displayed and raw-name collisions", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "called" }] }));
    const state = {
      config: { mcpServers: { demo: { command: "demo" } } },
      toolMetadata: new Map([["demo", [
        { name: "demo_search-item", originalName: "search-item", description: "Displayed match" },
        { name: "demo_other", originalName: "demo-search_item", description: "Raw match" },
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

    expect(executeDescribe(state, "demo_search_item", "demo").details).toMatchObject({
      error: "ambiguous_tool",
      server: "demo",
    });
    await expect(executeCall(state, "demo_search_item", {}, "demo")).resolves.toMatchObject({
      details: { error: "ambiguous_tool", server: "demo" },
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("fails closed for same-server normalized original-name collisions", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "called" }] }));
    const state = {
      config: { mcpServers: { demo: { command: "demo" } } },
      toolMetadata: new Map([["demo", [
        { name: "demo_first", originalName: "search--one", description: "First" },
        { name: "demo_second", originalName: "search-_one", description: "Second" },
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

    const describeResult = executeDescribe(state, "search__one", "demo");
    expect(describeResult.details).toMatchObject({ error: "ambiguous_tool", server: "demo" });
    expect(describeResult.content[0].text).toContain('matches multiple tools on server "demo"');
    expect(describeResult.content[0].text).toContain('mcp({ server: "demo" })');

    const callResult = await executeCall(state, "search__one", {}, "demo");
    expect(callResult.details).toMatchObject({ error: "ambiguous_tool", server: "demo" });
    expect(callResult.content[0].text).toContain('matches multiple tools on server "demo"');
    expect(callTool).not.toHaveBeenCalled();
  });

  it("reports server-scoped describe errors without searching other servers", () => {
    const state = createState();

    expect(executeDescribe(state, "search", "missing").details).toMatchObject({
      error: "server_not_found",
      server: "missing",
      requestedTool: "search",
    });
    const missingTool = executeDescribe(state, "missing", "demo");
    expect(missingTool.details).toMatchObject({
      error: "tool_not_found",
      server: "demo",
      requestedTool: "missing",
    });
    expect(missingTool.content[0].text).toContain('Tool "missing" not found on server "demo"');
    expect(missingTool.content[0].text).toContain('mcp({ search: "...", server: "demo" })');
  });

  it("keeps server-scoped describe suggestions on the selected server", () => {
    const state = createState();
    state.config.mcpServers.other = { command: "other" };
    state.toolMetadata.set("other", [{
      name: "other_search",
      originalName: "search",
      description: "Search other records",
    }]);

    expect(executeDescribe(state, "demo_sear", "demo").details).toMatchObject({
      error: "tool_not_found",
      suggestions: ["demo_search"],
    });
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
