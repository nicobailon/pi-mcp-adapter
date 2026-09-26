import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createMcpDirectToolCallRenderer,
  createMcpScriptToolCallRenderer,
  resolveMcpToolRenderOptions,
  formatMcpDirectToolCallLines,
  formatMcpScriptToolCallLines,
  formatMcpProxyToolCallLines,
  formatMcpScriptCallSummary,
  formatMcpToolResultIdentity,
  formatMcpToolResultLines,
  renderMcpProxyToolCall,
  renderMcpToolResult,
} from "../tool-result-renderer.ts";

type TestDetails = Record<string, unknown> & { error?: unknown };
type TestResult = AgentToolResult<TestDetails>;

const collapsedOptions: ToolRenderResultOptions = { expanded: false, isPartial: false };
const plainTheme = { fg: (_name: string, text: string) => text };

function result(content: TestResult["content"], details: TestDetails = {}): TestResult {
  return { content, details };
}

describe("MCP tool call renderer", () => {
  it("shows proxy tool calls with parsed JSON arguments", () => {
    const display = formatMcpProxyToolCallLines({
      tool: "cf-portal_list_worker_tail_events",
      server: "cf-portal",
      args: JSON.stringify({ accountId: "abc", scriptName: "worker" }),
    });

    expect(display).toEqual([
      "mcp call cf-portal_list_worker_tail_events @ cf-portal",
      '{\n  "accountId": "abc",\n  "scriptName": "worker"\n}',
    ]);
  });

  it("shows proxy tool calls with native object arguments", () => {
    const display = formatMcpProxyToolCallLines({
      tool: "cf-portal_list_worker_tail_events",
      args: { accountId: "abc", limit: 10 },
    });

    expect(display).toEqual([
      "mcp call cf-portal_list_worker_tail_events",
      '{\n  "accountId": "abc",\n  "limit": 10\n}',
    ]);
  });

  it("shows proxy discovery operations", () => {
    expect(formatMcpProxyToolCallLines({ search: "tail events", server: "cf-portal", regex: true })).toEqual([
      "mcp search tail events @ cf-portal (regex)",
    ]);
    expect(formatMcpProxyToolCallLines({ describe: "list_worker_tail_events", server: "cf-portal" })).toEqual([
      "mcp describe list_worker_tail_events @ cf-portal",
    ]);
    expect(formatMcpProxyToolCallLines({ connect: "cf-portal" })).toEqual(["mcp connect cf-portal"]);
    expect(formatMcpProxyToolCallLines({ server: "cf-portal" })).toEqual(["mcp list cf-portal"]);
    expect(formatMcpProxyToolCallLines({})).toEqual(["mcp status"]);
  });

  it("renders ui-messages with execution precedence", () => {
    expect(formatMcpProxyToolCallLines({ action: "ui-messages", server: "cf-portal" })).toEqual(["mcp ui-messages"]);
  });

  it("shows direct tool calls with JSON arguments", () => {
    const display = formatMcpDirectToolCallLines("cf-portal_list_worker_tail_events", {
      accountId: "abc",
      scriptName: "worker",
    });

    expect(display).toEqual([
      "cf-portal_list_worker_tail_events",
      '{\n  "accountId": "abc",\n  "scriptName": "worker"\n}',
    ]);
  });

  it("omits empty direct tool arguments", () => {
    expect(formatMcpDirectToolCallLines("cf-portal_status", {})).toEqual(["cf-portal_status"]);
  });

  it("shows bounded mcpScript code", () => {
    const display = formatMcpScriptToolCallLines({
      code: `await tools.search({ query: "${"x".repeat(1_600)}" });`,
    });

    expect(display[0]).toBe("mcpScript");
    expect(display[1]).toHaveLength(1_500);
    expect(display[1]?.endsWith("…")).toBe(true);
  });
});

describe("MCP tool result renderer", () => {
  it("shows the first three lines and an ellipsis for collapsed long text", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "one\ntwo\nthree\nfour" },
    ]), false);

    expect(display).toEqual({
      lines: ["one", "two", "three", "…"],
      truncated: true,
    });
  });

  it("does not add an ellipsis when collapsed text is three lines or fewer", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "one\ntwo\nthree" },
    ]), false);

    expect(display).toEqual({
      lines: ["one", "two", "three"],
      truncated: false,
    });
  });

  it("shows full text when expanded", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "one\ntwo\nthree\nfour" },
    ]), true);

    expect(display).toEqual({
      lines: ["one", "two", "three", "four"],
      truncated: false,
    });
  });

  it("uses placeholders for images", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "before" },
      { type: "image", mimeType: "image/png", data: "abc" },
    ]), true);

    expect(display.lines).toEqual(["before", "[image: image/png]"]);
  });

  it("uses an empty-result placeholder when content is empty", () => {
    const display = formatMcpToolResultLines(result([]), false);

    expect(display).toEqual({ lines: ["(empty result)"], truncated: false });
  });

  it("keeps error text visible", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "Error: upstream failed\nExpected parameters:\n{}" },
    ]), false);

    expect(display.lines).toEqual(["Error: upstream failed", "Expected parameters:", "{}"]);
    expect(display.truncated).toBe(false);
  });

  it("formats proxy call result identity from details", () => {
    expect(formatMcpToolResultIdentity({ mode: "call", server: "figma", tool: "get_nodes" })).toBe("MCP figma/get_nodes");
    expect(formatMcpToolResultIdentity({ mode: "call", server: "files", resourceUri: "file://demo" })).toBe("MCP files resource file://demo");
    expect(formatMcpToolResultIdentity({ mode: "call", server: "figma", requestedTool: "figma_get_nodes" })).toBe("MCP figma/figma_get_nodes");
    expect(formatMcpToolResultIdentity({ mode: "call", hintServer: "figma", requestedTool: "figma_get_nodes" })).toBe("MCP figma/figma_get_nodes");
    expect(formatMcpToolResultIdentity({ mode: "list", server: "figma", tool: "get_nodes" })).toBeNull();
  });

  it("renders collapsed results as a compact single line by default", () => {
    const output = renderMcpToolResult(
      result([{
        type: "text",
        text: "segment-1 segment-2 segment-3 segment-4 segment-5 segment-6 segment-7 segment-8",
      }]),
      collapsedOptions,
      plainTheme,
      { isError: false },
    ).render(20).join("\n");

    expect(output).toContain("segment-1");
    expect(output).toContain("Ctrl+O");
    expect(output).toContain("…");
    expect(output).not.toContain("segment-8");
  });

  it("keeps a bounded input preview in compact final rows", () => {
    const state: { compactTitle?: string; compactInputPreview?: string } = {};
    const call = createMcpDirectToolCallRenderer("demo_search")(
      { query: "alpha", limit: 10 },
      plainTheme,
      { isError: false, isPartial: false, expanded: false, state },
    );
    const output = renderMcpToolResult(
      result([{ type: "text", text: "found 10 results" }]),
      collapsedOptions,
      plainTheme,
      { isError: false, state },
    ).render(120).join("\n");

    expect(call.render(120)).toEqual([]);
    expect(output).toContain("demo_search");
    expect(output).toContain("query");
    expect(output).toContain("alpha");
    expect(output).toContain("found 10 results");
  });

  it("does not copy mcpScript code into compact final rows", () => {
    const state: { compactTitle?: string; compactInputPreview?: string } = {};
    const code = 'emit("secret-script-code");';
    const call = createMcpScriptToolCallRenderer()(
      { code },
      plainTheme,
      { isError: false, isPartial: false, expanded: false, state },
    );
    const output = renderMcpToolResult(
      result([{ type: "text", text: "done" }]),
      collapsedOptions,
      plainTheme,
      { isError: false, state },
    ).render(120).join("\n");

    expect(call.render(120)).toEqual([]);
    expect(state.compactInputPreview).toBeUndefined();
    expect(output).not.toContain(code);
  });

  it("titles compact mcpScript rows with the tools the script called", () => {
    const state: { compactTitle?: string; compactInputPreview?: string } = {};
    const code = 'await tools.call("demo_" + name, {}); emit("secret-script-code");';
    const call = createMcpScriptToolCallRenderer()(
      { code },
      plainTheme,
      { isError: false, isPartial: false, expanded: false, state },
    );
    const output = renderMcpToolResult(
      result([{ type: "text", text: "done\nextra" }], {
        mode: "script",
        calls: [
          { operation: "describe", path: "demo_search", ok: true, durationMs: 1 },
          { operation: "call", path: "demo_search", ok: true, durationMs: 2 },
          { operation: "call", path: "demo_search", ok: true, durationMs: 2 },
          { operation: "call", path: "demo_fetch", ok: true, durationMs: 3 },
        ],
      }),
      collapsedOptions,
      plainTheme,
      { isError: false, state },
    ).render(120).join("\n");

    expect(call.render(120)).toEqual([]);
    expect(output).toContain("mcpScript demo_search×2, demo_fetch · describe → done");
    expect(output).not.toContain("secret-script-code");
    expect(output).not.toContain("extra");
  });

  it("titles compact mcpScript rows even without call renderer state", () => {
    const output = renderMcpToolResult(
      result([{ type: "text", text: "(no output)" }], { mode: "script", timeoutMs: 30_000 }),
      collapsedOptions,
      plainTheme,
      { isError: false },
    ).render(80).join("\n");

    expect(output).toBe("mcpScript → (no output)");
  });

  it("summarizes mcpScript call traces", () => {
    const call = (path: string, ok = true) => (ok
      ? { operation: "call", path, ok, durationMs: 1 }
      : { operation: "call", path, ok, error: "tool_not_found", durationMs: 1 });

    expect(formatMcpScriptCallSummary({ mode: "call", server: "demo", tool: "search" })).toBeNull();
    expect(formatMcpScriptCallSummary(undefined)).toBeNull();
    expect(formatMcpScriptCallSummary({ mode: "script" })).toEqual({ failed: 0, preview: "" });
    expect(formatMcpScriptCallSummary({
      mode: "script",
      calls: [call("a"), call("b"), call("c"), call("d"), call("e"), call("a")],
    })).toEqual({ failed: 0, preview: "a×2, b, c, d, +1 more" });
    expect(formatMcpScriptCallSummary({
      mode: "script",
      calls: [
        call("demo_search"),
        call("demo_missing", false),
        { operation: "search", query: "demo", ok: true, durationMs: 1 },
      ],
    })).toEqual({ failed: 1, preview: "demo_search, demo_missing · search" });
    expect(formatMcpScriptCallSummary({
      mode: "script",
      calls: [
        { operation: "describe", path: "demo_search", ok: true, durationMs: 1 },
        { operation: "describe", path: "demo_fetch", ok: true, durationMs: 1 },
      ],
    })).toEqual({ failed: 0, preview: "describe demo_search, demo_fetch" });
  });

  it("escapes script-supplied tool paths in the mcpScript summary instead of printing them raw", () => {
    const call = (path: string) => ({ operation: "call", path, ok: false, error: "tool_not_found", durationMs: 1 });
    const summary = formatMcpScriptCallSummary({
      mode: "script",
      calls: [
        call("demo_a\nfake second row"),
        call("\u001b]8;;https://example.test\u0007demo_link\u001b]8;;\u0007"),
        call("demo\u009b2J"),
        call("\u001b[2J"),
      ],
    });

    expect(summary).toEqual({
      failed: 4,
      preview: String.raw`"demo_a\nfake second row", "\u001b]8;;https://example.test\u0007demo_link\u001b]8;;\u0007", "demo\u009b2J", "\u001b[2J"`,
    });
    expect(summary?.preview).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);

    const output = renderMcpToolResult(
      result([{ type: "text", text: "{}" }], { mode: "script", calls: [call("demo_a\nfake second row")] }),
      collapsedOptions,
      plainTheme,
      { isError: false },
    ).render(120);

    expect(output).toEqual([String.raw`mcpScript ✗1 "demo_a\nfake second row" → {}`]);
  });

  it("keeps distinct traced paths distinct when one of them needs escaping", () => {
    const call = (path: string, ok = true) => (ok
      ? { operation: "call", path, ok, durationMs: 1 }
      : { operation: "call", path, ok, error: "tool_not_found", durationMs: 1 });

    expect(formatMcpScriptCallSummary({
      mode: "script",
      calls: [call("demo_red"), call("\u001b[31mdemo_red\u001b[0m", false), call("demo_red")],
    })).toEqual({ failed: 1, preview: String.raw`demo_red×2, "\u001b[31mdemo_red\u001b[0m"` });
  });

  it("keeps the failed-call count in the title when a narrow row truncates the mcpScript tool list", () => {
    const output = renderMcpToolResult(
      result([{ type: "text", text: "{}" }], {
        mode: "script",
        calls: [
          { operation: "call", path: "demo_a_really_long_tool_name", ok: true, durationMs: 1 },
          { operation: "call", path: "demo_another_really_long_tool_name", ok: false, error: "call_failed", durationMs: 1 },
        ],
      }),
      collapsedOptions,
      plainTheme,
      { isError: false },
    ).render(60).join("\n");

    expect(output.startsWith("mcpScript ✗1 demo_")).toBe(true);
    expect(output).not.toContain("demo_another_really_long_tool_name");
    expect(output).toContain("→ {}");
  });

  it("keeps the failed-call count visible when a narrow row drops the mcpScript preview", () => {
    const component = renderMcpToolResult(
      result([{ type: "text", text: "{}" }], {
        mode: "script",
        calls: [{ operation: "call", path: "demo_search", ok: false, error: "call_failed", durationMs: 1 }],
      }),
      collapsedOptions,
      plainTheme,
      { isError: false },
    );

    for (const width of [17, 20, 25]) {
      expect(component.render(width)).toEqual(["mcpScript ✗1 → {}"]);
    }
  });

  it("quotes traced paths that could pass for mcpScript summary syntax", () => {
    const call = (path: string) => ({ operation: "call", path, ok: false, error: "tool_not_found", durationMs: 1 });

    expect(formatMcpScriptCallSummary({
      mode: "script",
      calls: [call("foo×2"), call("a, b"), call("x · y"), call("+1 more")],
    })).toEqual({ failed: 4, preview: String.raw`"foo\u00d72", "a, b", "x \u00b7 y", "+1 more"` });
    expect(formatMcpScriptCallSummary({
      mode: "script",
      calls: [call("\u202eevil"), call("zero\u200bwidth")],
    })?.preview).toBe(String.raw`"\u202eevil", "zero\u200bwidth"`);
    expect(formatMcpScriptCallSummary({
      mode: "script",
      calls: [call("github_search-issues"), call("server/tool.v2:read@main")],
    })?.preview).toBe("github_search-issues, server/tool.v2:read@main");
  });

  it("shrinks the title rather than the failed-call count on narrow rows", () => {
    const failed = { operation: "call", path: "demo_search", ok: false, error: "call_failed", durationMs: 1 };
    const component = renderMcpToolResult(
      result([{ type: "text", text: "{}" }], { mode: "script", calls: Array.from({ length: 12 }, () => failed) }),
      collapsedOptions,
      plainTheme,
      { isError: false },
    );

    // truncateToWidth wraps its ellipsis in SGR resets; compare the visible text.
    const visible = (width: number) => component.render(width).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(visible(20)).toEqual(["mcpScri… ✗12 → {}"]);
    expect(component.render(25)).toEqual(["mcpScript ✗12 → {}"]);
    expect(component.render(80)).toEqual(["mcpScript ✗12 demo_search×12 → {}"]);
  });

  it("colors the mcpScript failed-call count as an error", () => {
    const taggedTheme = { fg: (name: string, text: string) => `<${name}>${text}</${name}>` };
    const output = renderMcpToolResult(
      result([{ type: "text", text: "{}" }], {
        mode: "script",
        calls: [{ operation: "call", path: "demo_search", ok: false, error: "call_failed", durationMs: 1 }],
      }),
      collapsedOptions,
      taggedTheme,
      { isError: false },
    ).render(200).join("\n");

    expect(output).toContain("<toolTitle>mcpScript</toolTitle> <error>✗1</error> <muted>demo_search</muted>");
  });

  it("skips leading blank lines in collapsed previews", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: "\n\nuseful\nextra" },
    ]), false, 1);

    expect(display).toEqual({ lines: ["useful", "…"], truncated: true });
  });

  it("bounds skipped leading blank lines", () => {
    const display = formatMcpToolResultLines(result([
      { type: "text", text: `${"\n".repeat(100)}useful` },
    ]), false, 1, 50);

    expect(display).toEqual({ lines: ["(leading blank output omitted)", "…"], truncated: true });
  });

  it("bounds a huge single-line collapsed result and shows the expand hint", () => {
    const huge = `head ${"x".repeat(50_000)} tail-marker`;
    const output = renderMcpToolResult(
      result([{ type: "text", text: huge }]),
      collapsedOptions,
      plainTheme,
      { isError: false },
    ).render(80).join("\n");

    expect(output).toContain("head");
    expect(output).toContain("Ctrl+O to expand");
    expect(output).not.toContain("tail-marker");
  });

  it("reuses truncated collapsed lines at the same width", () => {
    const renderer = renderMcpToolResult(
      result([{ type: "text", text: "one\ntwo\nthree\nfour" }]),
      collapsedOptions,
      plainTheme,
      { isError: false },
    );

    const first = renderer.render(80);
    const second = renderer.render(80);
    expect(second).toBe(first);
    expect(second.join("\n")).toContain("Ctrl+O to expand");
  });

  it("keeps legacy boxed rendering available", () => {
    const output = renderMcpToolResult(
      result([{ type: "text", text: "one\ntwo\nthree\nfour" }], { mode: "call", server: "figma", tool: "get_nodes" }),
      collapsedOptions,
      plainTheme,
      { isError: false },
      { resultRendering: "boxed", collapsedResultLines: 3 },
    ).render(80).join("\n");

    expect(output).toContain("MCP figma/get_nodes");
    expect(output).toContain("one");
    expect(output).toContain("two");
    expect(output).toContain("three");
    expect(output).not.toContain("four");
    expect(output).toContain("Ctrl+O to expand");
  });

  it("combines the compact final result with the call title", () => {
    const state: { compactTitle?: string } = {};
    const call = createMcpDirectToolCallRenderer("demo_search")(
      {},
      plainTheme,
      { isError: false, isPartial: false, expanded: false, state },
    );
    const output = renderMcpToolResult(
      result([{ type: "text", text: "ok\nextra" }]),
      collapsedOptions,
      plainTheme,
      { isError: false, state },
    ).render(80).join("\n");

    expect(call.render(80)).toEqual([]);
    expect(output).toContain("demo_search → ok");
    expect(output).toContain("Ctrl+O to expand");
    expect(output).not.toContain("extra");
  });

  it("resolves compact and boxed rendering settings", () => {
    expect(resolveMcpToolRenderOptions()).toEqual({ resultRendering: "compact", collapsedResultLines: 1 });
    expect(resolveMcpToolRenderOptions({ toolResultRendering: "boxed" })).toEqual({
      resultRendering: "boxed",
      collapsedResultLines: 3,
    });
    expect(resolveMcpToolRenderOptions({ collapsedResultLines: 2 })).toEqual({
      resultRendering: "compact",
      collapsedResultLines: 2,
    });
  });

  it("shows the full wrapped single line when expanded", () => {
    const output = renderMcpToolResult(
      result([{
        type: "text",
        text: "segment-1 segment-2 segment-3 segment-4 segment-5 segment-6 segment-7 segment-8",
      }]),
      { expanded: true, isPartial: false },
      plainTheme,
      { isError: false },
    ).render(20).join("\n");

    expect(output).toContain("segment-8");
    expect(output).not.toContain("Ctrl+O to expand");
  });

  it("renders long error results expanded even when the row is collapsed", () => {
    const output = renderMcpToolResult(
      result([{ type: "text", text: "Error: failed\nline 2\nline 3\nline 4" }]),
      collapsedOptions,
      plainTheme,
      { isError: true },
    ).render(80).join("\n");

    expect(output).toContain("line 4");
    expect(output).not.toContain("Ctrl+O to expand");
    expect(output).not.toContain("…");
  });

  it("does not collapse a long single-line error", () => {
    const output = renderMcpToolResult(
      result([{
        type: "text",
        text: "Error: segment-1 segment-2 segment-3 segment-4 segment-5 segment-6 segment-7 segment-8",
      }]),
      collapsedOptions,
      plainTheme,
      { isError: true },
    ).render(20).join("\n");

    expect(output).toContain("segment-8");
    expect(output).not.toContain("Ctrl+O to expand");
  });

  it("renders adapter error details expanded even when Pi context is not marked as an error", () => {
    const output = renderMcpToolResult(
      result([{ type: "text", text: "Error: failed\nline 2\nline 3\nline 4" }], { error: "tool_error" }),
      collapsedOptions,
      plainTheme,
      { isError: false },
    ).render(80).join("\n");

    expect(output).toContain("line 4");
    expect(output).not.toContain("Ctrl+O to expand");
    expect(output).not.toContain("…");
  });

  it("renders results without a theme", () => {
    const output = renderMcpToolResult(
      result([{ type: "text", text: "hello world" }]),
      collapsedOptions,
    ).render(80).join("\n");

    expect(output).toContain("hello world");
  });

  it("renders partial results without a theme", () => {
    const output = renderMcpToolResult(
      result([]),
      { expanded: false, isPartial: true },
    ).render(80).join("\n");

    expect(output).toContain("Running MCP tool...");
  });
});

describe("MCP tool call renderers without a theme", () => {
  it("renders proxy calls without a theme", () => {
    const output = renderMcpProxyToolCall({ tool: "test_tool", server: "demo" }).render(80).join("\n");
    expect(output).toContain("mcp call test_tool @ demo");
  });

  it("renders direct calls without a theme", () => {
    const output = createMcpDirectToolCallRenderer("test_tool")({ key: "value" }).render(80).join("\n");
    expect(output).toContain("test_tool");
  });

  it("renders mcpScript calls without a theme", () => {
    const output = createMcpScriptToolCallRenderer()(
      { code: 'emit("visible");' },
      undefined,
      { isError: false, expanded: true },
    ).render(80).join("\n");
    expect(output).toContain("mcpScript");
    expect(output).toContain('emit("visible");');
  });
});
