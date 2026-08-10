import fs, { existsSync, readFileSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  cleanupMaterializedBinaryResources,
  resolveMcpResultContent,
} from "../tool-registrar.ts";

describe("resolveMcpResultContent", () => {
  afterEach(() => cleanupMaterializedBinaryResources());

  it("returns transformed content blocks when content is present", () => {
    const blocks = resolveMcpResultContent({
      content: [{ type: "text", text: "hello" }],
      structuredContent: { ignored: true },
    });

    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("materializes binary resources without retaining base64", () => {
    const data = Buffer.from("binary content");
    const blob = data.toString("base64");
    const result = {
      content: [{
        type: "resource",
        resource: {
          uri: "test://resource",
          mimeType: "application/octet-stream",
          blob,
        },
      }],
    };
    const blocks = resolveMcpResultContent(result);

    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    const path = text.match(/Binary content saved to (.+)/)?.[1];
    expect(path).toBeDefined();
    expect(text).not.toContain(blob);
    expect(result.content[0]?.resource).toEqual({
      uri: "test://resource",
      mimeType: "application/octet-stream",
      text,
    });

    expect(readFileSync(path!)).toEqual(data);
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path!)).mode & 0o777).toBe(0o700);

    cleanupMaterializedBinaryResources();
    expect(existsSync(dirname(path!))).toBe(false);
  });

  it("cleans only the requested materialization scope", () => {
    const scopeA = {};
    const scopeB = {};

    const first = resolveMcpResultContent({
      content: [{ type: "resource", resource: { uri: "test://scope-a", blob: "YQ==" } }],
    }, scopeA);
    const second = resolveMcpResultContent({
      content: [{ type: "resource", resource: { uri: "test://scope-b", blob: "Yg==" } }],
    }, scopeB);

    const pathA = (first[0]?.type === "text" ? first[0].text : "").match(/Binary content saved to (.+)/)?.[1];
    const pathB = (second[0]?.type === "text" ? second[0].text : "").match(/Binary content saved to (.+)/)?.[1];
    expect(pathA).toBeDefined();
    expect(pathB).toBeDefined();

    cleanupMaterializedBinaryResources(scopeB);
    expect(existsSync(dirname(pathA!))).toBe(true);
    expect(existsSync(dirname(pathB!))).toBe(false);

    cleanupMaterializedBinaryResources(scopeA);
    expect(existsSync(dirname(pathA!))).toBe(false);
  });

  it("does not recreate an aborted materialization scope", () => {
    const controller = new AbortController();
    const first = resolveMcpResultContent({
      content: [{ type: "resource", resource: { uri: "test://aborted-scope", blob: "YQ==" } }],
    }, controller.signal);
    const path = (first[0]?.type === "text" ? first[0].text : "").match(/Binary content saved to (.+)/)?.[1];
    expect(path).toBeDefined();

    controller.abort();
    cleanupMaterializedBinaryResources(controller.signal);
    expect(existsSync(dirname(path!))).toBe(false);

    const late = resolveMcpResultContent({
      content: [{ type: "resource", resource: { uri: "test://late", blob: "Yg==" } }],
    }, controller.signal);
    const text = late[0]?.type === "text" ? late[0].text : "";
    expect(text).toContain("Binary content omitted: runtime stopped");
    expect(text).not.toContain("Binary content saved to");
  });

  it("omits binary resources larger than 10 MiB", () => {
    const byteLength = vi.spyOn(Buffer, "byteLength").mockReturnValueOnce(10 * 1024 * 1024 + 1);
    const result = {
      content: [{
        type: "resource",
        resource: { uri: "test://large", blob: "base64" },
      }],
    };

    try {
      const blocks = resolveMcpResultContent(result);
      const text = blocks[0]?.type === "text" ? blocks[0].text : "";
      expect(text).toContain("Binary content omitted: decoded size exceeds 10 MiB");
      expect(result.content[0]?.resource).toEqual({ uri: "test://large", text });
    } finally {
      byteLength.mockRestore();
    }
  });

  it("restores quota when a failed write leaves no file", () => {
    const byteLength = vi.spyOn(Buffer, "byteLength").mockReturnValue(10 * 1024 * 1024);
    const originalWriteFileSync = fs.writeFileSync;

    try {
      fs.writeFileSync = (() => { throw new Error("disk full"); }) as typeof fs.writeFileSync;
      syncBuiltinESMExports();
      const failed = resolveMcpResultContent({
        content: [{ type: "resource", resource: { uri: "test://failure", blob: "YQ==" } }],
      });
      expect(failed[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Binary content omitted: could not be saved"),
      });

      fs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
      for (let i = 0; i < 10; i++) {
        const result = resolveMcpResultContent({
          content: [{ type: "resource", resource: { uri: `test://retry-${i}`, blob: "YQ==" } }],
        });
        expect(result[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("Binary content saved to"),
        });
      }
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
      byteLength.mockRestore();
    }
  });

  it("retries failed session cleanup", () => {
    const blocks = resolveMcpResultContent({
      content: [{ type: "resource", resource: { uri: "test://cleanup", blob: "YQ==" } }],
    });
    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    const path = text.match(/Binary content saved to (.+)/)?.[1];
    expect(path).toBeDefined();

    const originalRmSync = fs.rmSync;
    try {
      fs.rmSync = (() => { throw new Error("file busy"); }) as typeof fs.rmSync;
      syncBuiltinESMExports();
      expect(() => cleanupMaterializedBinaryResources()).toThrow("Failed to clean materialized MCP resources");
    } finally {
      fs.rmSync = originalRmSync;
      syncBuiltinESMExports();
    }

    expect(existsSync(dirname(path!))).toBe(true);
    cleanupMaterializedBinaryResources();
    expect(existsSync(dirname(path!))).toBe(false);
  });

  it("retries failed scoped cleanup from later cleanup calls", () => {
    const scope = {};
    const blocks = resolveMcpResultContent({
      content: [{ type: "resource", resource: { uri: "test://scoped-cleanup", blob: "YQ==" } }],
    }, scope);
    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    const path = text.match(/Binary content saved to (.+)/)?.[1];
    expect(path).toBeDefined();

    const originalRmSync = fs.rmSync;
    try {
      fs.rmSync = (() => { throw new Error("file busy"); }) as typeof fs.rmSync;
      syncBuiltinESMExports();
      expect(() => cleanupMaterializedBinaryResources(scope)).toThrow("Failed to clean materialized MCP resources");
    } finally {
      fs.rmSync = originalRmSync;
      syncBuiltinESMExports();
    }

    expect(existsSync(dirname(path!))).toBe(true);
    cleanupMaterializedBinaryResources({});
    expect(existsSync(dirname(path!))).toBe(false);
  });

  it("schedules a retry without deleting active default-scope resources", () => {
    vi.useFakeTimers();
    const scope = {};
    const blocks = resolveMcpResultContent({
      content: [{ type: "resource", resource: { uri: "test://scheduled-cleanup", blob: "YQ==" } }],
    }, scope);
    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    const path = text.match(/Binary content saved to (.+)/)?.[1];
    expect(path).toBeDefined();

    const originalRmSync = fs.rmSync;
    try {
      fs.rmSync = (() => { throw new Error("file busy"); }) as typeof fs.rmSync;
      syncBuiltinESMExports();
      expect(() => cleanupMaterializedBinaryResources(scope)).toThrow("Failed to clean materialized MCP resources");
      expect(existsSync(dirname(path!))).toBe(true);

      fs.rmSync = originalRmSync;
      syncBuiltinESMExports();
      const active = resolveMcpResultContent({
        content: [{ type: "resource", resource: { uri: "test://default-active", blob: "Yg==" } }],
      });
      const activePath = (active[0]?.type === "text" ? active[0].text : "").match(/Binary content saved to (.+)/)?.[1];
      expect(activePath).toBeDefined();

      vi.runOnlyPendingTimers();
      expect(existsSync(dirname(path!))).toBe(false);
      expect(existsSync(dirname(activePath!))).toBe(true);
      cleanupMaterializedBinaryResources();
      expect(existsSync(dirname(activePath!))).toBe(false);
    } finally {
      fs.rmSync = originalRmSync;
      syncBuiltinESMExports();
      vi.useRealTimers();
    }
  });

  it("stops automatic cleanup retries after repeated failures", () => {
    vi.useFakeTimers();
    const blocks = resolveMcpResultContent({
      content: [{ type: "resource", resource: { uri: "test://permanent-cleanup-failure", blob: "YQ==" } }],
    });
    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    const path = text.match(/Binary content saved to (.+)/)?.[1];
    expect(path).toBeDefined();

    const originalRmSync = fs.rmSync;
    try {
      fs.rmSync = (() => { throw new Error("file busy"); }) as typeof fs.rmSync;
      syncBuiltinESMExports();
      expect(() => cleanupMaterializedBinaryResources()).toThrow("Failed to clean materialized MCP resources");
      expect(vi.getTimerCount()).toBe(1);

      vi.runOnlyPendingTimers();
      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect(vi.getTimerCount()).toBe(1);
      vi.runOnlyPendingTimers();
      expect(vi.getTimerCount()).toBe(0);
      expect(existsSync(dirname(path!))).toBe(true);
    } finally {
      fs.rmSync = originalRmSync;
      syncBuiltinESMExports();
      cleanupMaterializedBinaryResources();
      vi.useRealTimers();
    }
  });

  it("caps materialized binary resources per session", () => {
    const byteLength = vi.spyOn(Buffer, "byteLength").mockReturnValue(10 * 1024 * 1024);

    try {
      for (let i = 0; i < 10; i++) {
        const blocks = resolveMcpResultContent({
          content: [{ type: "resource", resource: { uri: `test://${i}`, blob: "YQ==" } }],
        });
        expect(blocks[0]).toMatchObject({ type: "text", text: expect.stringContaining("Binary content saved to") });
      }

      const blocks = resolveMcpResultContent({
        content: [{ type: "resource", resource: { uri: "test://limit", blob: "YQ==" } }],
      });
      expect(blocks[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Binary content omitted: session resource limit reached"),
      });

      cleanupMaterializedBinaryResources();
      const nextSession = resolveMcpResultContent({
        content: [{ type: "resource", resource: { uri: "test://next-session", blob: "YQ==" } }],
      });
      expect(nextSession[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Binary content saved to"),
      });
    } finally {
      byteLength.mockRestore();
    }
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
