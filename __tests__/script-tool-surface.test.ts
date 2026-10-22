import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ runCodemodeScript: vi.fn() }));
vi.mock("../codemode-bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../codemode-bridge.ts")>()),
  runCodemodeScript: bridge.runCodemodeScript,
}));

import { resolveScriptToolSpecs, runScriptTool, scriptToolOwnerKey } from "../script-tool-surface.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-mcp-script-tool-surface-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(file: string, settings?: Record<string, unknown>) {
  return runScriptTool({
    pi: {} as never, ctx: {} as never, toolCallId: "st-1", signal: undefined, onUpdate: undefined,
    spec: { name: "close_stale", toolName: "mcp__script__close_stale", definition: { description: "Close", file } },
    input: { repo: "a/b" }, settings,
  });
}

describe("runScriptTool", () => {
  it.each([
    ["missing", () => join(dir, "missing.js"), "script_file_missing", (file: string) => `its script file ${file} does not exist.`],
    ["a directory", () => { mkdirSync(join(dir, "folder")); return join(dir, "folder"); }, "script_file_unreadable", (file: string) => `${file} could not be read (EISDIR: illegal operation on a directory, read).`],
    ["empty", () => { writeFileSync(join(dir, "empty.js"), " \n\t"); return join(dir, "empty.js"); }, "script_file_empty", (file: string) => `${file} is empty.`],
    ["over 1 MiB", () => { writeFileSync(join(dir, "big.js"), "x".repeat(1024 * 1024 + 1)); return join(dir, "big.js"); }, "script_file_too_large", (file: string) => `${file} is larger than 1 MiB.`],
  ])("returns %s as an error result and runs nothing", async (_case, make, error, reason) => {
    const file = make();
    await expect(run(file)).resolves.toEqual({
      content: [{ type: "text", text: `Script tool "close_stale" cannot run: ${reason(file)}` }],
      details: { mode: "script_tool", tool: "close_stale", error },
    });
    expect(bridge.runCodemodeScript).not.toHaveBeenCalled();
  });

  it("returns an unreadable file's errno message", async () => {
    const file = join(dir, "locked.js");
    writeFileSync(file, "return 1;");
    chmodSync(file, 0o000);
    try {
      expect((await run(file)).details).toEqual({ mode: "script_tool", tool: "close_stale", error: "script_file_unreadable" });
    } finally {
      chmodSync(file, 0o644);
    }
  });

  it("reads the file at call time and returns codemode's result with the adapter's details, through the output guard", async () => {
    const file = join(dir, "close.js");
    writeFileSync(file, "return input.repo;");
    bridge.runCodemodeScript.mockResolvedValueOnce({ content: [{ type: "text", text: "Script completed\na/b" }], details: { calls: [{ id: "st-1/1", name: "x", status: "ok" }] } });
    await expect(run(file)).resolves.toEqual({
      content: [{ type: "text", text: "Script completed\na/b" }],
      details: { mode: "script_tool", tool: "close_stale", calls: [{ id: "st-1/1", name: "x", status: "ok" }] },
    });
    expect(bridge.runCodemodeScript).toHaveBeenLastCalledWith(expect.objectContaining({ toolCallId: "st-1", tool: "close_stale", source: "return input.repo;", input: { repo: "a/b" } }));

    writeFileSync(file, "return 2;");
    bridge.runCodemodeScript.mockResolvedValueOnce({ content: [{ type: "text", text: "Script completed\n" + "line\n".repeat(50) }], details: { calls: [] } });
    const guarded = await run(file, { outputGuard: { maxLines: 10 } });
    expect(bridge.runCodemodeScript).toHaveBeenLastCalledWith(expect.objectContaining({ source: "return 2;" }));
    expect(guarded.details).toMatchObject({ mode: "script_tool", tool: "close_stale", calls: [], outputGuard: { truncated: true, maxLines: 10 } });
  });

  it("returns codemode_unavailable as the bridge gave it", async () => {
    const file = join(dir, "close.js");
    const unavailable = { content: [{ type: "text", text: "unavailable" }], details: { mode: "script_tool", tool: "close_stale", error: "codemode_unavailable" } };
    bridge.runCodemodeScript.mockResolvedValueOnce(unavailable);
    await expect(run(file)).resolves.toBe(unavailable);
  });
});

describe("resolveScriptToolSpecs", () => {
  it("keeps a name its own script tool was given, and refuses one another tool was given", () => {
    const owners = new Map([["mcp__script__mine", scriptToolOwnerKey("mine")], ["mcp__script__theirs", JSON.stringify(["script", "theirs", null])]]);
    const tools = { mine: { description: "M", file: "/m.js" }, theirs: { description: "T", file: "/t.js" } };

    expect(resolveScriptToolSpecs(tools, [], owners)).toEqual({
      specs: [{ name: "mine", toolName: "mcp__script__mine", definition: tools.mine }],
      issues: ['Script tool "theirs" was not loaded — mcp__script__theirs was given to an MCP tool earlier in this session.'],
    });
  });
});
