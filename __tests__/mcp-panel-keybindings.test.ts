import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMcpPanel } from "../mcp-panel.ts";
import { createMcpSetupPanel, type SetupPanelCallbacks } from "../mcp-setup-panel.ts";
import { createPanelKeys } from "../panel-keys.ts";
import type { McpDiscoverySummary } from "../config.ts";
import type { McpConfig, McpPanelCallbacks } from "../types.ts";

const CTRL_P = "\x10";
const CTRL_N = "\x0e";
const CTRL_S = "\x13";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function createEmacsKeybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": ["up", "ctrl+p"],
    "tui.select.down": ["down", "ctrl+n"],
  });
}

function createSaveKeybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "mcp.panel.save": "ctrl+p",
  });
}

function createUnboundSaveKeybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "mcp.panel.save": [],
  });
}

function createTwoServerConfig(): McpConfig {
  return {
    mcpServers: {
      alpha: { url: "https://alpha.example.com/mcp", auth: "oauth" },
      beta: { url: "https://beta.example.com/mcp", auth: "oauth" },
    },
  };
}

function createAuthCallbacks(): McpPanelCallbacks {
  return {
    reconnect: async () => true,
    canAuthenticate: () => true,
    authenticate: vi.fn(async () => ({ ok: true })),
    getConnectionStatus: () => "needs-auth",
    refreshCacheAfterReconnect: () => null,
  };
}

function createEmptyDiscovery(): McpDiscoverySummary {
  return {
    sources: [],
    imports: [],
    hasAnyConfig: false,
    hasAnyDetectedPaths: false,
    hasSharedServers: false,
    hasPiOwnedServers: false,
    totalServerCount: 0,
    hostConfigs: [],
    hostConfigDiscovery: "off",
    conflicts: [],
    fingerprint: "test",
    repoPrompt: { configured: false },
  };
}

function createSetupCallbacks(): SetupPanelCallbacks {
  const preview = { path: "/tmp/x", existed: false, changed: true, beforeText: "", afterText: "", diffText: "" };
  return {
    previewImports: () => preview,
    previewStarterConfig: () => preview,
    previewRepoPrompt: () => null,
    previewKnownServer: () => preview,
    adoptImports: async () => ({ added: [], path: "/tmp/x" }),
    scaffoldConfig: vi.fn(async () => ({ path: "/tmp/x" })),
    addRepoPrompt: vi.fn(async () => ({ path: "/tmp/x", serverName: "repoprompt" })),
    addKnownServer: vi.fn(async (preset) => ({ path: "/tmp/x", serverName: preset.name })),
    openPath: async () => {},
    markSetupCompleted: () => {},
  };
}

describe("panel-keys", () => {
  it("honors user keybindings when a manager is provided", () => {
    const keys = createPanelKeys(createEmacsKeybindings());
    expect(keys.selectUp(CTRL_P)).toBe(true);
    expect(keys.selectUp(UP)).toBe(true);
    expect(keys.selectDown(CTRL_N)).toBe(true);
    expect(keys.selectDown(DOWN)).toBe(true);
    expect(keys.selectConfirm(ENTER)).toBe(true);
  });

  it("honors the MCP panel save keybinding", () => {
    const keys = createPanelKeys(createSaveKeybindings());
    expect(keys.save(CTRL_P)).toBe(true);
    expect(keys.save(CTRL_S)).toBe(false);
    expect(keys.saveLabel()).toBe("ctrl+p");
  });

  it("lets users unbind the MCP panel save keybinding", () => {
    const keys = createPanelKeys(createUnboundSaveKeybindings());
    expect(keys.save(CTRL_P)).toBe(false);
    expect(keys.save(CTRL_S)).toBe(false);
    expect(keys.saveLabel()).toBeNull();
  });

  it("falls back to hardcoded defaults without a manager", () => {
    const keys = createPanelKeys();
    expect(keys.selectUp(UP)).toBe(true);
    expect(keys.selectUp(CTRL_P)).toBe(false);
    expect(keys.selectDown(DOWN)).toBe(true);
    expect(keys.selectDown(CTRL_N)).toBe(false);
    expect(keys.selectConfirm(ENTER)).toBe(true);
    expect(keys.save(CTRL_S)).toBe(true);
    expect(keys.save(CTRL_P)).toBe(false);
    expect(keys.saveLabel()).toBe("ctrl+s");
  });

  it("respects rebinding that removes a default key", () => {
    const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "ctrl+p",
    });
    const keys = createPanelKeys(manager);
    expect(keys.selectUp(CTRL_P)).toBe(true);
    expect(keys.selectUp(UP)).toBe(false);
  });
});

describe("mcp-panel custom keybindings", () => {
  it("navigates with ctrl+n/ctrl+p when bound to tui.select.down/up", async () => {
    const callbacks = createAuthCallbacks();
    const panel = createMcpPanel(
      createTwoServerConfig(),
      null,
      new Map(),
      callbacks,
      { requestRender: () => {} },
      () => {},
      { authOnly: true, keybindings: createEmacsKeybindings() },
    );

    panel.handleInput(CTRL_N);
    panel.handleInput(ENTER);
    await Promise.resolve();
    expect(callbacks.authenticate).toHaveBeenLastCalledWith("beta");

    panel.handleInput(CTRL_P);
    panel.handleInput(ENTER);
    await Promise.resolve();
    expect(callbacks.authenticate).toHaveBeenLastCalledWith("alpha");
    panel.dispose();
  });

  it("keeps arrow keys working alongside custom bindings", async () => {
    const callbacks = createAuthCallbacks();
    const panel = createMcpPanel(
      createTwoServerConfig(),
      null,
      new Map(),
      callbacks,
      { requestRender: () => {} },
      () => {},
      { authOnly: true, keybindings: createEmacsKeybindings() },
    );

    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    await Promise.resolve();
    expect(callbacks.authenticate).toHaveBeenLastCalledWith("beta");
    panel.dispose();
  });

  it("treats ctrl+p/ctrl+n as unbound without a keybindings manager", async () => {
    const callbacks = createAuthCallbacks();
    const panel = createMcpPanel(
      createTwoServerConfig(),
      null,
      new Map(),
      callbacks,
      { requestRender: () => {} },
      () => {},
      { authOnly: true },
    );

    panel.handleInput(CTRL_N);
    panel.handleInput(ENTER);
    await Promise.resolve();
    // Cursor did not move: still authenticates the first server.
    expect(callbacks.authenticate).toHaveBeenLastCalledWith("alpha");
    panel.dispose();
  });

  it("uses the configured save key and hint", () => {
    const done = vi.fn();
    const panel = createMcpPanel(
      createTwoServerConfig(),
      null,
      new Map(),
      createAuthCallbacks(),
      { requestRender: () => {} },
      done,
      { keybindings: createSaveKeybindings() },
    );

    expect(stripAnsi(panel.render(100).join("\n"))).toContain("ctrl+p save");
    panel.handleInput(CTRL_S);
    expect(done).not.toHaveBeenCalled();
    panel.handleInput(CTRL_P);
    expect(done).toHaveBeenCalledWith({ changes: new Map(), cancelled: false });
    panel.dispose();
  });

  it("hides the save hint when the save keybinding is unbound", () => {
    const done = vi.fn();
    const panel = createMcpPanel(
      createTwoServerConfig(),
      null,
      new Map(),
      createAuthCallbacks(),
      { requestRender: () => {} },
      done,
      { keybindings: createUnboundSaveKeybindings() },
    );

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).not.toContain("ctrl+s save");
    expect(output).not.toContain("ctrl+p save");
    panel.handleInput(CTRL_S);
    panel.handleInput(CTRL_P);
    expect(done).not.toHaveBeenCalled();
    panel.dispose();
  });
});

describe("mcp-setup-panel custom keybindings", () => {
  it("navigates actions with ctrl+n and confirms with enter", async () => {
    const callbacks = createSetupCallbacks();
    const panel = createMcpSetupPanel(
      createEmptyDiscovery(),
      callbacks,
      {
        mode: "setup",
        onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
        keybindings: createEmacsKeybindings(),
      },
      { requestRender: () => {} },
      () => {},
    );

    // Select global target, then scaffold the selected normal config path.
    panel.handleInput(CTRL_N);
    panel.handleInput(ENTER);
    panel.handleInput(CTRL_N);
    panel.handleInput(CTRL_N);
    await Promise.resolve();
    await Promise.resolve();
    panel.handleInput(ENTER);
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks.scaffoldConfig).toHaveBeenCalledWith("global");
    panel.dispose();
  });

  it("adds known servers to the selected shared config target", async () => {
    const callbacks = createSetupCallbacks();
    const panel = createMcpSetupPanel(
      createEmptyDiscovery(),
      callbacks,
      {
        mode: "setup",
        onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
      },
      { requestRender: () => {} },
      () => {},
    );

    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    for (let i = 0; i < 4; i += 1) panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks.addKnownServer).toHaveBeenCalledWith(expect.objectContaining({ id: "deepwiki" }), "global");
    panel.dispose();
  });

  it("keeps setup previews usable at mobile width", () => {
    const panel = createMcpSetupPanel(
      createEmptyDiscovery(),
      createSetupCallbacks(),
      {
        mode: "setup",
        onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
      },
      { requestRender: () => {} },
      () => {},
    );

    // Actions include target selection, scaffold-selected, known presets, close.
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    const lines = panel.render(37);
    const output = lines.join("\n");

    expect(Math.max(...lines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(37);
    expect(output).toContain("DeepWiki");
    expect(output).toContain("starter write");
    expect(output).toContain("Enter select");
    panel.dispose();
  });

  it("shows the actual config precedence including .agents paths", () => {
    const panel = createMcpSetupPanel(
      createEmptyDiscovery(),
      createSetupCallbacks(),
      {
        mode: "setup",
        onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
      },
      { requestRender: () => {} },
      () => {},
    );

    // Actions include target selection, view-example, scaffold-selected, show-precedence, close.
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    const output = panel.render(100).join("\n");

    expect(output).toContain("Recommended shared config:");
    expect(output).toContain("project/team: .mcp.json");
    expect(output).toContain("all projects: ~/.config/mcp/mcp.json");
    expect(output).toContain("Advanced compatibility and Pi-owned layers:");
    expect(output).toContain("Read order (later entries win):");
    expect(output).toContain("0. detected host configs (opt-in lowest-precedence fallback)");
    expect(output).toContain("2. ~/.agents/mcp.json");
    expect(output).toContain("3. ~/.agents/mcp/mcp.json");
    expect(output).toContain("6. .pi/mcp.json");
    panel.dispose();
  });

  it("shows the branded project Pi override path in config precedence", () => {
    const originalPackageDir = process.env.PI_PACKAGE_DIR;
    const packageDir = mkdtempSync(join(tmpdir(), "pi-mcp-panel-package-"));
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ piConfig: { name: "arc", configDir: ".arc" } }));
    process.env.PI_PACKAGE_DIR = packageDir;

    try {
      const panel = createMcpSetupPanel(
        createEmptyDiscovery(),
        createSetupCallbacks(),
        {
          mode: "setup",
          onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
        },
        { requestRender: () => {} },
        () => {},
      );

      panel.handleInput(DOWN);
      panel.handleInput(DOWN);
      panel.handleInput(DOWN);
      panel.handleInput(DOWN);
      const output = panel.render(100).join("\n");

      expect(output).toContain("6. .arc/mcp.json");
      panel.dispose();
    } finally {
      if (originalPackageDir === undefined) {
        delete process.env.PI_PACKAGE_DIR;
      } else {
        process.env.PI_PACKAGE_DIR = originalPackageDir;
      }
    }
  });
});
