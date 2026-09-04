import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createMcpSetupPanel, type SetupPanelCallbacks } from "../mcp-setup-panel.ts";
import type { McpDiscoverySummary } from "../config.ts";

function createTheme() {
  const colors: Record<string, number> = {
    accent: 31,
    border: 32,
    success: 33,
    warning: 34,
    muted: 35,
    dim: 36,
    error: 37,
  };
  const fg = vi.fn((color: string, text: string) => `\x1b[38;5;${colors[color] ?? 38}m${text}\x1b[39m`);
  const theme = {
    fg,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
    inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
  } as unknown as Theme;
  return { fg, theme };
}

function createDiscovery(): McpDiscoverySummary {
  return {
    sources: [],
    imports: [],
    hostConfigs: [],
    hostConfigDiscovery: "off",
    agentPlugins: [],
    conflicts: [],
    hasAnyConfig: false,
    hasAnyDetectedPaths: false,
    hasSharedServers: false,
    hasPiOwnedServers: false,
    totalServerCount: 0,
    fingerprint: "test",
    repoPrompt: { configured: false },
  };
}

function createCallbacks(): SetupPanelCallbacks {
  const preview = {
    path: "/tmp/mcp.json",
    existed: false,
    changed: true,
    beforeText: "",
    afterText: "",
    diffText: "",
  };
  return {
    previewImports: () => preview,
    previewStarterConfig: () => preview,
    previewRepoPrompt: () => null,
    previewKnownServer: () => preview,
    adoptImports: async () => ({ added: [], path: preview.path }),
    scaffoldConfig: async () => ({ path: preview.path }),
    addRepoPrompt: async () => ({ path: preview.path, serverName: "repoprompt" }),
    addKnownServer: async (preset) => ({ path: preview.path, serverName: preset.name }),
    openPath: async () => {},
    markSetupCompleted: () => {},
  };
}

describe("mcp setup panel theme and component rendering", () => {
  it("renders setup content through the active Pi theme", () => {
    const { fg, theme } = createTheme();
    const panel = createMcpSetupPanel(
      createDiscovery(),
      createCallbacks(),
      {
        mode: "setup",
        onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
        theme,
      },
      { requestRender: () => {} },
      () => {},
    );

    const lines = panel.render(60);
    const output = lines.join("\n");

    expect(output).toContain("MCP setup");
    expect(output).toContain("No MCP config is active yet.");
    expect(fg).toHaveBeenCalledWith("border", expect.stringContaining("─"));
    expect(fg).toHaveBeenCalledWith("accent", "MCP setup");
    expect(fg).toHaveBeenCalledWith("accent", "›");
    expect(fg).toHaveBeenCalledWith("warning", "No MCP config is active yet.");
    expect(output).not.toContain("\x1b[0m");
    expect(Math.max(...lines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(60);
    panel.dispose();
  });
});
