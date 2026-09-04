import { Container, Text, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createMcpPanelTheme, McpPanelFrame, type McpPanelTheme } from "./mcp-panel-theme.ts";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import type { ImportKind } from "./types.ts";
import { getConfigDirName } from "./agent-dir.ts";
import { KNOWN_SERVER_PRESETS, type ConfigWritePreview, type KnownServerPreset, type McpDiscoverySummary, type SharedConfigTarget } from "./config.ts";
import type { McpOnboardingState } from "./onboarding-state.ts";

const MIN_PANEL_WIDTH = 24;
const COMPACT_WIDTH = 60;
const COMPACT_ACTION_ROWS = 7;
const DESKTOP_PREVIEW_WIDTH = 74;

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
  previewStarterConfig: (target: SharedConfigTarget) => ConfigWritePreview;
  previewRepoPrompt: (target: SharedConfigTarget) => ConfigWritePreview | null;
  previewKnownServer: (preset: KnownServerPreset, target: SharedConfigTarget) => ConfigWritePreview;
  adoptImports: (imports: ImportKind[]) => Promise<{ added: ImportKind[]; path: string }>;
  scaffoldConfig: (target: SharedConfigTarget) => Promise<{ path: string }>;
  addRepoPrompt: (target: SharedConfigTarget) => Promise<{ path: string; serverName: string }>;
  addKnownServer: (preset: KnownServerPreset, target: SharedConfigTarget) => Promise<{ path: string; serverName: string }>;
  openPath: (path: string) => Promise<void>;
  markSetupCompleted: () => void;
}

export interface SetupPanelOptions {
  mode: "empty" | "setup";
  onboardingState: McpOnboardingState;
  keybindings?: PanelKeybindings;
  theme?: Theme;
}

type Screen = "empty" | "setup" | "imports" | "paths";

type ActionId =
  | "run-setup"
  | "select-shared-target"
  | "adopt-imports"
  | "view-example"
  | "show-precedence"
  | "open-paths"
  | "add-repoprompt"
  | "add-known-server"
  | "scaffold-shared-config"
  | "close";

interface Action {
  id: ActionId;
  label: string;
  preset?: KnownServerPreset;
  target?: SharedConfigTarget;
}

interface McpSetupPanelViewState {
  screen: Screen;
  actionCursor: number;
  importCursor: number;
  pathCursor: number;
  sharedConfigTarget: SharedConfigTarget;
  selectedImports: ReadonlySet<ImportKind>;
  notice: { text: string; tone: "success" | "warning" | "muted" } | null;
  onboardingState: McpOnboardingState;
  discovery: McpDiscoverySummary;
  actions: readonly Action[];
  detectedPaths: readonly string[];
}

/**
 * The setup view owns component composition and display formatting. The panel
 * below remains the controller for input routing, async actions, and timers.
 */
class McpSetupPanelView implements Component {
  private readonly container = new Container();

  constructor(
    private readonly getState: () => McpSetupPanelViewState,
    private readonly callbacks: SetupPanelCallbacks,
    private readonly theme: McpPanelTheme,
  ) {}

  render(width: number): string[] {
    const panelWidth = Math.max(MIN_PANEL_WIDTH, width);
    const innerWidth = panelWidth - 2;
    const contentWidth = this.contentWidth(innerWidth);
    const state = this.getState();
    this.container.clear();

    this.addFrame("┌", "┐");
    this.addRow(this.theme.title("MCP setup"), innerWidth);
    let discoveryTone = this.theme.hint;
    if (!state.discovery.hasAnyConfig || (state.discovery.totalServerCount === 0 && (state.discovery.imports.length > 0 || !!state.discovery.repoPrompt.executablePath))) {
      discoveryTone = this.theme.needsAuth;
    }
    for (const line of wrapText(this.discoverySummaryLine(state), contentWidth)) {
      this.addRow(discoveryTone(line), innerWidth);
    }
    for (const line of wrapText(this.secondarySummaryLine(state), contentWidth)) {
      this.addRow(this.theme.description(this.theme.italic(line)), innerWidth);
    }
    this.addRow("", innerWidth);

    if (state.notice) {
      let tone = this.theme.hint;
      if (state.notice.tone === "success") {
        tone = this.theme.confirm;
      } else if (state.notice.tone === "warning") {
        tone = this.theme.needsAuth;
      }
      for (const line of wrapText(state.notice.text, contentWidth)) {
        this.addRow(tone(line), innerWidth);
      }
      this.addRow("", innerWidth);
    }

    this.addFrame("├", "┤");
    if (state.screen === "imports") {
      for (const line of this.renderImports(state, innerWidth)) this.addRow(line, innerWidth);
    } else if (state.screen === "paths") {
      for (const line of this.renderPaths(state)) this.addRow(line, innerWidth);
    } else {
      for (const line of this.renderActions(state, innerWidth)) this.addRow(line, innerWidth);
    }
    this.addFrame("└", "┘");
    return this.container.render(panelWidth);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  private addFrame(left: string, right: string): void {
    this.container.addChild(new McpPanelFrame(this.theme, left, right));
  }

  private addRow(content: string, innerWidth: number): void {
    this.container.addChild(new Text(this.padLine(content, innerWidth), 0, 0));
  }

  private renderActions(state: McpSetupPanelViewState, innerWidth: number): string[] {
    const lines: string[] = [];
    const actions = state.actions;
    const compact = innerWidth < COMPACT_WIDTH;
    const { start, end } = compact
      ? this.visibleActionRange(actions.length, state.actionCursor)
      : { start: 0, end: actions.length };

    if (start > 0) {
      lines.push(this.theme.description(`… ${start} more above`));
    }
    for (let index = start; index < end; index++) {
      const action = actions[index];
      if (!action) continue;
      if (action.id === "select-shared-target" && (index === start || actions[index - 1]?.id !== "select-shared-target")) {
        lines.push(this.theme.title("Choose where new shared servers go"));
      }
      if (action.id === "add-known-server" && (index === start || actions[index - 1]?.id !== "add-known-server")) {
        lines.push(this.theme.title(`Add a known server to ${this.sharedTargetLabel(state)}`));
      }
      const selected = index === state.actionCursor;
      const cursor = selected ? this.theme.selected("›") : " ";
      lines.push(`${cursor} ${truncateToWidth(action.label, this.contentWidth(innerWidth) - 2)}`);
    }
    if (end < actions.length) {
      lines.push(this.theme.description(`… ${actions.length - end} more below`));
    }
    lines.push("");

    const preview = this.getActionPreview(state, actions[state.actionCursor], this.previewWidth(innerWidth));
    lines.push(...preview);
    lines.push("");
    const hint = compact ? "Enter select · Esc back" : "Enter selects, Esc goes back, Ctrl+C closes.";
    lines.push(this.theme.description(hint));
    return lines;
  }

  private renderImports(state: McpSetupPanelViewState, innerWidth: number): string[] {
    const lines: string[] = [];
    lines.push("Select compatibility imports. Space toggles, Enter saves, Esc goes back.");
    lines.push("");
    for (let index = 0; index < state.discovery.imports.length; index++) {
      const entry = state.discovery.imports[index];
      if (!entry) continue;
      const selected = state.selectedImports.has(entry.kind) ? "[x]" : "[ ]";
      const cursor = index === state.importCursor ? this.theme.selected("›") : " ";
      lines.push(`${cursor} ${selected} ${entry.kind}  ${entry.path}`);
    }
    lines.push("");
    const selected = state.discovery.imports
      .filter((entry) => state.selectedImports.has(entry.kind))
      .map((entry) => entry.kind);
    const preview = this.callbacks.previewImports(selected);
    lines.push(...this.formatWritePreview("Compatibility import write preview", preview, [], this.previewWidth(innerWidth)));
    return lines;
  }

  private renderPaths(state: McpSetupPanelViewState): string[] {
    const lines: string[] = [];
    lines.push("Select a detected config path to open. Enter opens it, Esc goes back.");
    lines.push("");
    for (let index = 0; index < state.detectedPaths.length; index++) {
      const path = state.detectedPaths[index];
      const cursor = index === state.pathCursor ? this.theme.selected("›") : " ";
      if (path !== undefined) lines.push(`${cursor} ${path}`);
    }
    return lines;
  }

  private discoverySummaryLine(state: McpSetupPanelViewState): string {
    if (!state.discovery.hasAnyConfig) {
      return state.onboardingState.setupCompleted
        ? "No MCP servers are active right now."
        : "No MCP config is active yet.";
    }

    if (state.discovery.totalServerCount === 0 && (state.discovery.imports.length > 0 || !!state.discovery.repoPrompt.executablePath)) {
      return "Pi found MCP-related setup options, but none are active in Pi yet.";
    }

    const shared = state.discovery.sources.filter((source) => source.kind === "shared" && source.serverCount > 0).length;
    const piOwned = state.discovery.sources.filter((source) => source.kind === "pi" && source.serverCount > 0).length;
    return `Detected ${state.discovery.totalServerCount} configured servers across ${shared} shared and ${piOwned} Pi-owned source${shared + piOwned === 1 ? "" : "s"}.`;
  }

  private secondarySummaryLine(state: McpSetupPanelViewState): string {
    const hostNote = state.discovery.hostConfigs.length > 0
      ? ` Host discovery is ${state.discovery.hostConfigDiscovery}; ${state.discovery.hostConfigs.length} host source${state.discovery.hostConfigs.length === 1 ? "" : "s"} detected.`
      : "";
    const conflictNote = state.discovery.conflicts.length > 0
      ? ` ${state.discovery.conflicts.length} same-name conflict${state.discovery.conflicts.length === 1 ? "" : "s"} reported.`
      : "";
    if (!state.discovery.hasAnyConfig) {
      return `Add shared servers to .mcp.json for this project/team or ~/.config/mcp/mcp.json for all projects. Adopt host imports or quick-add RepoPrompt from this screen.${hostNote}${conflictNote}`;
    }
    if (state.discovery.totalServerCount === 0 && state.discovery.imports.length > 0) {
      return `Detected ${state.discovery.imports.length} compatibility import source${state.discovery.imports.length === 1 ? "" : "s"}. Adopt them into Pi or inspect the underlying files.${hostNote}${conflictNote}`;
    }
    return `Use .mcp.json for project/team servers or ~/.config/mcp/mcp.json for all projects. Pi-owned files are for compatibility imports and adapter-specific overrides, not another normal setup path.${hostNote}${conflictNote}`;
  }

  private visibleActionRange(total: number, cursor: number): { start: number; end: number } {
    if (total <= COMPACT_ACTION_ROWS) return { start: 0, end: total };
    const half = Math.floor(COMPACT_ACTION_ROWS / 2);
    const start = Math.min(Math.max(0, cursor - half), Math.max(0, total - COMPACT_ACTION_ROWS));
    return { start, end: Math.min(total, start + COMPACT_ACTION_ROWS) };
  }

  private contentWidth(innerWidth: number): number {
    return Math.max(8, innerWidth - 4);
  }

  private previewWidth(innerWidth: number): number {
    return Math.max(12, Math.min(DESKTOP_PREVIEW_WIDTH, this.contentWidth(innerWidth)));
  }

  private sharedTargetLabel(state: McpSetupPanelViewState): string {
    return state.sharedConfigTarget === "project" ? "project .mcp.json" : "global ~/.config/mcp/mcp.json";
  }

  private getActionPreview(state: McpSetupPanelViewState, action?: Action, previewW = DESKTOP_PREVIEW_WIDTH): string[] {
    switch (action?.id) {
      case "run-setup":
        return this.formatPreview([
          "Run setup to adopt host-specific imports, inspect detected paths, and scaffold a minimal `.mcp.json` if needed.",
        ], previewW);
      case "adopt-imports":
        return this.formatWritePreview(
          "Compatibility import write preview",
          this.callbacks.previewImports(state.discovery.imports
            .filter((entry) => state.selectedImports.has(entry.kind))
            .map((entry) => entry.kind)),
          [
            `Detected imports: ${state.discovery.imports.map((entry) => `${entry.kind} (${entry.serverCount} servers)`).join(", ")}`,
            "Selected imports are written into the Pi agent dir config as Pi-owned compatibility state.",
          ],
          previewW,
        );
      case "select-shared-target":
        return this.formatPreview([
          action.target === "project" ? "Project target: .mcp.json" : "Global target: ~/.config/mcp/mcp.json",
          "Known server presets and starter configs will be written to the selected normal MCP setup path.",
          "Pi-owned mcp.json files remain compatibility and adapter-only override state.",
        ], previewW);
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
          "Use Scaffold selected config when you want a safe empty shell instead of a live example server.",
        ], previewW);
      case "show-precedence":
        return this.formatPreview([
          "Recommended shared config:",
          "  project/team: .mcp.json",
          "  all projects: ~/.config/mcp/mcp.json",
          "",
          "Advanced compatibility and Pi-owned layers:",
          "  host imports, .agents files, package MCP manifests, and Pi overrides",
          "",
          "Read order (later entries win):",
          "0. detected host configs (opt-in lowest-precedence fallback)",
          "1. ~/.config/mcp/mcp.json",
          "2. ~/.agents/mcp.json",
          "3. ~/.agents/mcp/mcp.json",
          "4. <Pi agent dir>/mcp.json",
          "5. .mcp.json",
          `6. ${getConfigDirName()}/mcp.json`,
          `Host discovery: ${state.discovery.hostConfigDiscovery}. Conflicts reported: ${state.discovery.conflicts.length}.`,
          ...state.discovery.conflicts.slice(0, 8).map((conflict) =>
            `${conflict.serverName}: ${conflict.sources.map((source) => source.path).join(" -> ")} (winner: ${conflict.winner.path})`,
          ),
          "Pi writes compatibility imports and adapter-only overrides to Pi-owned files.",
        ], previewW);
      case "open-paths":
        return this.formatPreview(state.detectedPaths.length > 0
          ? ["Detected paths:", ...state.detectedPaths]
          : ["No config paths were detected."], previewW);
      case "add-repoprompt": {
        const repoPrompt = state.discovery.repoPrompt;
        const preview = this.callbacks.previewRepoPrompt(state.sharedConfigTarget);
        if (!preview) {
          return this.formatPreview(["RepoPrompt is not available to add from this setup screen."], previewW);
        }
        return this.formatWritePreview(
          "RepoPrompt write preview",
          preview,
          [
            `Executable: ${repoPrompt.executablePath ?? "not found"}`,
            `Target: ${this.sharedTargetLabel(state)}`,
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
          this.callbacks.previewKnownServer(preset, state.sharedConfigTarget),
          [preset.summary, `Target: ${this.sharedTargetLabel(state)}`],
          previewW,
        );
      }
      case "scaffold-shared-config":
        return this.formatWritePreview(
          `${this.sharedTargetLabel(state)} starter write preview`,
          this.callbacks.previewStarterConfig(state.sharedConfigTarget),
          [
            "This writes a minimal config at the selected normal MCP setup path.",
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
    for (const line of lines) preview.push(...wrapText(line, width));
    return preview;
  }

  private formatWritePreview(title: string, preview: ConfigWritePreview, intro: string[] = [], width = DESKTOP_PREVIEW_WIDTH): string[] {
    const lines: string[] = [];
    for (const line of intro) lines.push(...wrapText(line, width));
    if (intro.length > 0) lines.push("");
    lines.push(...wrapText(`${title}: ${preview.path}`, width));
    lines.push(...wrapText(preview.existed ? "Existing file detected. Showing exact before/after diff." : "New file will be created. Showing exact content diff.", width));
    lines.push("");
    const diffLines = preview.diffText.split("\n");
    const maxLines = 18;
    const shown = diffLines.slice(0, maxLines);
    for (const line of shown) lines.push(...wrapText(line, width));
    if (diffLines.length > maxLines) {
      lines.push(...wrapText(`… ${diffLines.length - maxLines} more diff line${diffLines.length - maxLines === 1 ? "" : "s"}`, width));
    }
    return lines;
  }

  private padLine(text: string, innerWidth: number): string {
    const inset = 2;
    const contentWidth = Math.max(0, innerWidth - inset * 2);
    const fitted = truncateToWidth(text, contentWidth, "…", true);
    const padding = Math.max(0, contentWidth - visibleWidth(fitted));
    return `${this.theme.border("│")}${" ".repeat(inset)}${fitted}${" ".repeat(padding)}${" ".repeat(inset)}${this.theme.border("│")}`;
  }
}

export class McpSetupPanel {
  private screen: Screen;
  private actionCursor = 0;
  private importCursor = 0;
  private pathCursor = 0;
  private sharedConfigTarget: SharedConfigTarget = "project";
  private selectedImports = new Set<ImportKind>();
  private busy = false;
  private notice: { text: string; tone: "success" | "warning" | "muted" } | null = null;
  private tui: { requestRender(): void };
  private readonly view: McpSetupPanelView;
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
    this.view = new McpSetupPanelView(() => this.getViewState(), callbacks, createMcpPanelTheme(options.theme));
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
      actions.push({ id: "run-setup", label: "Run setup" });
    }
    if (this.discovery.imports.length > 0) {
      actions.push({ id: "adopt-imports", label: "Adopt detected compatibility imports" });
    }
    actions.push(
      { id: "select-shared-target", label: `${this.sharedConfigTarget === "project" ? "●" : "○"} Add to this project (.mcp.json)`, target: "project" },
      { id: "select-shared-target", label: `${this.sharedConfigTarget === "global" ? "●" : "○"} Add globally (~/.config/mcp/mcp.json)`, target: "global" },
    );
    actions.push({ id: "view-example", label: "View example shared config" });
    if (!this.selectedSharedConfigExists()) {
      actions.push({ id: "scaffold-shared-config", label: `Scaffold ${this.sharedTargetLabel()}` });
    }
    actions.push({ id: "show-precedence", label: "Explain config precedence" });
    if (this.getDetectedPaths().length > 0) {
      actions.push({ id: "open-paths", label: "Open detected config paths" });
    }
    for (const preset of KNOWN_SERVER_PRESETS) {
      actions.push({ id: "add-known-server", label: preset.name, preset });
    }
    if (!this.discovery.repoPrompt.configured && this.discovery.repoPrompt.executablePath && this.discovery.repoPrompt.targetPath && this.discovery.repoPrompt.entry && this.discovery.repoPrompt.serverName) {
      actions.push({ id: "add-repoprompt", label: "Add RepoPrompt to selected shared config" });
    }
    actions.push({ id: "close", label: "Close" });
    return actions;
  }

  private getDetectedPaths(): string[] {
    const paths = [
      ...this.discovery.sources.filter((source) => source.exists).map((source) => source.path),
      ...this.discovery.imports.map((entry) => entry.path),
    ];
    return [...new Set(paths)];
  }

  private sharedTargetLabel(): string {
    return this.sharedConfigTarget === "project" ? "project .mcp.json" : "global ~/.config/mcp/mcp.json";
  }

  private selectedSharedConfigExists(): boolean {
    const sourceId = this.sharedConfigTarget === "project" ? "shared-project" : "shared-global";
    return this.discovery.sources.some((source) => source.id === sourceId && source.exists);
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
      const selected = actions[this.actionCursor];
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
    if (action.id === "select-shared-target" && action.target) {
      this.sharedConfigTarget = action.target;
      this.notice = { text: `New shared servers will be written to ${this.sharedTargetLabel()}.`, tone: "muted" };
      this.tui.requestRender();
      return;
    }
    if (action.id === "scaffold-shared-config") {
      await this.runBusy(async () => {
        const result = await this.callbacks.scaffoldConfig(this.sharedConfigTarget);
        this.callbacks.markSetupCompleted();
        this.notice = { text: `Wrote starter config to ${result.path}. Pi will reload after this panel closes.`, tone: "success" };
      });
      return;
    }
    if (action.id === "add-repoprompt") {
      await this.runBusy(async () => {
        const result = await this.callbacks.addRepoPrompt(this.sharedConfigTarget);
        this.callbacks.markSetupCompleted();
        this.notice = { text: `Added ${result.serverName} to ${result.path}. Pi will reload after this panel closes.`, tone: "success" };
      });
      return;
    }
    if (action.id === "add-known-server" && action.preset) {
      const preset = action.preset;
      await this.runBusy(async () => {
        const result = await this.callbacks.addKnownServer(preset, this.sharedConfigTarget);
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

  private getViewState(): McpSetupPanelViewState {
    return {
      screen: this.screen,
      actionCursor: this.actionCursor,
      importCursor: this.importCursor,
      pathCursor: this.pathCursor,
      sharedConfigTarget: this.sharedConfigTarget,
      selectedImports: this.selectedImports,
      notice: this.notice,
      onboardingState: this.options.onboardingState,
      discovery: this.discovery,
      actions: this.getActions(),
      detectedPaths: this.getDetectedPaths(),
    };
  }

  render(width: number): string[] {
    return this.view.render(width);
  }

  invalidate(): void {
    this.view.invalidate();
  }

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
