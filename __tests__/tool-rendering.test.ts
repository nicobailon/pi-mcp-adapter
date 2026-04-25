import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMcpResult } from "../tool-rendering.js";

const theme = {
  fg: (_color: string, text: string) => text,
};

/**
 * Verify MCP result rendering without Pi runtime packages so the adapter stays testable outside Pi.
 */
describe("renderMcpResult", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
  });
  /**
   * Collapsed output follows Pi's standard text-tool shape: leading spacer, first lines, hint at bottom.
   */
  it("limits collapsed output using the standard Pi preview shape", () => {
    const result = renderMcpResult(
      {
        content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") }],
        details: {},
      },
      { expanded: false, isPartial: false },
      theme,
      {} as never,
    );

    expect(result.render(80)).toEqual([
      "",
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "... (2 more lines, ctrl+o to expand)",
    ]);
  });

  /**
   * Expanded view shows the full result after the user explicitly expands the tool output.
   */
  it("shows all lines in expanded mode", () => {
    const result = renderMcpResult(
      {
        content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") }],
        details: {},
      },
      { expanded: true, isPartial: false },
      theme,
      {} as never,
    );

    expect(result.render(80)).toEqual([
      "",
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "line 11",
      "line 12",
    ]);
  });

  /**
   * Long preview lines are clipped to the render width because custom components must not exceed it.
   */
  it("clips preview lines to render width", () => {
    const result = renderMcpResult(
      {
        content: [{ type: "text", text: "abcdefghij" }],
        details: {},
      },
      { expanded: false, isPartial: false },
      theme,
      {} as never,
    );

    expect(result.render(4)).toEqual(["", "a..."]);
  });

  /**
   * Tabs are expanded before rendering because raw tabs can corrupt terminal layout inside boxed tool output.
   */
  it("expands tabs before rendering", () => {
    const result = renderMcpResult(
      {
        content: [{ type: "text", text: "\t\"bytes\"" }],
        details: {},
      },
      { expanded: false, isPartial: false },
      theme,
      {} as never,
    );

    expect(result.render(80)).toEqual(["", "   \"bytes\""]);
  });

  /**
   * External MCP text is sanitized before terminal rendering because control sequences can corrupt display state.
   */
  it("removes terminal control sequences from text output", () => {
    const result = renderMcpResult(
      {
        content: [{ type: "text", text: "\u001b[31mred\u001b[0m\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\r\u0007ok" }],
        details: {},
      },
      { expanded: false, isPartial: false },
      theme,
      {} as never,
    );

    expect(result.render(120)).toEqual(["", "redlinkok"]);
  });

  /**
   * Image metadata is sanitized because MIME labels are external MCP input.
   */
  it("sanitizes image MIME metadata before terminal rendering", () => {
    const result = renderMcpResult(
      {
        content: [{ type: "image", data: "abc", mimeType: "text/plain\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007" }],
        details: {},
      },
      { expanded: false, isPartial: false },
      theme,
      {} as never,
    );

    expect(result.render(120)).toEqual(["", "[Image content: image/*, 3B base64 payload omitted]"]);
  });

  /**
   * Image-only results are real MCP output and must not be shown as an empty result.
   */
  it("renders image-only results as metadata without raw payload", () => {
    const payload = "a".repeat(120);
    const result = renderMcpResult(
      {
        content: [{ type: "image", data: payload, mimeType: "image/png" }],
        details: {},
      },
      { expanded: false, isPartial: false },
      theme,
      {} as never,
    );

    expect(result.render(120)).toEqual(["", "[Image content: image/png, 120B base64 payload omitted]"]);
    expect(result.render(120).join("\n")).not.toContain(payload);
  });

  /**
   * Keybinding lookup is cached because render can be called repeatedly for the same tool output.
   */
  it("caches configured keybinding text across repeated renders", async () => {
    vi.resetModules();
    const existsSync = vi.fn(() => true);
    const readFileSync = vi.fn(() => JSON.stringify({ "app.tools.expand": "ctrl+x" }));
    vi.doMock("node:fs", () => ({ existsSync, readFileSync }));

    const { renderMcpResult: renderWithMockedFs } = await import("../tool-rendering.ts");
    const result = renderWithMockedFs(
      {
        content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") }],
        details: {},
      },
      { expanded: false, isPartial: false },
      theme,
      {} as never,
    );

    expect(result.render(80).at(-1)).toBe("... (2 more lines, ctrl+x to expand)");
    expect(result.render(80).at(-1)).toBe("... (2 more lines, ctrl+x to expand)");
    expect(existsSync).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });
});
