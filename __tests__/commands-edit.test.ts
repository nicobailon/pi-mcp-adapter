import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

async function edit(ui: { editor: () => Promise<string>; notify: () => void }, cwd: string) {
  const { editSharedConfig } = await import("../commands.ts");
  return editSharedConfig({ cwd, hasUI: true, ui } as any, "project");
}

describe("/mcp edit", () => {
  it.each([
    ['{"mcpServers":{', "not saved"],
    ["null", "top-level value must be an object"],
  ])("does not save %j", async (text, message) => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-edit-"));
    const path = join(cwd, ".mcp.json");
    writeFileSync(path, '{"mcpServers":{}}\n');
    const ui = { editor: vi.fn(async () => text), notify: vi.fn() };

    expect(await edit(ui, cwd)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('{"mcpServers":{}}\n');
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining(message), "error");
  });

  it("saves JSONC with comments and trailing commas as typed, creating parent directories", async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), "mcp-edit-")), "nested", "dir");
    const text = '{\n  // comment\n  "mcpServers": {},\n}\n';
    const ui = { editor: vi.fn(async () => text), notify: vi.fn() };

    expect(await edit(ui, cwd)).toBe(true);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe(text);
  });
});
