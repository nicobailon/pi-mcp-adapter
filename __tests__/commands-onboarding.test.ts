import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { captureEnv } from "./test-env.js";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

const mocks = {
  createMcpPanel: vi.fn(),
  createMcpSetupPanel: vi.fn(),
};

vi.mock("../mcp-panel.js", () => ({
  createMcpPanel: mocks.createMcpPanel,
}));

vi.mock("../mcp-setup-panel.js", () => ({
  createMcpSetupPanel: mocks.createMcpSetupPanel,
}));

describe("commands onboarding", () => {
  const restoreEnv = captureEnv(["HOME", "PI_CODING_AGENT_DIR"]);
  const originalCwd = process.cwd();

  beforeEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    vi.resetModules();
    mocks.createMcpPanel.mockReset().mockImplementation((_config, _cache, _prov, _callbacks, _tui, done) => {
      done({ cancelled: true, changes: new Map() });
      return { dispose() {} };
    });
    mocks.createMcpSetupPanel.mockReset().mockImplementation((_discovery, _callbacks, _options, _tui, done) => {
      done();
      return { dispose() {} };
    });
  });

  afterEach(() => {
    restoreEnv();
    process.chdir(originalCwd);
  });

  function createUi() {
    return {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn((renderer: any) => renderer({ requestRender: vi.fn() }, {}, {}, vi.fn())),
    };
  }

  it("opens setup mode when no MCP servers are configured", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-commands-home-"));
    const ui = createUi();
    const { openMcpPanel } = await import("../commands.ts");

    await openMcpPanel({
      config: { mcpServers: {} },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, ui } as any);

    expect(mocks.createMcpSetupPanel).toHaveBeenCalled();
    expect(mocks.createMcpPanel).not.toHaveBeenCalled();
  });

  it("shows a one-time shared-config notice in the MCP panel", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-commands-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-commands-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        sharedServer: { command: "shared" },
      },
    });

    const ui = createUi();
    const { loadMcpConfig } = await import("../config.ts");
    const { openMcpPanel } = await import("../commands.ts");
    const { loadOnboardingState } = await import("../onboarding-state.ts");

    await openMcpPanel({
      config: loadMcpConfig(),
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, ui } as any);

    expect(mocks.createMcpPanel).toHaveBeenCalled();
    const options = mocks.createMcpPanel.mock.calls[0]?.[6];
    expect(options.noticeLines[0]).toContain("Using standard MCP config");
    expect(loadOnboardingState().sharedConfigHintShown).toBe(true);
  });
});
