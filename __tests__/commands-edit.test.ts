import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("/mcp edit", () => {
  it("does not save invalid JSON", async () => {
    const { editSharedConfig } = await import("../commands.ts");
    const cwd = mkdtempSync(join(tmpdir(), "mcp-edit-"));
    const path = join(cwd, ".mcp.json");
    writeFileSync(path, '{"mcpServers":{}}\n');
    const ui = { editor: vi.fn(async () => '{"mcpServers":{'), notify: vi.fn() };

    const changed = await editSharedConfig({ cwd, ui } as any, "project");

    expect(changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe('{"mcpServers":{}}\n');
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("invalid JSON"), "error");
  });
});
