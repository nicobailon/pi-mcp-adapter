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
        ],
      ],
    ]),
    manager: {
      getConnection: () => undefined,
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

    expect(result.details).toMatchObject({ count: 1, query: "^demo_[a-z]+$" });
  });

  it("loads canonical direct names and states the one-name Code Mode rule once", () => {
    const activated: string[][] = [];
    const state = createState();
    state.toolMetadata.set("demo", [{
      name: "mcp__demo__search",
      originalName: "search",
      description: "Search demo records",
      inputSchema: { type: "object", properties: {} },
    }]);

    const result = executeSearch(state, "search", false, undefined, false, 5, {
      codeModeTool: "code_mode_exec",
      activate(names) {
        activated.push(names);
        return { added: names, active: names };
      },
    });

    expect(activated).toEqual([["mcp__demo__search"]]);
    expect(result.content[0].text).toContain("mcp__demo__search [activated]");
    expect(result.content[0].text).toContain("tools.<name>(args)");
    expect(result.content[0].text.match(/mcp__demo__search/g)).toHaveLength(1);
    expect(result.details).toMatchObject({
      added: ["mcp__demo__search"],
      active: ["mcp__demo__search"],
      displayed: 1,
    });
  });

  it("uses shared recall-oriented ranking before applying the activation cap", () => {
    const state = createState();
    state.toolMetadata.set("demo", [
      {
        name: "mcp__demo__list_issue_statuses",
        originalName: "list_issue_statuses",
        description: "List configured workflow statuses for issues",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "mcp__demo__save_issue",
        originalName: "save_issue",
        description: "Create or update an issue including its status and project",
        inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } },
      },
    ]);
    const activated: string[][] = [];

    const result = executeSearch(state, "update issue status", false, undefined, false, 1, {
      codeModeTool: "code_mode_exec",
      activate(names) {
        activated.push(names);
        return { added: names, active: names };
      },
    });

    expect(activated).toEqual([["mcp__demo__save_issue"]]);
    expect(result.details).toMatchObject({ count: 2, displayed: 1 });
    expect(result.content[0].text).toContain('Found 2 tools matching "update issue status" (showing 1)');
  });

  it("omits the already-active Code Mode control tool from capability search", () => {
    const state = createState();
    state.toolMetadata.set("demo", [
      {
        name: "mcp__demo__search",
        originalName: "search",
        description: "Search demo records",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "code_mode_exec",
        originalName: "exec",
        description: "Search and compose tools",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const result = executeSearch(state, "search", false, undefined, false, 5, {
      codeModeTool: "code_mode_exec",
      activate(names) {
        return { added: names, active: names };
      },
    });

    expect(result.details).toMatchObject({
      count: 1,
      matches: [{ server: "demo", tool: "mcp__demo__search", originalName: "search" }],
    });
    expect(result.content[0].text).not.toContain("code_mode_exec [activated]");
  });

  it("accepts unambiguous legacy string aliases without exposing duplicate schemas", () => {
    const state = createState();
    state.config.settings = { toolPrefix: "server" };
    state.toolMetadata.set("demo", [{
      name: "mcp__demo__search",
      originalName: "search",
      description: "Search demo records",
      inputSchema: { type: "object", properties: {} },
    }]);
    const activated: string[][] = [];

    const result = executeDescribe(state, "demo_search", {
      activate(names) {
        activated.push(names);
        return { added: names, active: names };
      },
    });

    expect(activated).toEqual([["mcp__demo__search"]]);
    expect(result.details).toMatchObject({ tool: { name: "mcp__demo__search" } });
  });

  it("rejects ambiguous raw aliases", () => {
    const state = createState();
    state.config.mcpServers.other = { command: "npx", args: ["other"] };
    state.toolMetadata.set("other", [{
      name: "mcp__other__search",
      originalName: "search",
      description: "Search other records",
      inputSchema: { type: "object", properties: {} },
    }]);

    const result = executeDescribe(state, "search");
    expect(result.details).toMatchObject({ error: "tool_not_found", requestedTool: "search" });
  });

  it("keeps non-regex searches unaffected by the regex length cap", () => {
    const result = executeSearch(createState(), "search terms ".repeat(40), false);

    expect(result.details).not.toMatchObject({ error: "query_too_long" });
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
