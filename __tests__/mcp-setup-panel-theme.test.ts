import { visibleWidth } from "@earendil-works/pi-tui";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMcpSetupPanel, type SetupPanelCallbacks } from "../mcp-setup-panel.ts";
import { KNOWN_SERVER_PRESETS, previewSharedServerEntry, type McpDiscoverySummary } from "../config.ts";
import { createTheme } from "./helpers/panel-theme.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Presses DOWN until the setup panel's cursor row shows `label`. */
function moveCursorTo(panel: { render(width: number): string[]; handleInput(data: string): void }, label: string): void {
  for (let presses = 0; presses < 40; presses += 1) {
    if (panel.render(200).some((line) => stripAnsi(line).includes(`› ${label}`))) return;
    panel.handleInput(DOWN);
  }
  throw new Error(`Setup cursor never reached ${label}`);
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
    knownServerPresets: KNOWN_SERVER_PRESETS,
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
  it("shows preview errors without breaking setup or import rendering", () => {
    const discovery = createDiscovery();
    discovery.imports = [{ kind: "cursor", path: "/tmp/cursor-mcp.json", serverCount: 1 }];
    const callbacks = createCallbacks();
    callbacks.previewImports = () => { throw new Error("Failed to read MCP config at /tmp/mcp.json"); };
    const panel = createMcpSetupPanel(
      discovery,
      callbacks,
      { mode: "setup", onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false } },
      { requestRender: () => {} },
      () => {},
    );

    moveCursorTo(panel, "Adopt compatibility imports");
    expect(panel.render(100).join("\n")).toContain("Failed to read MCP config at /tmp/mcp.json");
    panel.handleInput(ENTER);
    expect(panel.render(100).join("\n")).toContain("[x] cursor");
    expect(panel.render(100).join("\n")).toContain("Failed to read MCP config at /tmp/mcp.json");
    panel.dispose();
  });

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
    expect(fg).toHaveBeenCalledWith("accent", " MCP setup ");
    expect(fg).toHaveBeenCalledWith("accent", "›");
    expect(fg).toHaveBeenCalledWith("warning", "No MCP config is active yet.");
    expect(fg).toHaveBeenCalledWith("muted", expect.stringContaining("WRITE NEW SERVERS TO"));
    expect(output).not.toContain("\x1b[0m");
    expect(Math.max(...lines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(60);
    panel.dispose();
  });

  it("reapplies active styles to wrapped continuation lines", () => {
    const { theme } = createTheme();
    const discovery = createDiscovery();
    const panel = createMcpSetupPanel(
      discovery,
      createCallbacks(),
      {
        mode: "setup",
        onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false },
        theme,
      },
      { requestRender: () => {} },
      () => {},
    );

    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    const noticeLines = panel.render(40).filter((line) => [
      "New shared servers will be written",
      "to global ~/.config/mcp/mcp.json.",
    ].some((text) => line.includes(text)));
    expect(noticeLines).toHaveLength(2);
    for (const line of noticeLines) expect(line).toContain("\x1b[38;5;36m");

    discovery.hasAnyConfig = true;
    discovery.totalServerCount = 123;
    discovery.sources = [
      { id: "shared-project", label: "project shared", path: "/tmp/shared", exists: true, scope: "project", kind: "shared", serverCount: 1 },
      { id: "pi-project", label: "project Pi", path: "/tmp/pi", exists: true, scope: "project", kind: "pi", serverCount: 1 },
    ];
    const summaryLine = panel.render(40).find((line) => line.includes("123 servers · 2 config files"));
    expect(summaryLine).toContain("\x1b[38;5;36m");
    panel.dispose();
  });

  it("keeps one height for every cursor position, screen, and notice", async () => {
    const width = 92;
    const figma = KNOWN_SERVER_PRESETS.find(({ id }) => id === "figma")!;
    const discovery: McpDiscoverySummary = {
      ...createDiscovery(),
      hasAnyConfig: true,
      totalServerCount: 1,
      sources: [{ id: "shared-project", label: "project shared", path: "/tmp/project/.mcp.json", exists: true, scope: "project", kind: "shared", serverCount: 1 }],
      imports: [{ kind: "claude-code", path: "/tmp/.claude.json", serverCount: 2 }],
    };
    const configPath = join(tmpdir(), "pi-mcp-setup-panel-missing", ".mcp.json");
    const callbacks = createCallbacks();
    callbacks.previewKnownServer = (preset) => previewSharedServerEntry(configPath, preset.id, preset.entry);
    callbacks.addKnownServer = vi.fn(async (preset) => ({ path: configPath, serverName: preset.name, reachable: false }));
    const panel = createMcpSetupPanel(
      discovery,
      callbacks,
      { mode: "setup", onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false } },
      { requestRender: () => {}, terminal: { rows: 40 } },
      () => {},
    );

    const renders: string[][] = [panel.render(width)];
    for (let presses = 0; presses < 20; presses += 1) {
      panel.handleInput(DOWN);
      renders.push(panel.render(width));
    }
    // 40 terminal rows minus a 1-row margin above and below.
    expect(new Set(renders.map((lines) => lines.length))).toEqual(new Set([38]));
    for (let presses = 0; presses < 20; presses += 1) panel.handleInput("\x1b[A");

    moveCursorTo(panel, "DeepWiki");
    const deepWiki = panel.render(width).map(stripAnsi);
    expect(deepWiki.some((line) => line.includes('+   "mcpServers": {'))).toBe(true);
    expect(deepWiki.some((line) => line.includes('+       "url": "https://mcp.deepwiki.com/mcp",'))).toBe(true);
    renders.push(deepWiki);

    moveCursorTo(panel, "Figma (desktop)");
    panel.handleInput(ENTER);
    await vi.waitFor(() => expect(stripAnsi(panel.render(width).join("\n"))).toContain("Nothing is answering"));
    renders.push(panel.render(width));

    moveCursorTo(panel, "Adopt compatibility imports");
    panel.handleInput(ENTER);
    renders.push(panel.render(width));
    panel.handleInput("\x1b");
    moveCursorTo(panel, "Open config files");
    panel.handleInput(ENTER);
    renders.push(panel.render(width));

    const heights = new Set(renders.map((lines) => lines.length));
    expect([...heights]).toEqual([38]);
    for (const lines of renders) {
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }
    panel.dispose();
  });
});
