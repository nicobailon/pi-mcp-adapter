import { describe, it, expect } from "vitest";
import { resolveMcpResultContent } from "../tool-registrar.ts";

describe("resolveMcpResultContent", () => {
  it("returns transformed content blocks when content is present", () => {
    const blocks = resolveMcpResultContent({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { ignored: true },
    });

    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("falls back to structuredContent when content is empty", () => {
    const structured = { status: "available", summary: "## Notes" };
    const blocks = resolveMcpResultContent({
      content: [],
      structuredContent: structured,
    });

    expect(blocks).toEqual([
      { type: "text", text: JSON.stringify(structured, null, 2) },
    ]);
  });

  it("falls back to structuredContent when content is omitted entirely", () => {
    const structured = { value: 42 };
    const blocks = resolveMcpResultContent({ structuredContent: structured });

    expect(blocks).toEqual([
      { type: "text", text: JSON.stringify(structured, null, 2) },
    ]);
  });

  it("returns empty array when both content and structuredContent are absent", () => {
    expect(resolveMcpResultContent({ content: [] })).toEqual([]);
    expect(resolveMcpResultContent({})).toEqual([]);
  });

  it("does not treat null structuredContent as a fallback payload", () => {
    expect(
      resolveMcpResultContent({ content: [], structuredContent: null }),
    ).toEqual([]);
  });

  it("treats an empty structuredContent object as a present payload", () => {
    // guards against a truthy check that would drop a legitimately empty object
    expect(
      resolveMcpResultContent({ content: [], structuredContent: {} }),
    ).toEqual([{ type: "text", text: "{}" }]);
  });

  it("does not fall back when content has a non-text block", () => {
    const blocks = resolveMcpResultContent({
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      structuredContent: { should: "not appear" },
    });

    expect(blocks).toEqual([{ type: "image", data: "abc", mimeType: "image/png" }]);
  });

  it("degrades gracefully when structuredContent is not serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const blocks = resolveMcpResultContent({ content: [], structuredContent: circular });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text" });
  });

  it("prefers real content over structuredContent even for a single block", () => {
    const blocks = resolveMcpResultContent({
      content: [{ type: "text", text: "real" }],
      structuredContent: { fallback: "should not appear" },
    });

    expect(blocks).toEqual([{ type: "text", text: "real" }]);
  });
});
