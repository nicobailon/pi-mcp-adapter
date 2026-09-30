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
/** Rows outside the body: top border, header, separator, hints, bottom border. */
const FRAME_ROWS = 5;
/** Blank rows under the header and above the separator, dropped when the terminal is short. */
const SPACER_ROWS = 2;
/** The spacer rows are kept only while the body still gets at least this many rows. */
const MIN_SPACED_BODY_ROWS = 10;
/** Body height cap, also used when the terminal size is unknown. */
const MAX_BODY_ROWS = 22;
const MIN_BODY_ROWS = 3;
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
  const indent = /^\s*(?:\d+\.\s+|[-•]\s+)?/.exec(text)![0];
  const body = text.slice(indent.length);
  if (!body.trim()) return [text.trimEnd()];
  const indentWidth = visibleWidth(indent);
  return wrapText(body, Math.max(8, width - indentWidth))
    .map((line, index) => `${index === 0 ? indent : " ".repeat(indentWidth)}${line}`);
}

const graphemes = new Intl.Segmenter();

/**
 * Splits text into lines of at most `width` columns for values like paths that
 * have no spaces to wrap at. Works on whole graphemes, so wide characters and
 * emoji are never split.
 */
function hardWrap(text: string, width: number): string[] {
  if (width <= 0 || visibleWidth(text) <= width) return [text];
  const lines: string[] = [];
  let current = "";
  for (const { segment } of graphemes.segment(text)) {
    if (current && visibleWidth(current + segment) > width) {
      lines.push(current);
      current = "";
    }
    current += segment;
  }
  if (current) lines.push(current);
  return lines;
}

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
  busy: boolean;
  /** Lines the details pane is scrolled down; the view clamps it to the content. */
  detailScroll: number;
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
  /** Marks the details heading, whose blank row below is dropped in compact layouts. */
  heading?: boolean;
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
 * The rendered height depends only on the terminal height, never on the
 * cursor, screen, or notice, so the overlay does not jump while navigating.
 */
class McpSetupPanelView implements Component {
  private readonly container = new Container();
  /** Details scroll bounds from the last render, used by the controller to clamp PageUp/PageDown. */
  maxDetailScroll = 0;
  detailPageSize = 1;

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
    const { bodyRows, spacers } = this.layoutRows(state.terminalRows);
    this.container.clear();

    this.addFrame("╭", "╮", "MCP setup");
    this.addRow(this.renderHeader(state, contentWidth), innerWidth);
    if (spacers) this.addRow("", innerWidth);

    const entries = this.listEntries(state);
    let paneRows = bodyRows;
    if (innerWidth >= TWO_PANE_MIN_INNER_WIDTH) {
      const listWidth = Math.max(MIN_LIST_WIDTH, Math.min(MAX_LIST_WIDTH, Math.floor(innerWidth * 0.4)));
      const paneWidth = contentWidth - listWidth - PANE_GUTTER;
      const listLines = this.renderList(entries, bodyRows, listWidth);
      const paneLines = this.renderPane(this.details(state, paneWidth, !spacers), bodyRows, paneWidth, state.detailScroll);
      const rule = this.theme.border("│");
      for (let row = 0; row < bodyRows; row++) {
        this.addRow(`${listLines[row]!} ${rule}  ${paneLines[row]!}`, innerWidth);
      }
    } else {
      const listRows = Math.min(entries.length, Math.max(1, Math.floor((bodyRows - 1) / 2)));
      paneRows = bodyRows - 1 - listRows;
      const paneLines = this.renderPane(this.details(state, contentWidth, true), paneRows, contentWidth, state.detailScroll);
      for (const line of this.renderList(entries, listRows, contentWidth)) this.addRow(line, innerWidth);
      this.addRow(this.theme.border("─".repeat(contentWidth)), innerWidth);
      for (const line of paneLines) this.addRow(line, innerWidth);
    }
    this.detailPageSize = Math.max(1, paneRows - 2);

    if (spacers) this.addRow("", innerWidth);
    this.addFrame("├", "┤");
    this.addRow(this.renderFooter(state, contentWidth, this.maxDetailScroll > 0), innerWidth);
    this.addFrame("╰", "╯");
    return this.container.render(panelWidth);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  /**
   * Splits the terminal's height budget between chrome and body. Short
   * terminals lose the spacer rows first, then body rows, so the borders and
   * hints row always fit down to about 10 terminal rows.
   */
  private layoutRows(terminalRows: number | undefined): { bodyRows: number; spacers: boolean } {
    if (!terminalRows || terminalRows <= 0) return { bodyRows: MAX_BODY_ROWS, spacers: true };
    const budget = terminalRows - OVERLAY_VERTICAL_MARGIN * 2 - FRAME_ROWS;
    if (budget - SPACER_ROWS >= MIN_SPACED_BODY_ROWS) {
      return { bodyRows: Math.min(MAX_BODY_ROWS, budget - SPACER_ROWS), spacers: true };
    }
    return { bodyRows: Math.max(MIN_BODY_ROWS, budget), spacers: false };
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
      status = plural(discovery.totalServerCount, "server");
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

  private renderFooter(state: McpSetupPanelViewState, width: number, detailsOverflow: boolean): string {
    const busy = "Working…";
    const hintsWidth = state.busy ? width - visibleWidth(busy) - 2 : width;
    let screenHints = "↑↓ move · enter select · esc close";
    if (state.screen === "imports") screenHints = "↑↓ move · space toggle · enter save · esc back";
    else if (state.screen === "paths") screenHints = "↑↓ move · enter open · esc back";
    // Scroll keys lead so narrow footers cut the other hints, not the only way to reach hidden details.
    const keyHints = `${detailsOverflow ? "pgup/pgdn scroll · " : ""}${screenHints}`;
    const hints = fitText(keyHints, Math.max(0, hintsWidth));
    if (!state.busy) return this.theme.hint(hints);
    const gap = Math.max(2, width - visibleWidth(hints) - visibleWidth(busy));
    return `${this.theme.hint(hints)}${" ".repeat(gap)}${this.theme.hint(busy)}`;
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

  /**
   * Renders exactly `rows` list lines, scrolling to keep the selected item
   * visible. `↑/↓ N more` rows need at least 3 rows so they never cover the cursor.
   */
  private renderList(entries: ListEntry[], rows: number, width: number): string[] {
    let start = 0;
    if (entries.length > rows) {
      const cursor = Math.max(0, entries.findIndex((entry) => entry.kind === "item" && entry.selected));
      start = Math.max(0, Math.min(cursor - Math.floor(rows / 2), entries.length - rows));
    }
    const end = Math.min(entries.length, start + rows);
    const hiddenItems = (from: number, to: number) => entries.slice(from, to).filter((entry) => entry.kind === "item").length;
    const indicators = rows >= 3;
    const lines: string[] = [];
    for (let index = start; index < end; index++) {
      if (indicators && index === start && start > 0) {
        lines.push(this.moreLine("↑", hiddenItems(0, start + 1), width));
      } else if (indicators && index === end - 1 && end < entries.length) {
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

  /**
   * Renders exactly `rows` details lines starting `scroll` lines down. When the
   * content doesn't fit and the pane has at least 3 rows, the first and last
   * rows become muted `↑ N more` / `↓ N more` markers, the same as the list.
   * Smaller panes show content only; the footer hint says they scroll.
   */
  private renderPane(content: PaneLine[], rows: number, width: number, scroll: number): string[] {
    const lines = [...content];
    while (lines.length > 0 && !lines[lines.length - 1]!.text.trim()) lines.pop();
    this.maxDetailScroll = Math.max(0, lines.length - rows);
    const start = Math.max(0, Math.min(scroll, this.maxDetailScroll));
    const end = Math.min(lines.length, start + rows);
    const shown = lines.slice(start, end);
    if (rows >= 3 && start > 0) {
      shown[0] = { text: `↑ ${start + 1} more`, tone: this.theme.hint };
    }
    if (rows >= 3 && end < lines.length) {
      shown[shown.length - 1] = { text: `↓ ${lines.length - end + 1} more`, tone: this.theme.hint };
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
    return [{ text, tone: (value) => this.theme.selected(this.theme.bold(value)), heading: true }, { text: "" }];
  }

  private prose(width: number, ...paragraphs: string[]): PaneLine[] {
    return paragraphs.flatMap((paragraph) => wrapIndented(paragraph, width).map((text) => ({ text })));
  }

  private muted(text: string): PaneLine {
    return { text, tone: this.theme.description };
  }

  /**
   * Details pane content, most urgent first: the notice, then any preview
   * error, then the highlighted item, so short panes still show what matters.
   * `compact` (stacked or short layouts) drops the blank row under the heading.
   */
  private details(state: McpSetupPanelViewState, width: number, compact: boolean): PaneLine[] {
    const errors: PaneLine[] = [];
    let body: PaneLine[];
    if (state.screen === "imports") body = this.importDetails(state, width, errors);
    else if (state.screen === "paths") body = this.pathDetails(state, width);
    else body = this.actionDetails(state, state.actions[state.actionCursor], width, errors);
    if (compact && body[0]?.heading && body[1]?.text === "") body.splice(1, 1);

    const lines: PaneLine[] = [];
    const notice = state.busy ? null : state.notice;
    if (notice) {
      let tone = this.theme.hint;
      if (notice.tone === "success") tone = this.theme.confirm;
      else if (notice.tone === "warning") tone = this.theme.needsAuth;
      lines.push(...wrapIndented(notice.text, width).map((text) => ({ text, tone })), { text: "" });
    }
    if (errors.length > 0) lines.push(...errors, { text: "" });
    return [...lines, ...body];
  }

  private importDetails(state: McpSetupPanelViewState, width: number, errors: PaneLine[]): PaneLine[] {
    const selected = state.discovery.imports
      .filter((entry) => state.selectedImports.has(entry.kind))
      .map((entry) => entry.kind);
    return [
      ...this.heading("Adopt compatibility imports"),
      ...this.prose(width, "Space toggles an import. Enter writes the selected imports to mcp-adapter.json in the Pi agent dir."),
      { text: "" },
      this.muted(`${selected.length} of ${state.discovery.imports.length} selected`),
      ...this.writePreview(() => this.callbacks.previewImports(selected), width, errors),
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

  private actionDetails(state: McpSetupPanelViewState, action: Action | undefined, width: number, errors: PaneLine[]): PaneLine[] {
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
          ...this.writePreview(() => this.callbacks.previewKnownServer(preset, state.sharedConfigTarget), width, errors),
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
        const preview = this.previewOrError(() => this.callbacks.previewRepoPrompt(state.sharedConfigTarget), width, errors);
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
          ...this.writePreview(() => this.callbacks.previewImports(selected), width, errors),
        ];
      }
      case "scaffold-shared-config":
        return [
          ...this.heading(action.label),
          ...this.prose(width, "Writes a minimal config with no servers, so nothing fails on the first reload."),
          ...this.writePreview(() => this.callbacks.previewStarterConfig(state.sharedConfigTarget), width, errors),
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
            "mcp-adapter.json files are for compatibility imports and adapter-specific overrides; Pi mcp.json files are not read by the adapter.",
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

  private previewOrError(getPreview: () => ConfigWritePreview | null, width: number, errors: PaneLine[]): PaneLine[] | null {
    let preview: ConfigWritePreview | null;
    try {
      preview = getPreview();
    } catch (error) {
      errors.push(
        { text: "Preview unavailable:", tone: this.theme.needsAuth },
        ...this.prose(width, error instanceof Error ? error.message : String(error))
          .map((line) => ({ ...line, tone: this.theme.needsAuth })),
      );
      return [];
    }
    return preview ? this.formatWritePreview(preview) : null;
  }

  private writePreview(getPreview: () => ConfigWritePreview, width: number, errors: PaneLine[]): PaneLine[] {
    return this.previewOrError(getPreview, width, errors) ?? [];
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
  private detailScroll = 0;
  private notice: Notice | null = null;
  private readonly view: McpSetupPanelView;
  private readonly keys: PanelKeys;
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    private discovery: McpDiscoverySummary,
    private callbacks: SetupPanelCallbacks,
    private options: SetupPanelOptions,
    private readonly tui: SetupPanelTui,
    private done: () => void,
  ) {
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
    // Scrolling keeps the notice, cursor, and screen; any other key resets the scroll.
    if (this.handleDetailScroll(data)) return;
    this.detailScroll = 0;
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

  private handleDetailScroll(data: string): boolean {
    let delta = 0;
    if (matchesKey(data, "pageDown")) delta = this.view.detailPageSize;
    else if (matchesKey(data, "pageUp")) delta = -this.view.detailPageSize;
    else if (matchesKey(data, "shift+down")) delta = 1;
    else if (matchesKey(data, "shift+up")) delta = -1;
    else return false;
    const next = Math.max(0, Math.min(this.view.maxDetailScroll, this.detailScroll + delta));
    if (next !== this.detailScroll) {
      this.detailScroll = next;
      this.tui.requestRender();
    }
    return true;
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
      this.detailScroll = 0;
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
      busy: this.busy,
      detailScroll: this.detailScroll,
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
