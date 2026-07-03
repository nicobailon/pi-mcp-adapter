import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { guardMcpOutput, resolveMcpOutputGuardOptions, type McpResultSummary } from "../mcp-output-guard.ts";

describe("guardMcpOutput", () => {
  it("leaves small MCP output unchanged and keeps the raw result in details", async () => {
    const rawMcpResult = { content: [{ type: "text", text: "small result" }], isError: false, structuredContent: { ok: true } };
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "small result" }],
      { rawMcpResult },
    );

    expect(guarded.content).toEqual([{ type: "text", text: "small result" }]);
    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.mcpResult).toBe(rawMcpResult);
  });

  it("merges prefixes and suffixes into small text output", async () => {
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "upstream failed" }],
      { prefix: "Error: ", suffix: "\n\nExpected parameters:\n{}" },
    );

    expect(guarded.content).toEqual([{ type: "text", text: "Error: upstream failed\n\nExpected parameters:\n{}" }]);
  });

  it("uses the empty text fallback before applying affixes", async () => {
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "" }],
      { prefix: "Error: ", emptyTextFallback: "Tool execution failed" },
    );

    expect(guarded.content).toEqual([{ type: "text", text: "Error: Tool execution failed" }]);

    const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
    const withImage = await guardMcpOutput(
      [image],
      { prefix: "Error: ", emptyTextFallback: "Tool execution failed" },
    );

    expect(withImage.content).toEqual([{ type: "text", text: "Error: Tool execution failed" }, image]);
  });

  it("truncates large text output and saves the full output to a file", async () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n");
    const guarded = await guardMcpOutput(
      [{ type: "text", text }],
      {
        maxBytes: 300,
        maxLines: 8,
        detailsMaxBytes: 200,
        rawMcpResult: { content: [{ type: "text", text }], isError: false, structuredContent: { rows: [text] } },
      },
    );

    expect(guarded.outputGuard).toMatchObject({
      truncated: true,
      originalLines: 20,
    });
    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    expect(guarded.content).toHaveLength(1);
    expect(guarded.content[0]).toMatchObject({ type: "text" });
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(returnedText).toContain("MCP text output truncated");
    expect(returnedText).toContain("Full text saved to:");
    expect(returnedText).not.toContain("line-19");

    const saved = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(saved).toBe(text);

    const summary = guarded.mcpResult as McpResultSummary;
    expect(summary).toMatchObject({ omitted: true, isError: false, contentBlocks: 1 });
    expect(summary.fullResultPath).toBeTruthy();
    expect(summary.structuredContent).toMatchObject({ omitted: true });
    expect(JSON.stringify(summary)).not.toContain("line-19");
  });

  it("summarizes details.mcpResult only when it exceeds detailsMaxBytes", async () => {
    const rawMcpResult = { content: [{ type: "text", text: "ok" }], isError: false, structuredContent: { rows: "y".repeat(500) } };
    const kept = await guardMcpOutput([{ type: "text", text: "ok" }], { detailsMaxBytes: 5000, rawMcpResult });
    expect(kept.mcpResult).toBe(rawMcpResult);

    const summarized = await guardMcpOutput([{ type: "text", text: "ok" }], { detailsMaxBytes: 100, rawMcpResult });
    expect((summarized.mcpResult as McpResultSummary).omitted).toBe(true);
    expect((summarized.mcpResult as McpResultSummary).fullResultPath).toBeTruthy();
  });

  it("passes image blocks through untouched, even large ones", async () => {
    const image = { type: "image" as const, data: "A".repeat(100_000), mimeType: "image/png" };
    const guarded = await guardMcpOutput(
      [image, { type: "text", text: "caption" }],
      { maxBytes: 1000, maxLines: 10 },
    );

    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.content).toEqual([image, { type: "text", text: "caption" }]);
  });

  it("keeps image blocks when text output is truncated", async () => {
    const text = Array.from({ length: 50 }, (_, i) => `row-${i}`).join("\n");
    const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
    const guarded = await guardMcpOutput(
      [{ type: "text", text }, image],
      { maxBytes: 250, maxLines: 5 },
    );

    expect(guarded.outputGuard).toMatchObject({ truncated: true, imageBlocksPassedThrough: 1 });
    expect(guarded.content).toHaveLength(2);
    expect(guarded.content[0].type).toBe("text");
    expect(guarded.content[1]).toEqual(image);

    const saved = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(saved).toBe(text);
  });

  it("truncates on line count alone", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `entry-${i}`).join("\n");
    const guarded = await guardMcpOutput([{ type: "text", text }], { maxBytes: 10_000, maxLines: 10 });

    expect(guarded.outputGuard).toMatchObject({ truncated: true, originalLines: 30 });
    const returnedText = guarded.content[0].type === "text" ? guarded.content[0].text : "";
    expect(returnedText).toContain("entry-0");
    expect(returnedText).not.toContain("entry-29");
  });

  it("keeps prefixes and suffixes inside the saved full output", async () => {
    const guarded = await guardMcpOutput(
      [{ type: "text", text: "body" }],
      { prefix: "Error: ", suffix: "\n\nExpected parameters:\n{}", maxBytes: 10, maxLines: 2 },
    );

    expect(guarded.outputGuard?.fullOutputPath).toBeTruthy();
    const saved = await readFile(guarded.outputGuard!.fullOutputPath!, "utf8");
    expect(saved).toBe("Error: body\n\nExpected parameters:\n{}");
  });

  it("can be disabled to return raw output and raw details", async () => {
    const text = "x".repeat(1000);
    const rawMcpResult = { content: [{ type: "text", text }], isError: false };
    const guarded = await guardMcpOutput(
      [{ type: "text", text }],
      { enabled: false, maxBytes: 10, maxLines: 1, rawMcpResult },
    );

    expect(guarded.content).toEqual([{ type: "text", text }]);
    expect(guarded.outputGuard).toBeUndefined();
    expect(guarded.mcpResult).toBe(rawMcpResult);

    const withPrefix = await guardMcpOutput(
      [{ type: "text", text: "body" }],
      { enabled: false, prefix: "Error: ", rawMcpResult },
    );

    expect(withPrefix.content).toEqual([{ type: "text", text: "Error: body" }]);
  });

  it("returns no mcpResult when rawMcpResult is not provided", async () => {
    const guarded = await guardMcpOutput([{ type: "text", text: "x" }], {});
    expect(guarded.mcpResult).toBeUndefined();
  });
});

describe("resolveMcpOutputGuardOptions", () => {
  it("defaults to enabled with standard limits", () => {
    expect(resolveMcpOutputGuardOptions(undefined)).toEqual({
      enabled: true,
      maxBytes: 50 * 1024,
      maxLines: 2000,
      detailsMaxBytes: 16 * 1024,
    });
  });

  it("supports boolean and object settings", () => {
    expect(resolveMcpOutputGuardOptions({ outputGuard: false }).enabled).toBe(false);
    expect(resolveMcpOutputGuardOptions({ outputGuard: true }).enabled).toBe(true);
    expect(resolveMcpOutputGuardOptions({ outputGuard: { maxBytes: 1234, maxLines: 50 } })).toMatchObject({
      enabled: true,
      maxBytes: 1234,
      maxLines: 50,
      detailsMaxBytes: 16 * 1024,
    });
  });

  it("honors the MCP_OUTPUT_GUARD env kill switch", () => {
    const previous = process.env.MCP_OUTPUT_GUARD;
    try {
      process.env.MCP_OUTPUT_GUARD = "0";
      expect(resolveMcpOutputGuardOptions({ outputGuard: true }).enabled).toBe(false);
      process.env.MCP_OUTPUT_GUARD = "1";
      expect(resolveMcpOutputGuardOptions({ outputGuard: false }).enabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.MCP_OUTPUT_GUARD;
      else process.env.MCP_OUTPUT_GUARD = previous;
    }
  });
});
