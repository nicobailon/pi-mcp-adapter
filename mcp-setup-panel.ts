import { Container, Text, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createMcpPanelTheme, McpPanelFrame, type McpPanelTheme } from "./mcp-panel-theme.ts";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import type { ImportKind } from "./types.ts";
import { getConfigDirName } from "./agent-dir.ts";
import type { ConfigWritePreview, KnownServerPreset, McpDiscoverySummary, SharedConfigTarget } from "./config.ts";
import type { McpOnboardingState } from "./onboarding-state.ts";
import { homedir } from "node:os";
import { basename } from "node:path";

const MIN_PANEL_WIDTH = 24;
/** Blank columns between the frame border and the content on each side. */
const INSET = 2;
/** Below this inner width the list and details stack instead of sitting side by side. */
const TWO_PANE_MIN_INNER_WIDTH = 72;
const MIN_LIST_WIDTH = 30;
const MAX_LIST_WIDTH = 38;
/** Width of the ` │  ` gutter between the list and details panes. */
const PANE_GUTTER = 4;
/** Footer rows reserved for the notice, above the key hints row. */
const FOOTER_NOTICE_ROWS = 2;
/** Rows outside the body: top border, header, blank, blank, separator, notice rows, hints, bottom border. */
const CHROME_ROWS = 7 + FOOTER_NOTICE_ROWS;
/** Body height used when the terminal size is unknown. */
const DEFAULT_BODY_ROWS = 24;
const MIN_BODY_ROWS = 8;
const MAX_BODY_ROWS = 30;
/** Rows kept free above and below the overlay; matches overlayOptions.margin in commands.ts. */
const OVERLAY_VERTICAL_MARGIN = 1;

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

/** Wraps prose, keeping leading indentation and list markers as a hanging indent. */
function wrapIndented(text: string, width: number): string[] {
  const indent = /^\s*(?:\d+\.\s+|[-•]\s+)?/.exec(text)?.[0] ?? "";
  const body = text.slice(indent.length);
  if (!body.trim()) return [text.trimEnd()];
  const indentWidth = visibleWidth(indent);
  return wrapText(body, Math.max(8, width - indentWidth))
    .map((line, index) => `${index === 0 ? indent : " ".repeat(indentWidth)}${line}`);
}

/** Splits text into fixed-width chunks for values like paths that have no spaces to wrap at. */
function hardWrap(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const lines: string[] = [];
  for (let index = 0; index < text.length; index += width) lines.push(text.slice(index, index + width));
  return lines;
}

const graphemes = new Intl.Segmenter();

/**
 * Cuts plain (unstyled) text to `width` columns with a trailing …. Styling is
 * applied after fitting, so no reset codes end up inside the panel.
 */
function fitText(text: string, width: number, pad = false): string {
  let fitted = text;
  if (visibleWidth(text) > width) {
    fitted = "";
    for (const { segment } of graphemes.segment(text)) {
      if (visibleWidth(fitted + segment) > width - 1) break;
      fitted += segment;
    }
    fitted = width > 0 ? `${fitted}…` : "";
  }
  return pad ? `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}` : fitted;
}

function shortenPath(path: string): string {
  const home = homedir();
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export interface SetupPanelCallbacks {
  previewImports: (imports: ImportKind[]) => ConfigWritePreview;
  previewStarterConfig: (target: SharedConfigTarget) => ConfigWritePreview;
  previewRepoPrompt: (target: SharedConfigTarget) => ConfigWritePreview | null;
  previewKnownServer: (preset: KnownServerPreset, target: SharedConfigTarget) => ConfigWritePreview;
  adoptImports: (imports: ImportKind[]) => Promise<{ added: ImportKind[]; path: string }>;
  scaffoldConfig: (target: SharedConfigTarget) => Promise<{ path: string }>;
  addRepoPrompt: (target: SharedConfigTarget) => Promise<{ path: string; serverName: string }>;
  addKnownServer: (preset: KnownServerPreset, target: SharedConfigTarget) => Promise<{ path: string; serverName: string; reachable?: boolean }>;
  openPath: (path: string) => Promise<void>;
  markSetupCompleted: () => void;
}

export interface SetupPanelOptions {
  mode: "empty" | "setup";
  onboardingState: McpOnboardingState;
  keybindings?: PanelKeybindings;
  theme?: Theme;
}

/** The subset of Pi's TUI the setup panel uses. `terminal` sizes the panel to the screen. */
export interface SetupPanelTui {
  requestRender(): void;
  terminal?: { rows: number };
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
  | "scaffold-shared-config";

interface Action {
  id: ActionId;
  label: string;
  /** Muted text shown after the label, such as a config path. */
  detail?: string;
  preset?: KnownServerPreset;
  target?: SharedConfigTarget;
}

type Notice = { text: string; tone: "success" | "warning" | "muted" };

interface McpSetupPanelViewState {
  screen: Screen;
  actionCursor: number;
  importCursor: number;
  pathCursor: number;
  sharedConfigTarget: SharedConfigTarget;
  selectedImports: ReadonlySet<ImportKind>;
  notice: Notice | null;
  onboardingState: McpOnboardingState;
  discovery: McpDiscoverySummary;
  actions: readonly Action[];
  detectedPaths: readonly string[];
  terminalRows?: number | undefined;
}

/** One line of the details pane. `text` is plain; `tone` styles it after it is fitted to the pane. */
interface PaneLine {
  text: string;
  tone?: (text: string) => string;
}

type ListEntry =
  | { kind: "header"; text: string }
  | { kind: "blank" }
  | { kind: "item"; label: string; detail?: string | undefined; selected: boolean };

type ActionSection = "start" | "target" | "servers" | "files";

const SECTION_HEADERS: Record<ActionSection, string | undefined> = {
  start: undefined,
  target: "WRITE NEW SERVERS TO",
  servers: "ADD A SERVER",
  files: "CONFIG FILES",
};

function actionSection(id: ActionId): ActionSection {
  switch (id) {
    case "run-setup":
      return "start";
    case "select-shared-target":
      return "target";
    case "add-known-server":
    case "add-repoprompt":
      return "servers";
    default:
      return "files";
  }
}

/**
 * The setup view owns layout and display formatting. The panel below remains
 * the controller for input routing, async actions, and timers.
 *
 * The rendered height depends only on the terminal height, never on the
 * cursor, screen, or notice, so the overlay does not jump while navigating.
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
    const contentWidth = innerWidth - INSET * 2;
    const state = this.getState();
    const bodyRows = this.bodyRows(state.terminalRows);
    this.container.clear();

    this.addFrame("╭", "╮", "MCP setup");
    this.addRow(this.renderHeader(state, contentWidth), innerWidth);
    this.addRow("", innerWidth);

    const notice = this.layoutNotice(state.notice, contentWidth);
    const entries = this.listEntries(state);
    const noticeLines = notice.overflow && state.notice
      ? (paneWidth: number) => [
        ...wrapIndented(state.notice!.text, paneWidth).map((text) => ({ text, tone: this.noticeTone(state.notice!) })),
        { text: "" },
      ]
      : () => [];
    const details = (paneWidth: number) => [...noticeLines(paneWidth), ...this.details(state, paneWidth)];

    if (innerWidth >= TWO_PANE_MIN_INNER_WIDTH) {
      const listWidth = Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, Math.floor(innerWidth * 0.4)));
      const paneWidth = contentWidth - listWidth - PANE_GUTTER;
      const listLines = this.renderList(entries, bodyRows, listWidth);
      const paneLines = this.renderPane(details(paneWidth), bodyRows, paneWidth);
      const rule = this.theme.border("│");
      for (let row = 0; row < bodyRows; row++) {
        this.addRow(`${listLines[row] ?? " ".repeat(listWidth)} ${rule}  ${paneLines[row] ?? ""}`, innerWidth);
      }
    } else {
      const listRows = Math.min(entries.length, Math.max(3, Math.floor((bodyRows - 1) / 2)));
      const paneRows = bodyRows - 1 - listRows;
      for (const line of this.renderList(entries, listRows, contentWidth)) this.addRow(line, innerWidth);
      this.addRow(this.theme.border("─".repeat(contentWidth)), innerWidth);
      for (const line of this.renderPane(details(contentWidth), paneRows, contentWidth)) this.addRow(line, innerWidth);
    }

    this.addRow("", innerWidth);
    this.addFrame("├", "┤");
    for (const line of notice.lines) this.addRow(line, innerWidth);
    this.addRow(this.theme.hint(fitText(this.keyHints(state.screen), contentWidth)), innerWidth);
    this.addFrame("╰", "╯");
    return this.container.render(panelWidth);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  private bodyRows(terminalRows: number | undefined): number {
    if (!terminalRows || terminalRows <= 0) return DEFAULT_BODY_ROWS;
    const available = terminalRows - OVERLAY_VERTICAL_MARGIN * 2 - CHROME_ROWS;
    return Math.max(MIN_BODY_ROWS, Math.min(MAX_BODY_ROWS, available));
  }

  private addFrame(left: string, right: string, title?: string): void {
    this.container.addChild(new McpPanelFrame(this.theme, left, right, title));
  }

  private addRow(content: string, innerWidth: number): void {
    const contentWidth = Math.max(0, innerWidth - INSET * 2);
    const fitted = truncateToWidth(content, contentWidth, "…", true);
    const padding = Math.max(0, contentWidth - visibleWidth(fitted));
    const inset = " ".repeat(INSET);
    const border = this.theme.border("│");
    this.container.addChild(new Text(`${border}${inset}${fitted}${" ".repeat(padding)}${inset}${border}`, 0, 0));
  }

  private renderHeader(state: McpSetupPanelViewState, width: number): string {
    const { discovery } = state;
    let status: string;
    let tone = this.theme.hint;
    if (!discovery.hasAnyConfig) {
      status = state.onboardingState.setupCompleted ? "No MCP servers are active right now." : "No MCP config is active yet.";
      tone = this.theme.needsAuth;
    } else if (discovery.totalServerCount === 0 && (discovery.imports.length > 0 || !!discovery.repoPrompt.executablePath)) {
      status = "Pi found MCP-related setup options, but none are active in Pi yet.";
      tone = this.theme.needsAuth;
    } else {
      const files = discovery.sources.filter((source) => source.serverCount > 0).length;
      status = `${plural(discovery.totalServerCount, "server")} · ${plural(files, "config file")}`;
    }

    const extras: string[] = [];
    if (discovery.imports.length > 0) extras.push(plural(discovery.imports.length, "import"));
    if (discovery.hostConfigs.length > 0) extras.push(plural(discovery.hostConfigs.length, "host config"));
    if (discovery.conflicts.length > 0) extras.push(plural(discovery.conflicts.length, "conflict"));
    const summary = extras.join(" · ");
    const statusWidth = visibleWidth(status);
    const summaryWidth = visibleWidth(summary);
    if (!summary || statusWidth + 2 + summaryWidth > width) {
      return tone(fitText(status, width));
    }
    return `${tone(status)}${" ".repeat(width - statusWidth - summaryWidth)}${this.theme.hint(summary)}`;
  }

  private noticeTone(notice: Notice): (text: string) => string {
    if (notice.tone === "success") return this.theme.confirm;
    if (notice.tone === "warning") return this.theme.needsAuth;
    return this.theme.hint;
  }

  /**
   * Fits the notice into the fixed footer rows. A notice that needs more rows
   * is cut with … there and shown in full at the top of the details pane.
   */
  private layoutNotice(notice: Notice | null, width: number): { lines: string[]; overflow: boolean } {
    const lines: string[] = [];
    let overflow = false;
    if (notice) {
      const tone = this.noticeTone(notice);
      const wrapped = wrapText(notice.text, width);
      overflow = wrapped.length > FOOTER_NOTICE_ROWS || wrapped.some((line) => visibleWidth(line) > width);
      for (let row = 0; row < FOOTER_NOTICE_ROWS && row < wrapped.length; row++) {
        let text = wrapped[row] ?? "";
        if (row === FOOTER_NOTICE_ROWS - 1 && wrapped.length > FOOTER_NOTICE_ROWS) {
          // Cut at a word boundary so the last footer row ends with " …".
          const words = text.split(" ");
          while (words.length > 1 && visibleWidth(`${words.join(" ")} …`) > width) words.pop();
          text = `${words.join(" ")} …`;
        }
        lines.push(tone(fitText(text, width)));
      }
    }
    while (lines.length < FOOTER_NOTICE_ROWS) lines.push("");
    return { lines, overflow };
  }

  private keyHints(screen: Screen): string {
    if (screen === "imports") return "↑↓ move · space toggle · enter save · esc back";
    if (screen === "paths") return "↑↓ move · enter open · esc back";
    return "↑↓ move · enter select · esc close";
  }

  private listEntries(state: McpSetupPanelViewState): ListEntry[] {
    if (state.screen === "imports") {
      const imports = state.discovery.imports;
      const kindWidth = Math.max(0, ...imports.map((entry) => entry.kind.length));
      return [
        { kind: "header", text: "ADOPT IMPORTS FROM" },
        ...imports.map((entry, index): ListEntry => ({
          kind: "item",
          label: `${state.selectedImports.has(entry.kind) ? "[x]" : "[ ]"} ${entry.kind.padEnd(kindWidth)}`,
          detail: shortenPath(entry.path),
          selected: index === state.importCursor,
        })),
      ];
    }
    if (state.screen === "paths") {
      return [
        { kind: "header", text: "OPEN A CONFIG FILE" },
        ...state.detectedPaths.map((path, index): ListEntry => ({
          kind: "item",
          label: shortenPath(path),
          selected: index === state.pathCursor,
        })),
      ];
    }

    const entries: ListEntry[] = [];
    let section: ActionSection | undefined;
    state.actions.forEach((action, index) => {
      const next = actionSection(action.id);
      if (next !== section) {
        if (section !== undefined) entries.push({ kind: "blank" });
        const header = SECTION_HEADERS[next];
        if (header) entries.push({ kind: "header", text: header });
        section = next;
      }
      entries.push({ kind: "item", label: action.label, detail: action.detail, selected: index === state.actionCursor });
    });
    return entries;
  }

  /** Renders exactly `rows` list lines, scrolling to keep the selected item visible. */
  private renderList(entries: ListEntry[], rows: number, width: number): string[] {
    let start = 0;
    if (entries.length > rows) {
      const cursor = Math.max(0, entries.findIndex((entry) => entry.kind === "item" && entry.selected));
      start = Math.max(0, Math.min(cursor - Math.floor(rows / 2), entries.length - rows));
    }
    const end = Math.min(entries.length, start + rows);
    const hiddenItems = (from: number, to: number) => entries.slice(from, to).filter((entry) => entry.kind === "item").length;
    const lines: string[] = [];
    for (let index = start; index < end; index++) {
      if (index === start && start > 0) {
        lines.push(this.moreLine("↑", hiddenItems(0, start + 1), width));
      } else if (index === end - 1 && end < entries.length) {
        lines.push(this.moreLine("↓", hiddenItems(end - 1, entries.length), width));
      } else {
        lines.push(this.renderEntry(entries[index]!, width));
      }
    }
    while (lines.length < rows) lines.push(" ".repeat(width));
    return lines;
  }

  private moreLine(arrow: string, count: number, width: number): string {
    const text = count > 0 ? `  ${arrow} ${count} more` : "";
    return this.theme.hint(fitText(text, width, true));
  }

  private renderEntry(entry: ListEntry, width: number): string {
    if (entry.kind === "blank") return " ".repeat(width);
    if (entry.kind === "header") return this.theme.description(fitText(entry.text, width, true));

    const cursor = entry.selected ? this.theme.selected("›") : " ";
    const available = width - 2;
    const label = fitText(entry.label, available);
    const styledLabel = entry.selected ? this.theme.selected(this.theme.bold(label)) : label;
    let line = `${cursor} ${styledLabel}`;
    let used = 2 + visibleWidth(label);
    const detailRoom = available - visibleWidth(label) - 2;
    if (entry.detail && detailRoom >= 4) {
      const detail = fitText(entry.detail, detailRoom);
      line += `  ${this.theme.description(detail)}`;
      used += 2 + visibleWidth(detail);
    }
    return `${line}${" ".repeat(Math.max(0, width - used))}`;
  }

  /** Renders exactly `rows` pane lines, cutting long content with a `… N more lines` row. */
  private renderPane(content: PaneLine[], rows: number, width: number): string[] {
    const lines = [...content];
    while (lines.length > 0 && !lines[lines.length - 1]!.text.trim()) lines.pop();
    let shown = lines;
    if (lines.length > rows) {
      const kept = Math.max(0, rows - 1);
      shown = [...lines.slice(0, kept), { text: `… ${plural(lines.length - kept, "more line")}`, tone: this.theme.hint }];
    }
    const rendered = shown.map((line) => {
      const fitted = fitText(line.text, width);
      const styled = line.tone ? line.tone(fitted) : fitted;
      return `${styled}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
    });
    while (rendered.length < rows) rendered.push(" ".repeat(width));
    return rendered;
  }

  private heading(text: string): PaneLine[] {
    return [{ text, tone: (value) => this.theme.selected(this.theme.bold(value)) }, { text: "" }];
  }

  private prose(width: number, ...paragraphs: string[]): PaneLine[] {
    const lines: PaneLine[] = [];
    for (const paragraph of paragraphs) {
      for (const text of wrapIndented(paragraph, width)) lines.push({ text });
    }
    return lines;
  }

  private muted(text: string): PaneLine {
    return { text, tone: this.theme.description };
  }

  private details(state: McpSetupPanelViewState, width: number): PaneLine[] {
    if (state.screen === "imports") return this.importDetails(state, width);
    if (state.screen === "paths") return this.pathDetails(state, width);
    return this.actionDetails(state, state.actions[state.actionCursor], width);
  }

  private importDetails(state: McpSetupPanelViewState, width: number): PaneLine[] {
    const selected = state.discovery.imports
      .filter((entry) => state.selectedImports.has(entry.kind))
      .map((entry) => entry.kind);
    return [
      ...this.heading("Adopt compatibility imports"),
      ...this.prose(width, "Space toggles an import. Enter writes the selected imports to mcp-adapter.json in the Pi agent dir."),
      { text: "" },
      this.muted(`${selected.length} of ${state.discovery.imports.length} selected`),
      ...this.writePreview(() => this.callbacks.previewImports(selected), width),
    ];
  }

  private pathDetails(state: McpSetupPanelViewState, width: number): PaneLine[] {
    const path = state.detectedPaths[state.pathCursor];
    if (path === undefined) return this.prose(width, "No config paths were detected.");
    return [
      ...this.heading(basename(path)),
      ...hardWrap(shortenPath(path), width).map((text) => this.muted(text)),
      { text: "" },
      ...this.prose(width, "Enter opens this file with your system's default app."),
    ];
  }

  private actionDetails(state: McpSetupPanelViewState, action: Action | undefined, width: number): PaneLine[] {
    const { discovery } = state;
    switch (action?.id) {
      case "run-setup":
        return [
          ...this.heading("Run setup"),
          ...this.prose(width, "Adopt host-specific imports, inspect detected paths, and scaffold a minimal .mcp.json if needed."),
        ];
      case "select-shared-target": {
        const project = action.target === "project";
        return [
          ...this.heading(project ? "Project config" : "Global config"),
          this.muted(project ? ".mcp.json" : "~/.config/mcp/mcp.json"),
          { text: "" },
          ...this.prose(
            width,
            project
              ? "Servers here load in this project only. Commit the file to share them with your team."
              : "Servers here load in every project on this machine.",
          ),
          { text: "" },
          ...this.prose(width, "Known servers and starter configs are written to the selected file."),
          { text: "" },
          this.muted(state.sharedConfigTarget === action.target ? "Selected." : "Press enter to write new servers here."),
        ];
      }
      case "add-known-server": {
        const preset = action.preset;
        if (!preset) return this.prose(width, "Known server preset is unavailable.");
        return [
          ...this.heading(preset.name),
          ...this.prose(width, preset.summary),
          ...(preset.desktopApp ? [{ text: "" }, ...this.prose(width, preset.desktopApp.enableSteps)] : []),
          ...this.writePreview(() => this.callbacks.previewKnownServer(preset, state.sharedConfigTarget), width),
        ];
      }
      case "add-repoprompt": {
        const repoPrompt = discovery.repoPrompt;
        const lines = [
          ...this.heading("RepoPrompt"),
          ...this.prose(width, "Adds the RepoPrompt MCP server installed on this machine."),
          { text: "" },
          this.muted(`Executable   ${repoPrompt.executablePath ? shortenPath(repoPrompt.executablePath) : "not found"}`),
          this.muted(`Server name  ${repoPrompt.serverName ?? "repoprompt"}`),
        ];
        const preview = this.previewOrError(() => this.callbacks.previewRepoPrompt(state.sharedConfigTarget), width);
        if (preview === null) return [...lines, { text: "" }, ...this.prose(width, "RepoPrompt is not available to add from this setup screen.")];
        return [...lines, ...preview];
      }
      case "adopt-imports": {
        const selected = discovery.imports
          .filter((entry) => state.selectedImports.has(entry.kind))
          .map((entry) => entry.kind);
        return [
          ...this.heading("Adopt compatibility imports"),
          ...this.prose(
            width,
            `Detected: ${discovery.imports.map((entry) => `${entry.kind} (${plural(entry.serverCount, "server")})`).join(", ")}.`,
            "Selected imports are written to mcp-adapter.json in the Pi agent dir as adapter-owned compatibility state.",
          ),
          ...this.writePreview(() => this.callbacks.previewImports(selected), width),
        ];
      }
      case "scaffold-shared-config":
        return [
          ...this.heading(action.label),
          ...this.prose(width, "Writes a minimal config with no servers, so nothing fails on the first reload."),
          ...this.writePreview(() => this.callbacks.previewStarterConfig(state.sharedConfigTarget), width),
        ];
      case "view-example":
        return [
          ...this.heading("Example config"),
          ...this.prose(width, "A shared .mcp.json with one server:"),
          { text: "" },
          ...[
            "{",
            '  "mcpServers": {',
            '    "chrome-devtools": {',
            '      "command": "npx",',
            '      "args": ["-y", "chrome-devtools-mcp@1.6.0"]',
            "    }",
            "  }",
            "}",
          ].map((text) => this.muted(text)),
          { text: "" },
          ...this.prose(width, "Scaffold writes an empty config instead when you don't want a live example server."),
        ];
      case "show-precedence":
        return [
          ...this.heading("Config precedence"),
          this.muted([
            `Host discovery: ${discovery.hostConfigDiscovery}`,
            ...(discovery.hostConfigs.length > 0 ? [plural(discovery.hostConfigs.length, "host config")] : []),
            plural(discovery.conflicts.length, "conflict"),
          ].join(" · ")),
          ...discovery.conflicts.slice(0, 8).flatMap((conflict) => this.prose(
            width,
            `- ${conflict.serverName}: ${conflict.sources.map((source) => shortenPath(source.path)).join(" -> ")} (winner: ${shortenPath(conflict.winner.path)})`,
          ).map((line) => ({ ...line, tone: this.theme.needsAuth }))),
          { text: "" },
          ...this.prose(
            width,
            "Use .mcp.json for project/team servers or ~/.config/mcp/mcp.json for all projects. mcp-adapter.json files are for compatibility imports and adapter-specific overrides; Pi mcp.json files are not read by the adapter.",
          ),
          { text: "" },
          ...this.prose(width, "Recommended shared config:", "  project/team: .mcp.json", "  all projects: ~/.config/mcp/mcp.json"),
          { text: "" },
          ...this.prose(
            width,
            "Read order (later entries win):",
            "0. detected host configs (opt-in lowest-precedence fallback)",
            "1. ~/.config/mcp/mcp.json",
            "2. ~/.agents/mcp.json",
            "3. ~/.agents/mcp/mcp.json",
            "4. <Pi agent dir>/mcp-adapter.json",
            "5. configured ancestor root to parent(cwd), farthest first (opt-in)",
            `   per directory: .mcp.json, then ${getConfigDirName()}/mcp-adapter.json`,
            "6. cwd/.mcp.json",
            `7. cwd/${getConfigDirName()}/mcp-adapter.json`,
          ),
          { text: "" },
          ...this.prose(
            width,
            "Advanced compatibility and adapter-owned layers:",
            "  host imports, .agents files, package MCP manifests, and Pi overrides",
          ),
        ];
      case "open-paths":
        return [
          ...this.heading("Open config files"),
          ...this.prose(width, "Press enter to pick a detected config file and open it."),
          { text: "" },
          ...state.detectedPaths.map((path) => this.muted(shortenPath(path))),
        ];
      default:
        return [];
    }
  }

  /** Runs a preview callback, turning a thrown error into readable pane lines. */
  private previewOrError(getPreview: () => ConfigWritePreview | null, width: number): PaneLine[] | null {
    let preview: ConfigWritePreview | null;
    try {
      preview = getPreview();
    } catch (error) {
      return [
        { text: "" },
        { text: "Preview unavailable:", tone: this.theme.needsAuth },
        ...this.prose(width, error instanceof Error ? error.message : String(error)),
      ];
    }
    return preview ? this.formatWritePreview(preview) : null;
  }

  private writePreview(getPreview: () => ConfigWritePreview, width: number): PaneLine[] {
    return this.previewOrError(getPreview, width) ?? [];
  }

  /** Diff lines are never word-wrapped: each keeps its indentation and is cut with … at the pane edge. */
  private formatWritePreview(preview: ConfigWritePreview): PaneLine[] {
    const path = shortenPath(preview.path);
    if (preview.existed && !preview.changed) return [{ text: "" }, this.muted(`No changes to ${path}`)];
    const lines: PaneLine[] = [{ text: "" }, this.muted(`${preview.existed ? "Updates" : "Creates"} ${path}`)];
    const diffLines = preview.diffText.split("\n").filter((line) => line !== "--- before" && line !== "+++ after");
    while (diffLines.length > 0 && !diffLines[diffLines.length - 1]!.trim()) diffLines.pop();
    for (const line of diffLines) {
      let tone = this.theme.description;
      if (line.startsWith("+")) tone = this.theme.confirm;
      else if (line.startsWith("-")) tone = this.theme.cancel;
      lines.push({ text: line, tone });
    }
    return lines;
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
  private notice: Notice | null = null;
  private tui: SetupPanelTui;
  private readonly view: McpSetupPanelView;
  private keys: PanelKeys;
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    private discovery: McpDiscoverySummary,
    private callbacks: SetupPanelCallbacks,
    private options: SetupPanelOptions,
    tui: SetupPanelTui,
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
    actions.push(
      { id: "select-shared-target", label: `${this.sharedConfigTarget === "project" ? "●" : "○"} Project`, detail: ".mcp.json", target: "project" },
      { id: "select-shared-target", label: `${this.sharedConfigTarget === "global" ? "●" : "○"} Global `, detail: "~/.config/mcp/mcp.json", target: "global" },
    );
    for (const preset of this.discovery.knownServerPresets) {
      actions.push({ id: "add-known-server", label: preset.name, preset });
    }
    if (!this.discovery.repoPrompt.configured && this.discovery.repoPrompt.executablePath && this.discovery.repoPrompt.targetPath && this.discovery.repoPrompt.entry && this.discovery.repoPrompt.serverName) {
      actions.push({ id: "add-repoprompt", label: "RepoPrompt" });
    }
    if (this.discovery.imports.length > 0) {
      actions.push({ id: "adopt-imports", label: "Adopt compatibility imports" });
    }
    if (!this.selectedSharedConfigExists()) {
      actions.push({ id: "scaffold-shared-config", label: `Scaffold ${this.sharedConfigTarget === "project" ? ".mcp.json" : "~/.config/mcp/mcp.json"}` });
    }
    actions.push({ id: "view-example", label: "Example config" });
    actions.push({ id: "show-precedence", label: "Config precedence" });
    if (this.getDetectedPaths().length > 0) {
      actions.push({ id: "open-paths", label: "Open config files" });
    }
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
        let status = "";
        if (preset.desktopApp && result.reachable !== undefined) {
          status = result.reachable
            ? ` A server is answering at ${preset.entry.url}.`
            : ` Nothing is answering at ${preset.entry.url} yet. ${preset.desktopApp.enableSteps}`;
        }
        this.notice = {
          text: `Added ${result.serverName} to ${result.path}.${status} Pi will reload after this panel closes.`,
          tone: result.reachable === false ? "warning" : "success",
        };
      });
      return;
    }
    this.notice = { text: "Review the details. Press Enter on an action with a side effect to apply it.", tone: "muted" };
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
      terminalRows: this.tui.terminal?.rows,
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
  tui: SetupPanelTui,
  done: () => void,
): McpSetupPanel & { dispose(): void } {
  return new McpSetupPanel(discovery, callbacks, options, tui, done);
}
