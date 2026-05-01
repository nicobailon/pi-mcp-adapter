import { describe, expect, it, vi } from "vitest";
import {
  extractToolResultText,
  formatMcpResultPreview,
  normalizeMcpResultText,
  summarizeDirectMcpCall,
} from "../mcp-tool-renderer.js";

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    keyHint: (_id: string, description: string) => `Ctrl+O ${description}`,
  };
});

describe("mcp tool renderer helpers", () => {
  it("summarizes direct mcp calls from common argument names", () => {
    expect(summarizeDirectMcpCall({ query: "find routes" })).toBe("find routes");
    expect(summarizeDirectMcpCall({ url: "https://example.com" })).toBe("https://example.com");
    expect(summarizeDirectMcpCall({ arbitrary: true })).toBe('{"arbitrary":true}');
  });

  it("collapses result text to the first ten lines with an expand hint", () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(formatMcpResultPreview(output, false)).toBe([
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
    ].join("\n"));
  });

  it("shows full result text when expanded", () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

    expect(formatMcpResultPreview(output, true)).toBe(output);
  });

  it("normalizes common MCP JSON stdout/stderr wrappers", () => {
    expect(normalizeMcpResultText(JSON.stringify({
      status: "success",
      output: {},
      stdout: "base rows 886\nclub rows 42\n",
      stderr: "",
    }))).toBe("base rows 886\nclub rows 42");

    expect(normalizeMcpResultText(JSON.stringify({ stdout: "ok", stderr: "warn" }))).toBe("ok\n\nstderr:\nwarn");
  });

  it("does not let a single huge JSON line blow up collapsed rendering", () => {
    const stdout = Array.from({ length: 12 }, (_, index) => `row ${index + 1}`).join("\n");
    const output = JSON.stringify({ status: "success", output: {}, stdout, stderr: "" });

    expect(formatMcpResultPreview(output, false)).toBe([
      "row 1",
      "row 2",
      "row 3",
      "row 4",
      "row 5",
      "row 6",
      "row 7",
      "row 8",
      "row 9",
      "row 10",
      "... (2 more lines, Ctrl+O to expand)",
    ].join("\n"));
  });

  it("caps long single-line collapsed output", () => {
    const preview = formatMcpResultPreview("x".repeat(500), false);

    expect(preview).toContain("…");
    expect(preview).toContain("Ctrl+O to expand");
    expect(preview.length).toBeLessThan(300);
  });

  it("extracts text and image fallback blocks from tool results", () => {
    expect(extractToolResultText({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      details: {},
    })).toBe("hello\n[image: image/png]");
  });
});
