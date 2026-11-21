import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { createMcpPanel } from "../mcp-panel.ts";

const mocks = vi.hoisted(() => ({ createMcpPanel: vi.fn() }));

vi.mock("../mcp-panel.ts", () => ({ createMcpPanel: mocks.createMcpPanel }));

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

describe("saving server toggles from the /mcp panel", () => {
  let root: string;
  let cwd: string;
  let globalPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-panel-disable-save-"));
    const home = join(root, "home");
    cwd = join(root, "project");
    globalPath = join(home, ".pi", "agent", "mcp-adapter.json");
    mkdirSync(cwd, { recursive: true });
    vi.resetModules();
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
    writeJson(globalPath, { mcpServers: { alpha: { command: "node" }, beta: { command: "node" } } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  async function saveDisabled(): Promise<ReturnType<typeof vi.fn>> {
    const { loadMcpConfig } = await import("../config.ts");
    const { openMcpPanel } = await import("../commands.ts");
    mocks.createMcpPanel.mockImplementationOnce((...args: Parameters<typeof createMcpPanel>) => {
      args[5]({ cancelled: false, changes: new Map(), disabledChanges: new Map([["alpha", true], ["beta", true]]) });
      return { render: () => [], invalidate: () => {}, handleInput: () => {} };
    });
    const notify = vi.fn();
    const ui = { notify, custom: vi.fn((factory: any) => { factory({ requestRender() {} }, undefined, undefined, () => {}); }) };
    await openMcpPanel(
      { programmaticConfig: false, config: loadMcpConfig(undefined, cwd), authStorageOptions: {}, manager: { getConnection: () => undefined }, failureTracker: new Map(), failureMessages: new Map() } as any,
      { getFlag: () => undefined } as any,
      { cwd, hasUI: true, mode: "tui", isProjectTrusted: () => true, ui } as any,
    );
    return notify;
  }

  it("names the file it wrote, once per save", async () => {
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
    const notify = await saveDisabled();

    const projectPath = join(cwd, ".pi", "mcp-adapter.json");
    expect(notify.mock.calls).toEqual([[`Saved to ${projectPath}: disabled "alpha", "beta"`, "info"]]);
    expect(JSON.parse(readFileSync(projectPath, "utf8")).mcpServers).toEqual({ alpha: { disabled: true }, beta: { disabled: true } });
  });

  it("refuses a project override that exclusive mode would never read", async () => {
    vi.stubEnv("PI_MCP_CONFIG_MODE", "exclusive");
    const notify = await saveDisabled();

    const reason = `Project overrides are unavailable in exclusive config mode, which reads only ${globalPath}; edit that file instead`;
    expect(notify.mock.calls).toEqual([
      [`Failed to disable server "alpha": ${reason}`, "error"],
      [`Failed to disable server "beta": ${reason}`, "error"],
    ]);
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });
});
