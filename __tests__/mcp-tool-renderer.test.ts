import { describe, expect, it, vi } from "vitest";
import {
  McpResultComponent,
} from "../mcp-tool-renderer.js";

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    keyHint: (_id: string, description: string) => `Ctrl+O ${description}`,
  };
});

describe("mcp tool renderer helpers", () => {
  it("collapses result text to the first lines with an expand hint", () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

    const preview = renderResultText(output, false);

    expect(preview.split("\n").map((line) => line.trimEnd())).toEqual([
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
      "... (2 more lines, Ctrl+O to expand)",
    ]);
  });

  it("shows full result text when expanded", () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(renderResultText(output, true).split("\n").map((line) => line.trimEnd()).join("\n")).toBe(`\n${output}`);
  });

  it("treats JSON-looking result text as plain text", () => {
    const stdout = Array.from({ length: 40 }, (_, index) => `row ${index + 1}`).join("\n");
    const output = JSON.stringify({ status: "success", output: {}, stdout, stderr: "" });
    const preview = renderResultText(output, false);

    expect(preview).toContain('{"status":"success"');
  });
});

function renderResultText(output: string, expanded: boolean): string {
  const component = new McpResultComponent(
    { content: [{ type: "text", text: output }], details: {} },
    expanded,
    false,
    {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    } as any,
  );
  return component.render(80).join("\n");
}
