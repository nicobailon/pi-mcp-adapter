import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createMcpAdapter } from "../index.ts";
import { runMcpScript } from "../mcp-code.ts";
import { executeCall } from "../proxy-modes.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/mcp-code-server.mjs", import.meta.url));
const fdRunner = fileURLToPath(new URL("./fixtures/mcp-code-fd-runner.ts", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
let manager: McpServerManager;
let state: McpExtensionState;
let intermediateState: McpExtensionState;

function textBlocks(result: Awaited<ReturnType<typeof runMcpScript>>): string[] {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text);
}

describe("runMcpScript", () => {
  it("registers mcpScript by default", () => {
    const registerTool = vi.fn();
    createMcpAdapter({ config: { settings: {}, mcpServers: {} } })({
      registerTool,
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      events: { on: vi.fn(), emit: vi.fn() },
      getAllTools: vi.fn(() => []),
    } as any);

    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "mcpScript",
      description: expect.stringContaining("multiple MCP tool calls in one request"),
      promptSnippet: "Batch multiple MCP tool calls in one JavaScript request (loop, filter, chain)",
    }));
    expect(registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcp_script" }));
  });

  it("skips mcpScript when scriptMode is false", () => {
    const registerTool = vi.fn();
    createMcpAdapter({ config: { settings: { scriptMode: false }, mcpServers: {} } })({
      registerTool,
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      events: { on: vi.fn(), emit: vi.fn() },
      getAllTools: vi.fn(() => []),
    } as any);

    expect(registerTool).toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "mcpScript" }));
  });

  it.runIf(Number.parseInt(process.versions.node, 10) >= 24)(
    "does not emit unmanaged file descriptor warnings",
    async () => {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", fdRunner],
        {
          env: { ...process.env, NODE_OPTIONS: "--trace-warnings" },
          maxBuffer: 1024 * 1024,
        },
      );

      expect(stdout).toContain("completed 32 mcpScript workers");
      expect(stderr).not.toMatch(/File descriptor \d+ (?:closed but not opened in unmanaged mode|opened in unmanaged mode twice)/);
    },
    30_000,
  );

  beforeAll(async () => {
    manager = new McpServerManager();
    await manager.connect("fixture", definition);
    state = {
      config: { settings: {}, mcpServers: { fixture: definition } },
      toolMetadata: new Map([
        ["fixture", [
          {
            name: "fixture_echo",
            originalName: "echo",
            description: "Echo a value",
            inputSchema: {
              type: "object",
              description: "Root guidance is not field documentation",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
          {
            name: "fixture_fail",
            originalName: "fail",
            description: "Return an MCP tool error",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              additionalProperties: false,
            },
          },
          { name: "fixture_hang", originalName: "hang", description: "Never resolves" },
        ]],
      ]),
      manager,
      failureTracker: new Map(),
      completedUiSessions: [],
    } as unknown as McpExtensionState;
    intermediateState = {
      ...state,
      toolMetadata: new Map([["fixture", [
        ...state.toolMetadata.get("fixture")!,
        { name: "fixture_sized", originalName: "sized" },
        { name: "fixture_read_resource", originalName: "read_resource", resourceUri: "fixture://text" },
        { name: "fixture_read_empty", originalName: "read_empty", resourceUri: "fixture://empty" },
      ]]]),
    };
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
        message: expect.stringContaining('Use await tools.search({ query: "..." }) inside mcpScript.'),
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

  it("keeps inputs without field documentation compact and suggests corrections without throwing", async () => {
    const result = await runMcpScript(
      state,
      'return { supported: await tools.describe({ path: "fixture_echo" }), unsupported: await tools.describe({ path: "fixture_fail" }), missing: await tools.describe({ path: "fixture_ech" }) };',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toEqual({
      supported: {
        path: "fixture_echo",
        name: "echo",
        server: "fixture",
        description: "Echo a value",
        inputTypeScript: "{ value: string; }",
      },
      unsupported: {
        path: "fixture_fail",
        name: "fail",
        server: "fixture",
        description: "Return an MCP tool error",
        inputTypeScript: "{ value?: string; }",
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

  it("preserves documented input guidance and original structured output schemas only in describe", async () => {
    const outputSchema = {
      type: "object" as const,
      properties: { pixels: { type: "number", description: "Rendered width in pixels" } },
      allOf: [{ required: ["pixels"] }],
      additionalProperties: { type: "string" },
    };
    const { metadata } = buildToolMetadata([{
      name: "icon",
      inputSchema: {
        type: "object",
        properties: {
          icon_id: { type: "string", description: "Icon ID in prefix:name format" },
          color: { enum: ["red", "blue"], description: "Color, for example red" },
          options: {
            type: "object",
            properties: { size: { type: "number", description: "Size in pixels" } },
          },
        },
        required: ["icon_id"],
      },
      outputSchema,
    }], [], definition, "fixture", "server");
    const result = await runMcpScript({ ...state, toolMetadata: new Map([["fixture", metadata]]) },
      'return { descriptor: await tools.describe({ path: "fixture_icon" }), search: await tools.search({ query: "icon" }) };');
    const { descriptor, search } = JSON.parse(textBlocks(result).at(-1)!);
    expect(descriptor).toEqual({
      path: "fixture_icon", name: "icon", server: "fixture",
      inputTypeScript: '{ icon_id: string; color?: "red" | "blue"; options?: { size?: number; }; }',
      inputGuidance: '  icon_id (string) *required* - Icon ID in prefix:name format\n  color (enum: "red", "blue") - Color, for example red\n  options (object)\n    size (number) - Size in pixels',
      outputSchemaTarget: "data.structuredContent",
      outputSchema,
    });
    expect(search.items).toEqual([{ path: "fixture_icon", name: "icon", server: "fixture", score: expect.any(Number) }]);
  });

  it("keeps active failed-backoff tools out of script describe results", async () => {
    const backoffState = {
      ...state,
      manager: { getConnection: vi.fn(() => undefined) },
      failureTracker: new Map([["fixture", Date.now()]]),
    } as unknown as McpExtensionState;

    const result = await runMcpScript(
      backoffState,
      'return { search: await tools.search({ query: "fixture" }), describe: await tools.describe({ path: "fixture_echo" }) };',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toEqual({
      search: { items: [], total: 0, hasMore: false, nextOffset: null },
      describe: {
        path: "fixture_echo",
        error: {
          code: "tool_not_found",
          message: "Tool not found: fixture_echo",
          suggestions: [],
        },
      },
    });
  });

  it("records operation metadata and timing for search, describe, and calls", async () => {
    const result = await runMcpScript(
      state,
      'await tools.search({ query: "fixture" }); await tools.describe({ path: "fixture_echo" }); await tools.describe({ path: "fixture_missing" }); return await tools.call("fixture_echo", { value: "traced" });',
    );

    expect(result.details).toMatchObject({
      calls: [
        { operation: "search", query: "fixture", ok: true, durationMs: expect.any(Number) },
        { operation: "describe", path: "fixture_echo", ok: true, durationMs: expect.any(Number) },
        { operation: "describe", path: "fixture_missing", ok: false, error: "tool_not_found", durationMs: expect.any(Number) },
        { operation: "call", path: "fixture_echo", ok: true, durationMs: expect.any(Number) },
      ],
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

  it("lets approval brokers handle internal script calls", async () => {
    const broker = vi.fn((request: McpToolApprovalRequest) => {
      expect(request).toMatchObject({
        serverName: "fixture",
        originalToolName: "echo",
        prefixedToolName: "fixture_echo",
        args: { value: "brokered" },
        origin: "script",
      });
      expect(request.claim(() => "allow_once")).toBe(true);
    });
    const brokeredState = {
      ...state,
      config: { settings: { approveTools: ["echo"] }, mcpServers: { fixture: definition } },
      approvedToolCalls: new Map(),
      approvalEvents: { emit: vi.fn((channel: string, data: unknown) => {
        expect(channel).toBe(MCP_TOOL_APPROVAL_REQUEST_EVENT);
        broker(data as McpToolApprovalRequest);
      }) },
    } as unknown as McpExtensionState;

    const result = await runMcpScript(
      brokeredState,
      'return await tools.fixture_echo({ value: "brokered" });',
    );

    expect(JSON.parse(textBlocks(result).at(-1)!)).toMatchObject({
      ok: true,
      data: { structuredContent: { echoed: "brokered" } },
    });
    expect(broker).toHaveBeenCalledOnce();
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

  it("filters a large intermediate to [7] without exposing raw data or spill metadata", async () => {
    const result = await runMcpScript(intermediateState, `
      const response = await tools.call("fixture_sized", { bytes: 128 * 1024 });
      return response.data.structuredContent.rows.filter(id => id === 7);
    `);
    expect(textBlocks(result)).toHaveLength(1);
    expect(JSON.parse(textBlocks(result)[0])).toEqual([7]);
    expect(result.details).toMatchObject({ calls: [{ path: "fixture_sized", ok: true }] });
    expect(JSON.stringify(result)).not.toMatch(/padding|omitted|fullResultPath|fullOutputPath|outputGuard/);
  });

  it("keeps ordinary calls guarded even with script origin, and guards final script output", async () => {
    const value = "private-tail".padStart(128 * 1024, "x");
    const ordinary = await executeCall(state, "fixture_echo", { value }, undefined, undefined, undefined, "script");
    expect(ordinary.details).toMatchObject({ outputGuard: { truncated: true }, mcpResult: { omitted: true } });
    expect(JSON.stringify(ordinary)).not.toContain("private-tail");
    const result = await runMcpScript(state, `return (await tools.fixture_echo({ value: ${JSON.stringify(value)} })).data.content[0].text;`);
    expect(result.details).toMatchObject({ outputGuard: { truncated: true } });
    expect(JSON.stringify(result)).not.toContain("private-tail");
  });

  it("admits exactly 16 MiB cumulatively across sequential successful results", async () => {
    const result = await runMcpScript(intermediateState, `
      const first = await tools.fixture_sized({ bytes: 8 * 1024 * 1024 });
      const second = await tools.fixture_sized({ bytes: 8 * 1024 * 1024 });
      const excess = await tools.fixture_echo({ value: "over budget" });
      return { admitted: [first.ok, second.ok], excess, continued: true };
    `);
    expect(JSON.parse(textBlocks(result).at(-1)!)).toMatchObject({
      admitted: [true, true], continued: true,
      excess: { ok: false, error: { code: "intermediate_result_too_large", message: expect.any(String) } },
    });
    expect(result.details).toMatchObject({ calls: [
      { ok: true, durationMs: expect.any(Number) },
      { ok: true, durationMs: expect.any(Number) },
      { ok: false, error: "intermediate_result_too_large", durationMs: expect.any(Number) },
    ] });
    expect(result.details).not.toHaveProperty("error");
  });

  it("shares the cumulative budget across parallel calls without depending on admission order", async () => {
    const result = await runMcpScript(intermediateState, `
      const responses = await Promise.all([1, 2, 3].map(() => tools.fixture_sized({ bytes: 6 * 1024 * 1024 })));
      return responses.map(r => r.ok ? "admitted" : r.error.code).sort();
    `);
    expect(JSON.parse(textBlocks(result).at(-1)!)).toEqual(["admitted", "admitted", "intermediate_result_too_large"]);
    expect(result.details).toMatchObject({ calls: expect.arrayContaining([
      expect.objectContaining({ ok: true, durationMs: expect.any(Number) }),
      expect.objectContaining({ ok: false, error: "intermediate_result_too_large", durationMs: expect.any(Number) }),
    ]) });
  });

  it("counts UTF-8 JSON bytes, rejects one byte over, and does not charge rejected bytes", async () => {
    const result = await runMcpScript(intermediateState, `
      await tools.fixture_sized({ bytes: 8 * 1024 * 1024 });
      const rejected = await tools.fixture_sized({ bytes: 8 * 1024 * 1024 + 1, multibyte: true });
      const exact = await tools.fixture_sized({ bytes: 8 * 1024 * 1024, multibyte: true });
      return { rejected, admitted: exact.ok, rows: exact.data?.structuredContent.rows ?? null, error: exact.error ?? null };
    `);
    expect(JSON.parse(textBlocks(result).at(-1)!)).toMatchObject({
      rejected: { ok: false, error: { code: "intermediate_result_too_large" } }, admitted: true, rows: [7], error: null,
    });
    expect(result.details).toMatchObject({ calls: [
      { ok: true }, { ok: false, error: "intermediate_result_too_large" }, { ok: true },
    ] });
    const nextScript = await runMcpScript(intermediateState, 'return (await tools.fixture_echo({ value: "fresh budget" })).ok;');
    expect(textBlocks(nextScript)).toEqual(["true"]);
  });

  it("preserves resource text joining and the empty-resource fallback", async () => {
    const result = await runMcpScript(intermediateState, 'return [await tools.fixture_read_resource({}), await tools.fixture_read_empty({})];');
    expect(JSON.parse(textBlocks(result).at(-1)!)).toEqual([
      { ok: true, data: "first\nsecond" }, { ok: true, data: "(empty resource)" },
    ]);
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
    expect(textBlocks(result).at(-1)).toBe("mcpScript timed out after 250ms");
  });

  it("orders emitted and captured console blocks before the return value", async () => {
    const result = await runMcpScript(
      state,
      'emit("first"); console.log("second"); return "last";',
    );

    expect(textBlocks(result)).toEqual(["first", "[console.log] second", "last"]);
  });

  it("formats non-JSON values in emitted, returned, and console output", async () => {
    const result = await runMcpScript(
      state,
      `const cycle = {}; cycle.self = cycle;
      const value = { map: new Map([["key", 1]]), set: new Set(["value"]), cycle, fn: function named() {}, symbol: Symbol("token"), bigint: 1n };
      emit(value); console.log(new Map([["console", 2]])); return value;`,
    );

    for (const block of [textBlocks(result)[0], textBlocks(result).at(-1)!]) {
      expect(block).toContain("Map(1)");
      expect(block).toContain("Set(1)");
      expect(block).toContain("[Circular");
      expect(block).toContain("[Function: named]");
      expect(block).toContain("Symbol(token)");
      expect(block).toContain("1n");
    }
    expect(textBlocks(result)[1]).toContain("Map(1) { 'console' => 2 }");
  });

  it("does not format shared acyclic references as circular", async () => {
    const result = await runMcpScript(
      state,
      'const shared = { id: "same" }; return { first: shared, second: shared };',
    );

    const block = textBlocks(result).at(-1)!;
    expect(block).not.toContain("Circular");
    expect(JSON.parse(block)).toEqual({ first: { id: "same" }, second: { id: "same" } });
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
