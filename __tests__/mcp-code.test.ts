import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createMcpAdapter } from "../index.ts";
import { runMcpScript } from "../mcp-code.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp-code-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
let manager: McpServerManager;
let state: McpExtensionState;

function textBlocks(result: Awaited<ReturnType<typeof runMcpScript>>): string[] {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text);
}

describe("runMcpScript", () => {
  it("registers mcp_script by default", () => {
    const registerTool = vi.fn();
    createMcpAdapter({ config: { settings: {}, mcpServers: {} } })({
      registerTool,
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      getAllTools: vi.fn(() => []),
    } as any);

    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "mcp_script",
      description: expect.stringContaining("multiple MCP tool calls in one request"),
      promptSnippet: "Batch multiple MCP tool calls in one JavaScript request (loop, filter, chain)",
    }));
  });

  it("skips mcp_script when scriptMode is false", () => {
    const registerTool = vi.fn();
    createMcpAdapter({ config: { settings: { scriptMode: false }, mcpServers: {} } })({
      registerTool,
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      getAllTools: vi.fn(() => []),
    } as any);

    expect(registerTool).toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp_script" }));
  });

  beforeAll(async () => {
    manager = new McpServerManager();
    await manager.connect("fixture", definition);
    state = {
      config: { settings: {}, mcpServers: { fixture: definition } },
      toolMetadata: new Map([
        ["fixture", [
          { name: "fixture_echo", originalName: "echo", description: "Echo a value" },
          { name: "fixture_fail", originalName: "fail", description: "Return an MCP tool error" },
          { name: "fixture_hang", originalName: "hang", description: "Never resolves" },
        ]],
      ]),
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    } as unknown as McpExtensionState;
  });

  afterAll(async () => {
    await manager.closeAll();
  });

  it("uses script-local discovery guidance when a tool call misses", async () => {
    const result = await runMcpScript(state, 'return await tools.call("missing_tool", {});');
    const payload = JSON.parse(textBlocks(result).at(-1)!);

    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "tool_not_found",
        message: expect.stringContaining('Use await tools.search({ query: "..." }) inside mcp_script.'),
      },
    });
    expect(payload.error.message).not.toContain("mcp({ search:");
  });

  it("searches the script-visible tool catalog with pagination and server filtering", async () => {
    const result = await runMcpScript(
      state,
      'return { first: await tools.search({ query: "fixture", limit: 1 }), second: await tools.search({ query: "fixture", limit: 1, offset: 1, server: "fixture" }), empty: await tools.search({ query: "" }) };',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toEqual({
      first: {
        items: [{ path: "fixture_echo", name: "echo", server: "fixture", description: "Echo a value", score: expect.any(Number) }],
        total: 3,
        hasMore: true,
        nextOffset: 1,
      },
      second: {
        items: [{ path: "fixture_fail", name: "fail", server: "fixture", description: "Return an MCP tool error", score: expect.any(Number) }],
        total: 3,
        hasMore: true,
        nextOffset: 2,
      },
      empty: { items: [], total: 0, hasMore: false, nextOffset: null },
    });
  });

  it("describes exact script-visible paths and suggests corrections without throwing", async () => {
    const result = await runMcpScript(
      state,
      'return { found: await tools.describe({ path: "fixture_echo" }), missing: await tools.describe({ path: "fixture_ech" }) };',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toEqual({
      found: {
        path: "fixture_echo",
        name: "echo",
        server: "fixture",
        description: "Echo a value",
      },
      missing: {
        path: "fixture_ech",
        error: {
          code: "tool_not_found",
          message: "Tool not found: fixture_ech",
          suggestions: ["fixture_echo"],
        },
      },
    });
  });

  it("calls exact paths and returns an invalid-path envelope without throwing", async () => {
    const result = await runMcpScript(
      state,
      'return { success: await tools.call("fixture_echo", { value: "canonical" }), invalid: await tools.call("", {}) };',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toMatchObject({
      success: {
        ok: true,
        data: { structuredContent: { echoed: "canonical" } },
      },
      invalid: {
        ok: false,
        error: {
          code: "invalid_tool_path",
          message: "tools.call(path, args) requires a non-empty tool path.",
        },
      },
    });
    expect(result.details).toMatchObject({ calls: [{ path: "fixture_echo", ok: true }] });
  });

  it("records approval-gate outcomes in the call trace", async () => {
    const gatedState = {
      ...state,
      config: { settings: { approveTools: ["echo"] }, mcpServers: { fixture: definition } },
      approvedToolCalls: new Map(),
    } as unknown as McpExtensionState;

    const result = await runMcpScript(
      gatedState,
      'return await tools.fixture_echo({ value: "blocked" });',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toMatchObject({
      ok: false,
      error: { code: "approval_required" },
    });
    expect(result.details).toMatchObject({
      calls: [{ path: "fixture_echo", ok: false, error: "approval_required" }],
    });
  });

  it("calls a prefixed MCP tool through the flat tools proxy", async () => {
    const result = await runMcpScript(
      state,
      'return await tools.fixture_echo({ value: "round trip" });',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toMatchObject({
      ok: true,
      data: {
        content: [{ type: "text", text: "round trip" }],
        structuredContent: { echoed: "round trip" },
      },
    });
  });

  it("returns a failure envelope and lets the script continue", async () => {
    const result = await runMcpScript(
      state,
      "const failure = await tools.fixture_fail({}); return { failure, continued: true };",
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toMatchObject({
      continued: true,
      failure: {
        ok: false,
        error: { code: "tool_error", message: expect.stringContaining("fixture failure") },
      },
    });
    expect(result.details).toMatchObject({
      calls: [{ path: "fixture_fail", ok: false, error: "tool_error" }],
    });
    expect(result.details).not.toHaveProperty("error");
  });

  it("does not treat promise/serialization probes as tool calls", async () => {
    const result = await runMcpScript(state, "return tools;");

    expect(result.details).not.toHaveProperty("error");
    expect(result.details).not.toHaveProperty("calls");
  });

  it("keeps in-flight calls in the trace when the script times out", async () => {
    const result = await runMcpScript(
      state,
      'await tools.fixture_echo({ value: "done" }); await tools.fixture_hang({});',
      300,
    );

    expect(result.details).toMatchObject({
      error: "timeout",
      calls: [
        { path: "fixture_echo", ok: true },
        { path: "fixture_hang", ok: false, error: "incomplete" },
      ],
    });
  });

  it("returns promptly on early return and marks un-awaited calls incomplete", async () => {
    const start = Date.now();
    const result = await runMcpScript(
      state,
      'tools.fixture_hang({}); return "early";',
      5_000,
    );

    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result.details).not.toHaveProperty("error");
    expect(result.details).toMatchObject({
      calls: [{ path: "fixture_hang", ok: false, error: "incomplete" }],
    });
  });

  it("terminates synchronous runaway code after an awaited tool call", async () => {
    const result = await runMcpScript(
      state,
      'await tools.fixture_echo({ value: "x" }); while (true) {}',
      300,
    );

    expect(result.details).toMatchObject({
      error: "timeout",
      calls: [{ path: "fixture_echo", ok: true }],
    });
  });

  it("bounds synchronous runaway code and preserves partial emits", async () => {
    // Margin covers worker spawn latency on slow CI runners; the emit must land before the deadline.
    const result = await runMcpScript(state, 'emit("before timeout"); while (true) {}', 250);

    expect(textBlocks(result)[0]).toBe("before timeout");
    expect(result.details).toMatchObject({ error: "timeout", timeoutMs: 250 });
    expect(textBlocks(result).at(-1)).toBe("mcp_script timed out after 250ms");
  });

  it("orders emitted and captured console blocks before the return value", async () => {
    const result = await runMcpScript(
      state,
      'emit("first"); console.log("second"); return "last";',
    );

    expect(textBlocks(result)).toEqual(["first", "[console.log] second", "last"]);
  });

  it("rejects tools enumeration with discovery guidance without exposing host globals", async () => {
    const result = await runMcpScript(
      state,
      `let message;
      try { Object.keys(tools); } catch (error) { message = error.message; }
      return { message, globals: [typeof require, typeof fetch, typeof process] };`,
    );

    expect(JSON.parse(textBlocks(result)[0])).toEqual({
      message: "tools is not enumerable — use tools.search({ query })",
      globals: ["undefined", "undefined", "undefined"],
    });
  });
});
