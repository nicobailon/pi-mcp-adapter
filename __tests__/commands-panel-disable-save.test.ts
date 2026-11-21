import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const CTRL_D = "\x04";
const CTRL_S = "\x13";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function panelText(lines: string[]): string {
  return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").replaceAll("│", "").trim()).join("\n");
}

describe("disabling a server from the /mcp panel", () => {
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
    writeJson(globalPath, { mcpServers: { alpha: { command: "node" } } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  // Renders the real panel before and after ctrl+d on the first row, then saves.
  async function disableFirstServer(): Promise<{ before: string; pending: string }> {
    const { loadMcpConfig } = await import("../config.ts");
    const { openMcpPanel } = await import("../commands.ts");
    const screens = { before: "", pending: "" };
    const ui = {
      notify: vi.fn(),
      custom: vi.fn((factory: any) => {
        const panel = factory({ requestRender() {} }, undefined, undefined, () => {});
        screens.before = panelText(panel.render(400));
        panel.handleInput(CTRL_D);
        screens.pending = panelText(panel.render(400));
        panel.handleInput(CTRL_S);
      }),
    };
    await openMcpPanel(
      { programmaticConfig: false, config: loadMcpConfig(undefined, cwd), authStorageOptions: {}, manager: { getConnection: () => undefined }, failureTracker: new Map(), failureMessages: new Map() } as any,
      { getFlag: () => undefined } as any,
      { cwd, hasUI: true, mode: "tui", isProjectTrusted: () => true, ui } as any,
    );
    return screens;
  }

  it("names the file Save will write while a toggle is pending", async () => {
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
    const { before, pending } = await disableFirstServer();

    const projectPath = join(cwd, ".pi", "mcp-adapter.json");
    expect(before).not.toContain("Save writes enable/disable");
    expect(pending).toContain(`Save writes enable/disable to ${projectPath}`);
    expect(JSON.parse(readFileSync(projectPath, "utf8")).mcpServers).toEqual({ alpha: { disabled: true } });
  });

  it("says Save can't change servers in exclusive mode, and writes nothing", async () => {
    vi.stubEnv("PI_MCP_CONFIG_MODE", "exclusive");
    const { pending } = await disableFirstServer();

    expect(pending).toContain(`Save can't enable or disable servers here: Project overrides are unavailable in exclusive config mode, which reads only ${globalPath}; edit that file instead`);
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });
});
