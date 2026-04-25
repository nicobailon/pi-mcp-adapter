import { describe, expect, it } from "vitest";
import { renderMcpResult } from "../tool-rendering.js";

const theme = {
  fg: (_color: string, text: string) => text,
};

/**
 * Verify MCP result rendering without Pi runtime packages so the adapter stays testable outside Pi.
 */
describe("renderMcpResult", () => {
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
});
