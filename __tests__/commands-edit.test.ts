import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

async function edit(ui: unknown, cwd: string) {
  const { editSharedConfig } = await import("../commands.ts");
  return editSharedConfig({ cwd, hasUI: ui !== undefined, ui } as any, "project");
}

describe("/mcp edit", () => {
  it("does not save invalid JSON", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-edit-"));
    const path = join(cwd, ".mcp.json");
    writeFileSync(path, '{"mcpServers":{}}\n');
    const ui = { editor: vi.fn(async () => '{"mcpServers":{'), notify: vi.fn() };

    expect(await edit(ui, cwd)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('{"mcpServers":{}}\n');
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("not saved"), "error");
  });

  it("does not save a non-object top-level value", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-edit-"));
    const ui = { editor: vi.fn(async () => "null"), notify: vi.fn() };

    expect(await edit(ui, cwd)).toBe(false);
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("top-level value must be an object"), "error");
  });

  it("saves JSONC with comments and trailing commas as typed, creating parent directories", async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), "mcp-edit-")), "nested", "dir");
    const text = '{\n  // comment\n  "mcpServers": {},\n}\n';
    const ui = { editor: vi.fn(async () => text), notify: vi.fn() };

    expect(await edit(ui, cwd)).toBe(true);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe(text);
  });

  it("returns false without UI", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-edit-"));
    expect(await edit(undefined, cwd)).toBe(false);
  });
});
