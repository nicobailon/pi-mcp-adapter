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
    const terminal = { rows: 40 };
    const panel = createMcpSetupPanel(
      discovery,
      callbacks,
      { mode: "setup", onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false } },
      { requestRender: () => {}, terminal },
      () => {},
    );

    moveCursorTo(panel, "Adopt compatibility imports");
    expect(panel.render(100).join("\n")).toContain("Failed to read MCP config at /tmp/mcp.json");
    // The error leads the details pane, so the small stacked pane of a short, narrow terminal still shows it.
    terminal.rows = 20;
    const narrow = panel.render(60).map(stripAnsi);
    expect(narrow.join("\n")).toContain("Preview unavailable:");
    expect(narrow.join("\n")).toContain("Failed to read MCP config at /tmp/mcp.json");
    expect(narrow.length).toBeLessThanOrEqual(18);
    terminal.rows = 40;
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
    const summaryLine = panel.render(40).find((line) => line.includes("123 servers"));
    expect(summaryLine).toContain("\x1b[38;5;36m");
    panel.dispose();
  });

  it("keeps one height for every cursor position, screen, and notice", async () => {
    const width = 92;
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
    const terminal = { rows: 40 };
    const panel = createMcpSetupPanel(
      discovery,
      callbacks,
      { mode: "setup", onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false } },
      { requestRender: () => {}, terminal },
      () => {},
    );

    const renders: string[][] = [panel.render(width)];
    for (let presses = 0; presses < 20; presses += 1) {
      panel.handleInput(DOWN);
      renders.push(panel.render(width));
    }
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

    // 22 body rows (the cap) plus 7 rows of frame, header, spacers, and footer.
    const heights = new Set(renders.map((lines) => lines.length));
    expect([...heights]).toEqual([29]);
    for (const lines of renders) {
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }

    // Short terminals: the panel fits in rows minus the 2 margin rows and keeps the hints row.
    panel.handleInput("\x1b");
    for (const rows of [16, 12]) {
      terminal.rows = rows;
      const tiny: string[][] = [];
      for (let presses = 0; presses < 20; presses += 1) {
        panel.handleInput(presses < 10 ? DOWN : "\x1b[A");
        tiny.push(panel.render(width));
      }
      expect(new Set(tiny.map((lines) => lines.length)).size).toBe(1);
      for (const lines of tiny) {
        expect(lines.length).toBeLessThanOrEqual(rows - 2);
        expect(stripAnsi(lines.at(-2)!)).toContain("↑↓ move · enter select · esc close");
        expect(stripAnsi(lines.at(-1)!)).toMatch(/^╰─+╯$/);
      }
    }
    panel.dispose();
  });

  it("scrolls cut-off details with PageDown without changing the height", () => {
    const width = 92;
    const configPath = join(tmpdir(), "pi-mcp-setup-panel-missing", ".mcp.json");
    const callbacks = createCallbacks();
    callbacks.previewKnownServer = (preset) => previewSharedServerEntry(configPath, preset.id, preset.entry);
    const panel = createMcpSetupPanel(
      createDiscovery(),
      callbacks,
      { mode: "setup", onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false } },
      { requestRender: () => {}, terminal: { rows: 16 } },
      () => {},
    );
    const lastDiffLine = (lines: string[]) => lines.some((line) => stripAnsi(line).includes("+ }"));

    moveCursorTo(panel, "DeepWiki");
    const before = panel.render(width);
    expect(lastDiffLine(before)).toBe(false);
    expect(stripAnsi(before.join("\n"))).toContain("↓ ");
    expect(stripAnsi(before.at(-2)!)).toContain("pgup/pgdn scroll");
    expect(stripAnsi(panel.render(40).at(-2)!)).toContain("pgup/pgdn scroll");

    for (let presses = 0; presses < 5 && !lastDiffLine(panel.render(width)); presses += 1) panel.handleInput("\x1b[6~");
    const after = panel.render(width);
    expect(lastDiffLine(after)).toBe(true);
    expect(after).toHaveLength(before.length);
    expect(stripAnsi(after.join("\n"))).toContain("↑ ");

    panel.handleInput("\x1b[1;2A");
    expect(lastDiffLine(panel.render(width))).toBe(false);
    // Moving the cursor resets the scroll: back on DeepWiki, the diff starts cut off again.
    panel.handleInput("\x1b[6~");
    expect(lastDiffLine(panel.render(width))).toBe(true);
    panel.handleInput(DOWN);
    panel.handleInput("\x1b[A");
    expect(lastDiffLine(panel.render(width))).toBe(false);
    panel.dispose();
  });

  it("keeps notice text in a one-row details pane", () => {
    const panel = createMcpSetupPanel(
      createDiscovery(),
      createCallbacks(),
      { mode: "setup", onboardingState: { version: 1, sharedConfigHintShown: false, setupCompleted: false } },
      { requestRender: () => {}, terminal: { rows: 10 } },
      () => {},
    );

    panel.handleInput(DOWN);
    panel.handleInput(ENTER);
    const lines = panel.render(60).map(stripAnsi);
    expect(lines.join("\n")).toContain("New shared servers will be written to global");
    expect(lines.length).toBeLessThanOrEqual(8);
    panel.dispose();
  });
});
