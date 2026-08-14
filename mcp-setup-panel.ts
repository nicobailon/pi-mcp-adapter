import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import type { ImportKind } from "./types.ts";
import { getConfigDirName } from "./agent-dir.ts";
import { KNOWN_SERVER_PRESETS, type ConfigWritePreview, type KnownServerPreset, type McpDiscoverySummary } from "./config.ts";
import type { McpOnboardingState } from "./onboarding-state.ts";

interface SetupTheme {
  border: string;
  title: string;
  selected: string;
  hint: string;
  success: string;
  warning: string;
  muted: string;
}

const DEFAULT_THEME: SetupTheme = {
  border: "2",
  title: "36",
  selected: "32",
  hint: "2",
  success: "32",
  warning: "33",
  muted: "2;3",
};

const MIN_PANEL_WIDTH = 24;
const COMPACT_WIDTH = 60;
const COMPACT_ACTION_ROWS = 7;
const DESKTOP_PREVIEW_WIDTH = 74;

function fg(code: string, text: string): string {
  return code ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function wrapText(text: string, width: number): string[] {
  if (width <= 8) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export interface SetupPanelCallbacks {
  previewImports: (imports: ImportKind[]) => ConfigWritePreview;
  previewStarterProject: () => ConfigWritePreview;
  previewRepoPrompt: () => ConfigWritePreview | null;
  previewKnownServer: (preset: KnownServerPreset) => ConfigWritePreview;
  adoptImports: (imports: ImportKind[]) => Promise<{ added: ImportKind[]; path: string }>;
  scaffoldProjectConfig: () => Promise<{ path: string }>;
  addRepoPrompt: () => Promise<{ path: string; serverName: string }>;
  addKnownServer: (preset: KnownServerPreset) => Promise<{ path: string; serverName: string }>;
  openPath: (path: string) => Promise<void>;
  markSetupCompleted: () => void;
}

export interface SetupPanelOptions {
  mode: "empty" | "setup";
  onboardingState: McpOnboardingState;
  keybindings?: PanelKeybindings;
}

type Screen = "empty" | "setup" | "imports" | "paths";

type ActionId =
  | "run-setup"
  | "adopt-imports"
  | "view-example"
  | "show-precedence"
  | "open-paths"
  | "add-repoprompt"
  | "add-known-server"
  | "scaffold-project"
  | "close";

interface Action {
  id: ActionId;
  label: string;
  description: string;
  preset?: KnownServerPreset;
}

export class McpSetupPanel {
  private screen: Screen;
  private actionCursor = 0;
  private importCursor = 0;
  private pathCursor = 0;
  private selectedImports = new Set<ImportKind>();
  private busy = false;
  private notice: { text: string; tone: "success" | "warning" | "muted" } | null = null;
  private tui: { requestRender(): void };
  private t = DEFAULT_THEME;
  private keys: PanelKeys;
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    private discovery: McpDiscoverySummary,
    private callbacks: SetupPanelCallbacks,
    private options: SetupPanelOptions,
    tui: { requestRender(): void },
    private done: () => void,
  ) {
    this.tui = tui;
    this.keys = createPanelKeys(options.keybindings);
    this.screen = options.mode;
    for (const entry of discovery.imports) {
      this.selectedImports.add(entry.kind);
    }
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.done();
    }, McpSetupPanel.INACTIVITY_MS);
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  private getActions(): Action[] {
    const actions: Action[] = [];
    if (this.screen === "empty") {
      actions.push({ id: "run-setup", label: "Run setup", description: "Inspect detected configs, adopt imports, and scaffold a minimal `.mcp.json`." });
    }
    if (this.discovery.imports.length > 0) {
      actions.push({ id: "adopt-imports", label: "Adopt detected compatibility imports", description: `Choose which host-specific MCP configs Pi should import into its own override file. ${this.discovery.imports.length} source${this.discovery.imports.length === 1 ? "" : "s"} found.` });
    }
    actions.push({ id: "view-example", label: "View example `.mcp.json`", description: "Preview a working shared MCP config you can paste or adapt." });
    if (!this.discovery.sources.some((source) => source.id === "shared-project" && source.exists)) {
      actions.push({ id: "scaffold-project", label: "Scaffold project `.mcp.json`", description: "Write a minimal project config using the standard shared MCP file path, then reload Pi." });
    }
    actions.push({ id: "show-precedence", label: "Explain config precedence", description: "Show the read order and where Pi writes compatibility settings." });
    if (this.getDetectedPaths().length > 0) {
      actions.push({ id: "open-paths", label: "Open detected config paths", description: "Browse the actual config files that Pi discovered on this machine." });
    }
    for (const preset of KNOWN_SERVER_PRESETS) {
      actions.push({ id: "add-known-server", label: preset.name, description: preset.summary, preset });
    }
    if (!this.discovery.repoPrompt.configured && this.discovery.repoPrompt.executablePath && this.discovery.repoPrompt.targetPath && this.discovery.repoPrompt.entry && this.discovery.repoPrompt.serverName) {
      actions.push({ id: "add-repoprompt", label: "Add RepoPrompt to shared MCP config", description: "Write a standard MCP entry for RepoPrompt to the recommended shared target, then reload MCP in-session." });
    }
    actions.push({ id: "close", label: "Close", description: "Exit the onboarding flow." });
    return actions;
  }

  private getDetectedPaths(): string[] {
    const paths = [
      ...this.discovery.sources.filter((source) => source.exists).map((source) => source.path),
      ...this.discovery.imports.map((entry) => entry.path),
    ];
    return [...new Set(paths)];
  }

  private getSelectedAction(): Action | undefined {
    const actions = this.getActions();
    return actions[this.actionCursor];
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();
    if (!this.busy) this.notice = null;

    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.screen === "imports" || this.screen === "paths") {
        this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
        this.tui.requestRender();
        return;
      }
      this.cleanup();
      this.done();
      return;
    }

    if (this.busy) return;

    if (this.screen === "imports") {
      this.handleImportsInput(data);
      return;
    }
    if (this.screen === "paths") {
      this.handlePathsInput(data);
      return;
    }

    const actions = this.getActions();
    if (this.keys.selectUp(data)) {
      this.actionCursor = Math.max(0, this.actionCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectDown(data)) {
      this.actionCursor = Math.min(actions.length - 1, this.actionCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectConfirm(data)) {
      const selected = this.getSelectedAction();
      if (selected) void this.runAction(selected);
    }
  }

  private handleImportsInput(data: string): void {
    const imports = this.discovery.imports;
    if (this.keys.selectUp(data)) {
      this.importCursor = Math.max(0, this.importCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectDown(data)) {
      this.importCursor = Math.min(imports.length - 1, this.importCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "space")) {
      const current = imports[this.importCursor];
      if (!current) return;
      if (this.selectedImports.has(current.kind)) {
        this.selectedImports.delete(current.kind);
      } else {
        this.selectedImports.add(current.kind);
      }
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectConfirm(data)) {
      void this.applySelectedImports();
    }
  }

  private handlePathsInput(data: string): void {
    const paths = this.getDetectedPaths();
    if (this.keys.selectUp(data)) {
      this.pathCursor = Math.max(0, this.pathCursor - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectDown(data)) {
      this.pathCursor = Math.min(paths.length - 1, this.pathCursor + 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.selectConfirm(data)) {
      const selected = paths[this.pathCursor];
      if (!selected) return;
      void this.runBusy(async () => {
        await this.callbacks.openPath(selected);
        this.notice = { text: `Opened ${selected}`, tone: "success" };
      });
    }
  }

  private async runAction(action: Action): Promise<void> {
    if (action.id === "run-setup") {
      this.screen = "setup";
      this.actionCursor = 0;
      this.tui.requestRender();
      return;
    }
    if (action.id === "adopt-imports") {
      this.screen = "imports";
      this.importCursor = 0;
      this.tui.requestRender();
      return;
    }
    if (action.id === "open-paths") {
      this.screen = "paths";
      this.pathCursor = 0;
      this.tui.requestRender();
      return;
    }
    if (action.id === "scaffold-project") {
      await this.runBusy(async () => {
        const result = await this.callbacks.scaffoldProjectConfig();
        this.callbacks.markSetupCompleted();
        this.notice = { text: `Wrote starter config to ${result.path}. Pi will reload after this panel closes.`, tone: "success" };
      });
      return;
    }
    if (action.id === "add-repoprompt") {
      await this.runBusy(async () => {
        const result = await this.callbacks.addRepoPrompt();
        this.callbacks.markSetupCompleted();
        this.notice = { text: `Added ${result.serverName} to ${result.path}. Pi will reload after this panel closes.`, tone: "success" };
      });
      return;
    }
    if (action.id === "add-known-server" && action.preset) {
      const preset = action.preset;
      await this.runBusy(async () => {
        const result = await this.callbacks.addKnownServer(preset);
        this.callbacks.markSetupCompleted();
        this.notice = { text: `Added ${result.serverName} to ${result.path}. Pi will reload after this panel closes.`, tone: "success" };
      });
      return;
    }
    if (action.id === "close") {
      this.cleanup();
      this.done();
      return;
    }

    this.notice = { text: "Review the details below. Press Enter on an action with a side effect to apply it.", tone: "muted" };
    this.tui.requestRender();
  }

  private async applySelectedImports(): Promise<void> {
    const selected = this.discovery.imports.filter((entry) => this.selectedImports.has(entry.kind)).map((entry) => entry.kind);
    if (selected.length === 0) {
      this.notice = { text: "Select at least one compatibility import first.", tone: "warning" };
      this.tui.requestRender();
      return;
    }

    await this.runBusy(async () => {
      const result = await this.callbacks.adoptImports(selected);
      this.callbacks.markSetupCompleted();
      this.notice = result.added.length > 0
        ? { text: `Added ${result.added.join(", ")} to ${result.path}. Pi will reload after this panel closes.`, tone: "success" }
        : { text: `No changes needed in ${result.path}.`, tone: "muted" };
      this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
      this.actionCursor = 0;
    });
  }

  private async runBusy(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.notice = { text: "Working...", tone: "muted" };
    this.tui.requestRender();
    try {
      await fn();
    } catch (error) {
      this.notice = {
        text: error instanceof Error ? error.message : String(error),
        tone: "warning",
      };
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const panelW = Math.max(MIN_PANEL_WIDTH, width);
    const innerW = panelW - 2;
    const contentW = this.contentWidth(innerW);
    const lines: string[] = [];
    const border = fg(this.t.border, "─".repeat(innerW));
    lines.push(`┌${border}┐`);
    lines.push(this.padLine(fg(this.t.title, "MCP setup"), innerW));
    for (const line of wrapText(this.discoverySummaryLine(), contentW)) {
      lines.push(this.padLine(line, innerW));
    }
    for (const line of wrapText(this.secondarySummaryLine(), contentW)) {
      lines.push(this.padLine(fg(this.t.muted, line), innerW));
    }
    lines.push(this.padLine("", innerW));

    if (this.notice) {
      const tone = this.notice.tone === "success" ? this.t.success : this.notice.tone === "warning" ? this.t.warning : this.t.hint;
      for (const line of wrapText(this.notice.text, contentW)) {
        lines.push(this.padLine(fg(tone, line), innerW));
      }
      lines.push(this.padLine("", innerW));
    }

    lines.push(`├${border}┤`);

    if (this.screen === "imports") {
      lines.push(...this.renderImports(innerW));
    } else if (this.screen === "paths") {
      lines.push(...this.renderPaths(innerW));
    } else {
      lines.push(...this.renderActions(innerW));
    }

    lines.push(`└${border}┘`);
    return lines;
  }

  private renderActions(innerW: number): string[] {
    const lines: string[] = [];
    const actions = this.getActions();
    const compact = innerW < COMPACT_WIDTH;
    const { start, end } = compact
      ? this.visibleActionRange(actions.length)
      : { start: 0, end: actions.length };

    if (start > 0) {
      lines.push(this.padLine(fg(this.t.muted, `… ${start} more above`), innerW));
    }
    for (let index = start; index < end; index++) {
      const action = actions[index];
      if (!action) continue;
      if (action.id === "add-known-server" && (index === start || actions[index - 1]?.id !== "add-known-server")) {
        lines.push(this.padLine(fg(this.t.title, "Add a known server"), innerW));
      }
      const selected = index === this.actionCursor;
      const cursor = selected ? fg(this.t.selected, "›") : " ";
      lines.push(this.padLine(`${cursor} ${truncateToWidth(action.label, this.contentWidth(innerW) - 2)}`, innerW));
    }
    if (end < actions.length) {
      lines.push(this.padLine(fg(this.t.muted, `… ${actions.length - end} more below`), innerW));
    }
    lines.push(this.padLine("", innerW));

    const preview = this.getActionPreview(this.getSelectedAction(), this.previewWidth(innerW));
    for (const line of preview) {
      lines.push(this.padLine(line, innerW));
    }
    lines.push(this.padLine("", innerW));
    const hint = compact ? "Enter select · Esc back" : "Enter selects, Esc goes back, Ctrl+C closes.";
    lines.push(this.padLine(fg(this.t.muted, hint), innerW));
    return lines;
  }

  private renderImports(innerW: number): string[] {
    const lines: string[] = [];
    lines.push(this.padLine("Select compatibility imports. Space toggles, Enter saves, Esc goes back.", innerW));
    lines.push(this.padLine("", innerW));
    for (let index = 0; index < this.discovery.imports.length; index++) {
      const entry = this.discovery.imports[index];
      if (!entry) continue;
      const selected = this.selectedImports.has(entry.kind) ? "[x]" : "[ ]";
      const cursor = index === this.importCursor ? fg(this.t.selected, "›") : " ";
      lines.push(this.padLine(`${cursor} ${selected} ${entry.kind}  ${entry.path}`, innerW));
    }
    lines.push(this.padLine("", innerW));
    const selected = this.discovery.imports.filter((entry) => this.selectedImports.has(entry.kind)).map((entry) => entry.kind);
    const preview = this.callbacks.previewImports(selected);
    for (const line of this.formatWritePreview("Compatibility import write preview", preview, [], this.previewWidth(innerW))) {
      lines.push(this.padLine(line, innerW));
    }
    return lines;
  }

  private renderPaths(innerW: number): string[] {
    const lines: string[] = [];
    lines.push(this.padLine("Select a detected config path to open. Enter opens it, Esc goes back.", innerW));
    lines.push(this.padLine("", innerW));
    const paths = this.getDetectedPaths();
    for (let index = 0; index < paths.length; index++) {
      const cursor = index === this.pathCursor ? fg(this.t.selected, "›") : " ";
      const path = paths[index];
      if (path !== undefined) lines.push(this.padLine(`${cursor} ${path}`, innerW));
    }
    return lines;
  }

  private discoverySummaryLine(): string {
    if (!this.discovery.hasAnyConfig) {
      return fg(this.t.warning, this.options.onboardingState.setupCompleted
        ? "No MCP servers are active right now."
        : "No MCP config is active yet.");
    }

    if (this.discovery.totalServerCount === 0 && (this.discovery.imports.length > 0 || !!this.discovery.repoPrompt.executablePath)) {
      return fg(this.t.warning, "Pi found MCP-related setup options, but none are active in Pi yet.");
    }

    const shared = this.discovery.sources.filter((source) => source.kind === "shared" && source.serverCount > 0).length;
    const piOwned = this.discovery.sources.filter((source) => source.kind === "pi" && source.serverCount > 0).length;
    return fg(this.t.hint, `Detected ${this.discovery.totalServerCount} configured servers across ${shared} shared and ${piOwned} Pi-owned source${shared + piOwned === 1 ? "" : "s"}.`);
  }

  private secondarySummaryLine(): string {
    const hostNote = this.discovery.hostConfigs.length > 0
      ? ` Host discovery is ${this.discovery.hostConfigDiscovery}; ${this.discovery.hostConfigs.length} host source${this.discovery.hostConfigs.length === 1 ? "" : "s"} detected.`
      : "";
    const conflictNote = this.discovery.conflicts.length > 0
      ? ` ${this.discovery.conflicts.length} same-name conflict${this.discovery.conflicts.length === 1 ? "" : "s"} reported.`
      : "";
    if (!this.discovery.hasAnyConfig) {
      return `Create a shared .mcp.json, adopt host imports, or quick-add RepoPrompt from this screen.${hostNote}${conflictNote}`;
    }
    if (this.discovery.totalServerCount === 0 && this.discovery.imports.length > 0) {
      return `Detected ${this.discovery.imports.length} compatibility import source${this.discovery.imports.length === 1 ? "" : "s"}. Adopt them into Pi or inspect the underlying files.${hostNote}${conflictNote}`;
    }
    return `Shared MCP files are preferred. Pi-owned files are only for compatibility imports and adapter-specific overrides.${hostNote}${conflictNote}`;
  }

  private visibleActionRange(total: number): { start: number; end: number } {
    if (total <= COMPACT_ACTION_ROWS) return { start: 0, end: total };
    const half = Math.floor(COMPACT_ACTION_ROWS / 2);
    const start = Math.min(Math.max(0, this.actionCursor - half), Math.max(0, total - COMPACT_ACTION_ROWS));
    return { start, end: Math.min(total, start + COMPACT_ACTION_ROWS) };
  }

  private contentWidth(innerW: number): number {
    return Math.max(8, innerW - 4);
  }

  private previewWidth(innerW: number): number {
    return Math.max(12, Math.min(DESKTOP_PREVIEW_WIDTH, this.contentWidth(innerW)));
  }

  private getActionPreview(action?: Action, previewW = DESKTOP_PREVIEW_WIDTH): string[] {
    switch (action?.id) {
      case "run-setup":
        return this.formatPreview([
          "Run setup to adopt host-specific imports, inspect detected paths, and scaffold a minimal `.mcp.json` if needed.",
        ], previewW);
      case "adopt-imports":
        return this.formatWritePreview(
          "Compatibility import write preview",
          this.callbacks.previewImports(this.discovery.imports.filter((entry) => this.selectedImports.has(entry.kind)).map((entry) => entry.kind)),
          [
            `Detected imports: ${this.discovery.imports.map((entry) => `${entry.kind} (${entry.serverCount} servers)`).join(", ")}`,
            "Selected imports are written into the Pi agent dir config as Pi-owned compatibility state.",
          ],
          previewW,
        );
      case "view-example":
        return this.formatPreview([
          "Example shared `.mcp.json`:",
          "{",
          '  "mcpServers": {',
          '    "chrome-devtools": {',
          '      "command": "npx",',
          '      "args": ["-y", "chrome-devtools-mcp@1.6.0"]',
          "    }",
          "  }",
          "}",
          "",
          "Use Scaffold project `.mcp.json` when you want a safe empty shell instead of a live example server.",
        ], previewW);
      case "show-precedence":
        return this.formatPreview([
          "Read order (later entries win):",
          "0. detected host configs (opt-in lowest-precedence fallback)",
          "1. ~/.config/mcp/mcp.json",
          "2. ~/.agents/mcp.json",
          "3. ~/.agents/mcp/mcp.json",
          "4. <Pi agent dir>/mcp.json",
          "5. .mcp.json",
          `6. ${getConfigDirName()}/mcp.json`,
          `Host discovery: ${this.discovery.hostConfigDiscovery}. Conflicts reported: ${this.discovery.conflicts.length}.`,
          ...this.discovery.conflicts.slice(0, 8).map((conflict) =>
            `${conflict.serverName}: ${conflict.sources.map((source) => source.path).join(" -> ")} (winner: ${conflict.winner.path})`,
          ),
          "Pi writes compatibility imports and adapter-only overrides to Pi-owned files."
        ], previewW);
      case "open-paths":
        return this.formatPreview(this.getDetectedPaths().length > 0
          ? ["Detected paths:", ...this.getDetectedPaths()]
          : ["No config paths were detected."], previewW);
      case "add-repoprompt": {
        const repoPrompt = this.discovery.repoPrompt;
        const preview = this.callbacks.previewRepoPrompt();
        if (!preview) {
          return this.formatPreview(["RepoPrompt is not available to add from this setup screen."], previewW);
        }
        return this.formatWritePreview(
          "RepoPrompt write preview",
          preview,
          [
            `Executable: ${repoPrompt.executablePath ?? "not found"}`,
            `Target: ${repoPrompt.targetPath ?? "n/a"}`,
            `Server name: ${repoPrompt.serverName ?? "repoprompt"}`,
          ],
          previewW,
        );
      }
      case "add-known-server": {
        const preset = action.preset;
        if (!preset) return this.formatPreview(["Known server preset is unavailable."], previewW);
        return this.formatWritePreview(
          `${preset.name} write preview`,
          this.callbacks.previewKnownServer(preset),
          [preset.summary],
          previewW,
        );
      }
      case "scaffold-project":
        return this.formatWritePreview(
          "Starter project `.mcp.json` write preview",
          this.callbacks.previewStarterProject(),
          [
            "This writes a minimal `.mcp.json` in the current project using the shared MCP layout.",
            "It intentionally avoids adding a fake placeholder server that would fail on first reload.",
          ],
          previewW,
        );
      case "close":
      default:
        return this.formatPreview(["Close the setup flow."], previewW);
    }
  }

  private formatPreview(lines: string[], width = DESKTOP_PREVIEW_WIDTH): string[] {
    const preview: string[] = [];
    for (const line of lines) {
      preview.push(...wrapText(line, width));
    }
    return preview;
  }

  private formatWritePreview(title: string, preview: ConfigWritePreview, intro: string[] = [], width = DESKTOP_PREVIEW_WIDTH): string[] {
    const lines: string[] = [];
    for (const line of intro) {
      lines.push(...wrapText(line, width));
    }
    if (intro.length > 0) lines.push("");
    lines.push(...wrapText(`${title}: ${preview.path}`, width));
    lines.push(...wrapText(preview.existed ? "Existing file detected. Showing exact before/after diff." : "New file will be created. Showing exact content diff.", width));
    lines.push("");
    const diffLines = preview.diffText.split("\n");
    const maxLines = 18;
    const shown = diffLines.slice(0, maxLines);
    for (const line of shown) {
      lines.push(...wrapText(line, width));
    }
    if (diffLines.length > maxLines) {
      lines.push(...wrapText(`… ${diffLines.length - maxLines} more diff line${diffLines.length - maxLines === 1 ? "" : "s"}`, width));
    }
    return lines;
  }

  private padLine(text: string, innerW: number): string {
    const inset = 2;
    const contentW = Math.max(0, innerW - inset * 2);
    const fitted = truncateToWidth(text, contentW, "…", true);
    const plainWidth = visibleWidth(fitted);
    const padding = Math.max(0, contentW - plainWidth);
    return `│${" ".repeat(inset)}${fitted}${" ".repeat(padding)}${" ".repeat(inset)}│`;
  }

  invalidate(): void {}

  dispose(): void {
    this.cleanup();
  }
}

export function createMcpSetupPanel(
  discovery: McpDiscoverySummary,
  callbacks: SetupPanelCallbacks,
  options: SetupPanelOptions,
  tui: { requestRender(): void },
  done: () => void,
): McpSetupPanel & { dispose(): void } {
  return new McpSetupPanel(discovery, callbacks, options, tui, done);
}
