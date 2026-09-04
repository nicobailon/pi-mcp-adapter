import { Container, Text, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { copyToClipboard, type Theme } from "@earendil-works/pi-coding-agent";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import { createMcpPanelTheme, McpPanelFrame, type McpPanelTheme } from "./mcp-panel-theme.ts";
import { getToolNameCandidates, isServerDisabled, isToolAllowed, resolveToolPrefix } from "./types.ts";
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerProvenance, ToolPrefix } from "./types.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import { sanitizeTerminalText, stripOscSequences } from "./utils.ts";
import { isServerCacheValid, type MetadataCache, type ServerCacheEntry, type CachedTool } from "./metadata-cache.ts";
import { isUiToolVisibleToModel } from "./ui-tool-visibility.ts";

function fuzzyScore(query: string, text: string): number {
  const lq = query.toLowerCase();
  const lt = text.toLowerCase();
  if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
  let score = 0;
  let qi = 0;
  let consecutive = 0;
  for (let i = 0; i < lt.length && qi < lq.length; i++) {
    if (lt[i] === lq[qi]) {
      score += 10 + consecutive;
      consecutive += 5;
      qi++;
    } else {
      consecutive = 0;
    }
  }
  return qi === lq.length ? score : 0;
}

function sanitizeDisplayText(text: string | null | undefined): string {
  return sanitizeTerminalText(text ?? "");
}

function sanitizeRowContent(content: string): string {
  const withoutOsc = stripOscSequences(content);
  let result = "";
  let pendingSpace = false;
  for (let i = 0; i < withoutOsc.length; i++) {
    const rest = withoutOsc.slice(i);
    const ansi = rest.match(/^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/);
    if (ansi) {
      result += ansi[0];
      i += ansi[0].length - 1;
      continue;
    }

    const code = withoutOsc.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      pendingSpace = true;
      continue;
    }

    if (pendingSpace && result && !result.endsWith(" ")) {
      result += " ";
    }
    pendingSpace = false;
    result += withoutOsc[i];
  }
  return result;
}

function estimateTokens(tool: CachedTool): number {
  const schemaLen = JSON.stringify(tool.inputSchema ?? {}).length;
  const descLen = tool.description?.length ?? 0;
  return Math.ceil((tool.name.length + descLen + schemaLen) / 4) + 10;
}

type ConnectionStatus = "connected" | "idle" | "failed" | "needs-auth" | "connecting" | "disabled";

interface ToolState {
  name: string;
  description: string;
  isDirect: boolean;
  wasDirect: boolean;
  estimatedTokens: number;
}

interface ServerState {
  name: string;
  expanded: boolean;
  source: "user" | "project" | "import";
  importKind?: string;
  includeTools?: string[];
  excludeTools?: string[];
  exposeResources: boolean;
  disabled: boolean;
  wasDisabled: boolean;
  connectionStatus: ConnectionStatus;
  failureMessage?: string | null;
  tools: ToolState[];
  directCount: number;
  directTokens: number;
  hasCachedData: boolean;
}

interface VisibleItem {
  type: "server" | "tool";
  serverIndex: number;
  toolIndex?: number;
}

interface McpPanelViewState {
  noticeLines: readonly string[];
  servers: readonly ServerState[];
  visibleItems: readonly VisibleItem[];
  cursorIndex: number;
  nameQuery: string;
  descSearchActive: boolean;
  descQuery: string;
  dirty: boolean;
  confirmingDiscard: boolean;
  discardSelected: number;
  importNotice: string | null;
  authNotice: string | null;
  authInFlight: string | null;
  authOnly: boolean;
  saveLabel: string | null;
}

/**
 * The themed MCP view. It owns only component composition and formatting;
 * input routing and callbacks remain on McpPanel.
 */
class McpPanelView implements Component {
  private readonly container = new Container();

  constructor(
    private readonly getState: () => McpPanelViewState,
    private readonly theme: McpPanelTheme,
  ) {}

  render(width: number): string[] {
    const panelWidth = Math.max(0, width);
    const innerWidth = Math.max(0, panelWidth - 2);
    const state = this.getState();
    this.container.clear();

    const title = state.authOnly ? "MCP OAuth" : "MCP Servers";
    this.container.addChild(new McpPanelFrame(this.theme, "╭", "╮", title));
    this.addRow("", innerWidth);

    const cursor = this.theme.selected("│");
    const searchIcon = this.theme.border("◎");
    if (state.descSearchActive) {
      this.addRow(`${searchIcon}  ${this.theme.needsAuth("desc:")} ${state.descQuery}${cursor}`, innerWidth);
    } else if (state.nameQuery) {
      this.addRow(`${searchIcon}  ${state.nameQuery}${cursor}`, innerWidth);
    } else {
      this.addRow(`${searchIcon}  ${this.theme.placeholder(this.theme.italic("search..."))}`, innerWidth);
    }

    this.addRow("", innerWidth);
    if (state.noticeLines.length > 0) {
      for (const notice of state.noticeLines) {
        this.addRow(this.theme.hint(this.theme.italic(sanitizeDisplayText(notice))), innerWidth);
      }
      this.addRow("", innerWidth);
    }
    this.addRule("├", "┤");

    if (state.servers.length === 0) {
      this.addRow("", innerWidth);
      this.addRow(
        this.theme.hint(
          this.theme.italic(
            state.authOnly ? "No OAuth-capable MCP servers configured." : "No MCP servers configured.",
          ),
        ),
        innerWidth,
      );
      this.addRow("", innerWidth);
    } else {
      const maxVisible = McpPanel.MAX_VISIBLE;
      const total = state.visibleItems.length;
      const startIndex = Math.max(
        0,
        Math.min(state.cursorIndex - Math.floor(maxVisible / 2), total - maxVisible),
      );
      const endIndex = Math.min(startIndex + maxVisible, total);

      this.addRow("", innerWidth);

      for (let index = startIndex; index < endIndex; index++) {
        const item = state.visibleItems[index];
        if (!item) continue;
        const isCursor = index === state.cursorIndex;
        const server = state.servers[item.serverIndex];
        if (!server) continue;

        if (item.type === "server") {
          this.addRow(this.renderServerRow(state, server, isCursor), innerWidth);
          if (isCursor && server.connectionStatus === "failed" && server.failureMessage) {
            for (const line of this.wrapText(sanitizeDisplayText(server.failureMessage), innerWidth - 6)) {
              this.addRow(`    ${this.theme.cancel(line)}`, innerWidth);
            }
          }
        } else if (item.toolIndex !== undefined) {
          const tool = server.tools[item.toolIndex];
          if (tool) this.addRow(this.renderToolRow(tool, isCursor, innerWidth), innerWidth);
        }
      }

      this.addRow("", innerWidth);

      if (total > maxVisible) {
        const progress = Math.round(((state.cursorIndex + 1) / total) * 10);
        this.addRow(
          `${this.progressDots(progress, 10)}  ${this.theme.hint(`${state.cursorIndex + 1}/${total}`)}`,
          innerWidth,
        );
        this.addRow("", innerWidth);
      }

      if (state.importNotice) {
        this.addRow(this.theme.needsAuth(this.theme.italic(sanitizeDisplayText(state.importNotice))), innerWidth);
        this.addRow("", innerWidth);
      }
      if (state.authNotice) {
        this.addRow(this.theme.needsAuth(this.theme.italic(sanitizeDisplayText(state.authNotice))), innerWidth);
        this.addRow("", innerWidth);
      }
    }

    this.addRule("├", "┤");
    this.addRow("", innerWidth);

    if (state.confirmingDiscard) {
      const discardButton = state.discardSelected === 0
        ? this.theme.inverse(this.theme.bold(this.theme.cancel("  Discard  ")))
        : this.theme.hint("  Discard  ");
      const keepButton = state.discardSelected === 1
        ? this.theme.inverse(this.theme.bold(this.theme.confirm("  Keep & Close  ")))
        : this.theme.hint("  Keep & Close  ");
      this.addRow(`Discard unsaved changes?  ${discardButton}   ${keepButton}`, innerWidth);
    } else if (state.authOnly) {
      this.addRow(this.theme.description("select a server to authenticate"), innerWidth);
    } else {
      let directCount = 0;
      let directTokens = 0;
      for (const server of state.servers) {
        directCount += server.directCount;
        directTokens += server.directTokens;
      }
      const stats = directCount > 0
        ? `${directCount} direct  ~${directTokens.toLocaleString()} tokens`
        : "no direct tools";
      this.addRow(
        this.theme.description(stats + (state.dirty ? this.theme.needsAuth("  (unsaved)") : "")),
        innerWidth,
      );
    }

    this.addRow("", innerWidth);
    const hints = state.authOnly
      ? [
          this.theme.italic("↑↓") + " navigate",
          this.theme.italic("⏎") + " auth",
          this.theme.italic("ctrl+a") + " auth",
          this.theme.italic("esc") + " clear/close",
          this.theme.italic("ctrl+c") + " quit",
        ]
      : [
          this.theme.italic("↑↓") + " navigate",
          this.theme.italic("space") + " toggle",
          this.theme.italic("⏎") + " expand/auth",
          this.theme.italic("ctrl+a") + " auth",
          this.theme.italic("ctrl+r") + " reconnect",
          this.theme.italic("ctrl+d") + " disable/enable",
          ...(this.selectedServerHasFailureMessage(state) ? [this.theme.italic("ctrl+y") + " copy error"] : []),
          this.theme.italic("?") + " desc search",
          ...(state.saveLabel ? [this.theme.italic(state.saveLabel) + " save"] : []),
          this.theme.italic("esc") + " clear/close",
          this.theme.italic("ctrl+c") + " quit",
        ];
    const gap = "  ";
    const gapWidth = 2;
    const maxWidth = innerWidth - 2;
    let currentLine = "";
    let currentWidth = 0;
    for (const hint of hints) {
      const hintWidth = visibleWidth(hint);
      const needed = currentWidth === 0 ? hintWidth : gapWidth + hintWidth;
      if (currentWidth > 0 && currentWidth + needed > maxWidth) {
        this.addRow(this.theme.hint(currentLine), innerWidth);
        currentLine = hint;
        currentWidth = hintWidth;
      } else {
        currentLine += (currentWidth > 0 ? gap : "") + hint;
        currentWidth += needed;
      }
    }
    if (currentLine) this.addRow(this.theme.hint(currentLine), innerWidth);

    this.addRule("╰", "╯");
    return this.container.render(panelWidth);
  }

  invalidate(): void {
    this.container.invalidate();
  }

  private addRow(content: string, innerWidth: number): void {
    this.container.addChild(new Text(this.row(content, innerWidth), 0, 0));
  }

  private addRule(left: string, right: string): void {
    this.container.addChild(new McpPanelFrame(this.theme, left, right));
  }

  private row(content: string, innerWidth: number): string {
    const fitted = truncateToWidth(" " + sanitizeRowContent(content), innerWidth, "…", true);
    return this.theme.border("│") + fitted + this.theme.border("│");
  }

  private progressDots(filled: number, total: number): string {
    const dots: string[] = [];
    for (let index = 0; index < total; index++) {
      if (index < filled) {
        dots.push(this.theme.direct("●"));
      } else {
        dots.push(this.theme.hint("○"));
      }
    }
    return dots.join(" ");
  }

  private renderServerRow(state: McpPanelViewState, server: ServerState, isCursor: boolean): string {
    const expandIcon = server.expanded ? "▾" : "▸";
    const prefix = isCursor
      ? this.theme.selected(expandIcon)
      : this.theme.border(server.expanded ? expandIcon : "·");

    const serverName = sanitizeDisplayText(server.name);
    const importKind = sanitizeDisplayText(server.importKind ?? "import");
    const name = isCursor
      ? this.theme.bold(this.theme.selected(serverName))
      : serverName;
    const importLabel = server.source === "import" ? this.theme.description(` (${importKind})`) : "";
    const statusLabel = this.renderConnectionStatus(state, server);

    if (!server.hasCachedData && !state.authOnly) {
      return `${prefix}   ${name}${importLabel}  ${this.theme.description("(not cached)")}${statusLabel}`;
    }

    const directCount = server.directCount;
    const totalCount = server.tools.length;
    let toggleIcon = this.theme.description("○");
    if (directCount === totalCount && totalCount > 0) {
      toggleIcon = this.theme.direct("●");
    } else if (directCount > 0) {
      toggleIcon = this.theme.needsAuth("◐");
    }

    let toolInfo = "";
    if (totalCount > 0) {
      toolInfo = `${directCount}/${totalCount}`;
      if (directCount > 0) toolInfo += `  ~${server.directTokens.toLocaleString()}`;
      toolInfo = this.theme.description(toolInfo);
    }

    return `${prefix} ${toggleIcon} ${name}${importLabel}  ${toolInfo}${statusLabel}`;
  }

  private selectedServerHasFailureMessage(state: McpPanelViewState): boolean {
    const item = state.visibleItems[state.cursorIndex];
    if (!item) return false;
    const server = state.servers[item.serverIndex];
    return server?.connectionStatus === "failed" && !!server.failureMessage;
  }

  private wrapText(text: string, width: number): string[] {
    const max = Math.max(8, width);
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let current = "";
    const splitLongWord = (word: string): string => {
      let rest = word;
      while (visibleWidth(rest) > max) {
        let take = "";
        let index = 0;
        while (index < rest.length && visibleWidth(take + rest.charAt(index)) <= max) {
          take += rest.charAt(index);
          index++;
        }
        if (!take) take = rest.charAt(0);
        lines.push(take);
        rest = rest.slice(take.length);
      }
      return rest;
    };

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (visibleWidth(candidate) <= max) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = splitLongWord(word);
      }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [text];
  }

  private renderConnectionStatus(state: McpPanelViewState, server: ServerState): string {
    if (state.authInFlight === server.name) return `  ${this.theme.needsAuth("authenticating")}`;
    if (server.disabled) return `  ${this.theme.description("disabled")}`;
    if (server.connectionStatus === "needs-auth") return `  ${this.theme.needsAuth("needs auth")}`;
    if (server.connectionStatus === "connecting") return `  ${this.theme.needsAuth("connecting")}`;
    if (server.connectionStatus === "failed") return `  ${this.theme.cancel("failed")}`;
    if (state.authOnly && server.connectionStatus === "connected") return `  ${this.theme.direct("connected")}`;
    if (state.authOnly) return `  ${this.theme.description("idle")}`;
    return "";
  }

  private renderToolRow(tool: ToolState, isCursor: boolean, innerWidth: number): string {
    const toggleIcon = tool.isDirect ? this.theme.direct("●") : this.theme.description("○");
    const cursor = isCursor ? this.theme.selected("▸") : " ";
    const toolName = sanitizeDisplayText(tool.name);
    const description = sanitizeDisplayText(tool.description);
    const name = isCursor ? this.theme.bold(this.theme.selected(toolName)) : toolName;

    const prefixLength = 7 + visibleWidth(toolName);
    const maxDescriptionLength = Math.max(0, innerWidth - prefixLength - 8);
    const descriptionText = maxDescriptionLength > 5 && description
      ? this.theme.description(`— ${truncateToWidth(description, maxDescriptionLength, "…")}`)
      : "";

    return `  ${cursor} ${toggleIcon} ${name} ${descriptionText}`;
  }
}

class McpPanel {
  private noticeLines: string[];
  private prefix: ToolPrefix;
  private servers: ServerState[] = [];
  private cursorIndex = 0;
  private nameQuery = "";
  private descSearchActive = false;
  private descQuery = "";
  private dirty = false;
  private confirmingDiscard = false;
  private discardSelected = 1;
  private importNotice: string | null = null;
  private authNotice: string | null = null;
  private authInFlight: string | null = null;
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private visibleItems: VisibleItem[] = [];
  private tui: { requestRender(): void };
  private readonly view: McpPanelView;
  private authOnly: boolean;
  private keys: PanelKeys;

  static readonly MAX_VISIBLE = 12;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    private config: McpConfig,
    private cache: MetadataCache | null,
    provenance: Map<string, ServerProvenance>,
    private callbacks: McpPanelCallbacks,
    tui: { requestRender(): void },
    private done: (result: McpPanelResult) => void,
    options: { noticeLines?: string[]; authOnly?: boolean; keybindings?: PanelKeybindings; theme?: Theme } = {},
  ) {
    this.tui = tui;
    this.noticeLines = options.noticeLines ?? [];
    this.authOnly = options.authOnly === true;
    this.keys = createPanelKeys(options.keybindings);
    this.view = new McpPanelView(() => this.getViewState(), createMcpPanelTheme(options.theme));
    this.prefix = config.settings?.toolPrefix ?? "server";

    for (const [serverName, definition] of Object.entries(config.mcpServers)) {
      if (this.authOnly && !callbacks.canAuthenticate(serverName)) continue;
      const prov = provenance.get(serverName);
      const cachedEntry = this.cache?.servers?.[serverName];
      const serverCache = cachedEntry && isServerCacheValid(cachedEntry, definition) ? cachedEntry : undefined;

      const globalDirect = config.settings?.directTools;
      let toolFilter: true | string[] | false = false;
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }

      const tools: ToolState[] = [];
      if (serverCache && !this.authOnly && !isServerDisabled(definition)) {
        for (const tool of serverCache.tools ?? []) {
          if (!isUiToolVisibleToModel(tool.uiVisibility)) continue;
          if (!isToolAllowed(tool.name, serverName, this.prefix, definition.includeTools, definition.excludeTools, this.getOtherCurrentCandidates(serverName, definition, serverCache, tool.name))) {
            continue;
          }

          const isDirect = toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(tool.name));
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            isDirect,
            wasDirect: isDirect,
            estimatedTokens: estimateTokens(tool),
          });
        }
        if (definition.exposeResources !== false) {
          for (const resource of serverCache.resources ?? []) {
            const baseName = `read_${resourceNameToToolName(resource.name)}`;
            if (!isToolAllowed(baseName, serverName, this.prefix, definition.includeTools, definition.excludeTools, this.getOtherCurrentCandidates(serverName, definition, serverCache, baseName))) {
              continue;
            }

            const isDirect = toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(baseName));
            const ct: CachedTool = {
              name: baseName,
              ...(resource.description !== undefined ? { description: resource.description } : {}),
            };
            tools.push({
              name: baseName,
              description: resource.description ?? `Read resource: ${resource.uri}`,
              isDirect,
              wasDirect: isDirect,
              estimatedTokens: estimateTokens(ct),
            });
          }
        }
      }

      const status = callbacks.getConnectionStatus(serverName);
      const failureMessage = callbacks.getFailureMessage?.(serverName) ?? null;
      const serverDisabled = isServerDisabled(definition);
      let directCount = 0;
      let directTokens = 0;
      for (const tool of tools) {
        if (!tool.isDirect) continue;
        directCount++;
        directTokens += tool.estimatedTokens;
      }
      this.servers.push({
        name: serverName,
        expanded: false,
        source: prov?.kind ?? "user",
        ...(prov?.importKind !== undefined ? { importKind: prov.importKind } : {}),
        ...(definition.includeTools !== undefined ? { includeTools: definition.includeTools } : {}),
        ...(definition.excludeTools !== undefined ? { excludeTools: definition.excludeTools } : {}),
        exposeResources: definition.exposeResources !== false,
        disabled: serverDisabled,
        wasDisabled: serverDisabled,
        connectionStatus: status,
        failureMessage,
        tools,
        directCount,
        directTokens,
        hasCachedData: !!serverCache,
      });
    }

    this.rebuildVisibleItems();
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map(), disabledChanges: new Map() });
    }, McpPanel.INACTIVITY_MS);
  }

  private cleanup(): void {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  private rebuildVisibleItems(): void {
    const query = this.descSearchActive ? this.descQuery : this.nameQuery;
    const mode = this.descSearchActive ? "desc" : "name";

    this.visibleItems = [];
    for (let si = 0; si < this.servers.length; si++) {
      const server = this.servers[si];
      if (!server) continue;
      if (query && this.authOnly) {
        const score = mode === "name" ? fuzzyScore(query, server.name) : 0;
        if (score > 0) {
          this.visibleItems.push({ type: "server", serverIndex: si });
        }
        continue;
      }

      this.visibleItems.push({ type: "server", serverIndex: si });
      if (server.expanded || query) {
        for (let ti = 0; ti < server.tools.length; ti++) {
          const tool = server.tools[ti];
          if (!tool) continue;
          if (query) {
            const score = mode === "name"
              ? Math.max(
                  fuzzyScore(query, tool.name),
                  fuzzyScore(query, server.name) * 0.6,
                )
              : fuzzyScore(query, tool.description);
            if (score === 0) continue;
          }
          this.visibleItems.push({ type: "tool", serverIndex: si, toolIndex: ti });
        }
      }
    }

    if (query && !this.authOnly) {
      this.visibleItems = this.visibleItems.filter((item) => {
        if (item.type === "server") {
          return this.visibleItems.some(
            (other) => other.type === "tool" && other.serverIndex === item.serverIndex,
          );
        }
        return true;
      });
    }
  }

  private updateDirty(): void {
    this.dirty = this.servers.some((s) => s.disabled !== s.wasDisabled || s.tools.some((t) => t.isDirect !== t.wasDirect));
  }

  private buildResult(): McpPanelResult {
    const changes = new Map<string, true | string[] | false>();
    const disabledChanges = new Map<string, boolean>();
    for (const server of this.servers) {
      if (server.disabled !== server.wasDisabled) {
        disabledChanges.set(server.name, server.disabled);
      }
      const changed = server.tools.some((t) => t.isDirect !== t.wasDirect);
      if (!changed) continue;
      const directTools = server.tools.filter((t) => t.isDirect);
      if (directTools.length === server.tools.length && server.tools.length > 0) {
        changes.set(server.name, true);
      } else if (directTools.length === 0) {
        changes.set(server.name, false);
      } else {
        changes.set(server.name, directTools.map((t) => t.name));
      }
    }
    return { changes, disabledChanges, cancelled: false };
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();
    this.importNotice = null;
    if (!this.authInFlight) this.authNotice = null;

    if (this.confirmingDiscard) {
      this.handleDiscardInput(data);
      return;
    }

    // Global shortcuts — always work, even during desc search
    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map(), disabledChanges: new Map() });
      return;
    }

    if (this.keys.save(data)) {
      this.cleanup();
      this.done(this.buildResult());
      return;
    }

    // Modal description search mode
    if (this.descSearchActive) {
      if (matchesKey(data, "escape") || this.keys.selectConfirm(data)) {
        this.descSearchActive = false;
        this.descQuery = "";
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      if (matchesKey(data, "backspace")) {
        if (this.descQuery.length > 0) {
          this.descQuery = this.descQuery.slice(0, -1);
          this.rebuildVisibleItems();
          this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        }
        return;
      }
      if (this.keys.selectUp(data)) { this.moveCursor(-1); return; }
      if (this.keys.selectDown(data)) { this.moveCursor(1); return; }
      if (matchesKey(data, "space")) {
        // Toggle even while in desc search
        const item = this.visibleItems[this.cursorIndex];
        if (item) this.toggleItem(item);
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32) {
        this.descQuery += data;
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.nameQuery) {
        this.nameQuery = "";
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      if (this.dirty) {
        this.confirmingDiscard = true;
        this.discardSelected = 1;
        return;
      }
      this.cleanup();
      this.done({ cancelled: true, changes: new Map(), disabledChanges: new Map() });
      return;
    }

    if (this.keys.selectUp(data)) { this.moveCursor(-1); return; }
    if (this.keys.selectDown(data)) { this.moveCursor(1); return; }

    if (matchesKey(data, "space")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item && !this.authOnly) this.toggleItem(item);
      return;
    }

    if (this.keys.selectConfirm(data)) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      if (!server) return;
      if (item.type === "server") {
        if (server.connectionStatus === "disabled") return;
        if (this.authOnly || server.connectionStatus === "needs-auth") {
          this.authenticateServer(server);
          return;
        }
        server.expanded = !server.expanded;
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      } else if (item.toolIndex !== undefined) {
        const tool = server.tools[item.toolIndex];
        if (!tool) return;
        this.toggleToolDirect(server, tool);
        if (tool.isDirect && server.source === "import") {
          this.importNotice = `Imported from ${sanitizeDisplayText(server.importKind ?? "external")} — will copy to user config on save`;
        }
        this.updateDirty();
      }
      return;
    }

    if (matchesKey(data, "ctrl+a")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item) this.authenticateSelectedServer(item);
      return;
    }

    if (matchesKey(data, "ctrl+r")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      if (server) this.reconnectServer(server);
      return;
    }

    if (matchesKey(data, "ctrl+d")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item || item.type !== "server" || this.authOnly) return;
      const server = this.servers[item.serverIndex];
      if (!server) return;
      server.disabled = !server.disabled;
      this.updateDirty();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+y")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      if (!server || server.connectionStatus !== "failed" || !server.failureMessage) return;
      const serverName = sanitizeDisplayText(server.name);
      const failureMessage = sanitizeDisplayText(server.failureMessage);
      copyToClipboard(failureMessage).then(() => {
        this.authNotice = `Copied error for ${serverName} to clipboard`;
        this.tui.requestRender();
      }).catch((error) => {
        const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
        this.authNotice = `Failed to copy error for ${serverName}: ${message}`;
        this.tui.requestRender();
      });
      return;
    }

    if (data === "?") {
      if (this.authOnly) return;
      this.descSearchActive = true;
      this.descQuery = "";
      this.rebuildVisibleItems();
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      return;
    }

    // Backspace removes from name query
    if (matchesKey(data, "backspace")) {
      if (this.nameQuery.length > 0) {
        this.nameQuery = this.nameQuery.slice(0, -1);
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      }
      return;
    }

    // All other printable chars → always-on name search
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.nameQuery += data;
      this.rebuildVisibleItems();
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      return;
    }
  }

  private authenticateSelectedServer(item: VisibleItem): void {
    const server = this.servers[item.serverIndex];
    if (server) this.authenticateServer(server);
  }

  private authenticateServer(server: ServerState): void {
    if (this.authInFlight) return;
    if (server.connectionStatus === "connecting" || server.connectionStatus === "disabled") return;
    const serverName = sanitizeDisplayText(server.name);
    if (!this.callbacks.canAuthenticate(server.name)) {
      this.authNotice = `${serverName} does not use OAuth authentication.`;
      return;
    }

    this.authInFlight = server.name;
    this.authNotice = `Authenticating ${serverName}...`;
    this.tui.requestRender();

    this.callbacks.authenticate(server.name).then((result) => {
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      if (result.ok) {
        this.authNotice = `OAuth finished for ${serverName}. Reconnecting...`;
        this.authInFlight = null;
        this.tui.requestRender();
        this.reconnectServer(server, { afterAuth: true });
        return;
      }

      const message = sanitizeDisplayText(result.message);
      this.authNotice = `OAuth failed for ${serverName}${message ? `: ${message}` : ". Check the notification for details."}`;
      this.authInFlight = null;
      this.tui.requestRender();
    }).catch((error) => {
      const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      this.authNotice = `OAuth failed for ${serverName}: ${message}`;
      this.authInFlight = null;
      this.tui.requestRender();
    });
  }

  private reconnectServer(server: ServerState, options: { afterAuth?: boolean } = {}): void {
    if (server.connectionStatus === "connecting" || server.connectionStatus === "disabled") return;
    const serverName = sanitizeDisplayText(server.name);
    server.connectionStatus = "connecting";
    this.tui.requestRender();

    this.callbacks.reconnect(server.name).then((connected) => {
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      server.failureMessage = this.callbacks.getFailureMessage?.(server.name) ?? null;
      if (server.connectionStatus === "connected") {
        const entry = this.callbacks.refreshCacheAfterReconnect(server.name);
        if (entry) {
          this.cache ??= { version: 1, servers: {} };
          this.cache.servers[server.name] = entry;
          this.rebuildServerTools(server, entry);
          server.hasCachedData = true;
        }
      }
      if (options.afterAuth) {
        this.authNotice = connected && server.connectionStatus === "connected"
          ? `OAuth finished for ${serverName}. Reconnected.`
          : `OAuth finished for ${serverName}, but reconnect did not complete. Press ctrl+r to retry.`;
      }
      this.tui.requestRender();
    }).catch((error) => {
      server.connectionStatus = "failed";
      const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
      this.authNotice = `Reconnect failed for ${serverName}: ${message}`;
      this.tui.requestRender();
    });
  }

  private toggleItem(item: VisibleItem): void {
    if (this.authOnly) return;
    const server = this.servers[item.serverIndex];
    if (!server) return;
    if (item.type === "server") {
      const newState = !server.tools.every((t) => t.isDirect);
      if (server.source === "import" && newState) {
        this.importNotice = `Imported from ${sanitizeDisplayText(server.importKind ?? "external")} — will copy to user config on save`;
      }
      let directTokens = 0;
      for (const tool of server.tools) {
        tool.isDirect = newState;
        if (newState) directTokens += tool.estimatedTokens;
      }
      server.directCount = newState ? server.tools.length : 0;
      server.directTokens = directTokens;
    } else if (item.toolIndex !== undefined) {
      const tool = server.tools[item.toolIndex];
      if (!tool) return;
      this.toggleToolDirect(server, tool);
      if (tool.isDirect && server.source === "import") {
        this.importNotice = `Imported from ${sanitizeDisplayText(server.importKind ?? "external")} — will copy to user config on save`;
      }
    }
    this.updateDirty();
  }

  private toggleToolDirect(server: ServerState, tool: ToolState): void {
    tool.isDirect = !tool.isDirect;
    server.directCount += tool.isDirect ? 1 : -1;
    server.directTokens += tool.isDirect ? tool.estimatedTokens : -tool.estimatedTokens;
  }

  private handleDiscardInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map(), disabledChanges: new Map() });
      return;
    }
    if (matchesKey(data, "escape") || data === "n" || data === "N") {
      this.confirmingDiscard = false;
      return;
    }
    if (this.keys.selectConfirm(data)) {
      this.cleanup();
      if (this.discardSelected === 0) {
        this.done({ cancelled: true, changes: new Map(), disabledChanges: new Map() });
      } else {
        this.done(this.buildResult());
      }
      return;
    }
    if (data === "y" || data === "Y") {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map(), disabledChanges: new Map() });
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
      this.discardSelected = this.discardSelected === 0 ? 1 : 0;
    }
  }

  private moveCursor(delta: number): void {
    if (this.visibleItems.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(this.visibleItems.length - 1, this.cursorIndex + delta));
  }

  private getOtherCurrentCandidates(
    serverName: string,
    definition: McpConfig["mcpServers"][string],
    currentEntry: ServerCacheEntry,
    toolName: string,
  ): Set<string> {
    const candidates = new Set<string>();
    for (const [otherServerName, otherDefinition] of Object.entries(this.config.mcpServers)) {
      if (isServerDisabled(otherDefinition)) continue;
      const cachedEntry = this.cache?.servers?.[otherServerName];
      const entry = otherServerName === serverName
        ? currentEntry
        : cachedEntry && isServerCacheValid(cachedEntry, otherDefinition) ? cachedEntry : undefined;
      if (!entry) continue;
      const otherPrefix = resolveToolPrefix(otherDefinition, this.prefix);
      for (const tool of entry.tools ?? []) {
        if (!isUiToolVisibleToModel(tool.uiVisibility)) continue;
        for (const candidate of getToolNameCandidates(tool.name, otherServerName, otherPrefix, false)) candidates.add(candidate);
      }
      if (otherDefinition.exposeResources !== false) {
        for (const resource of entry.resources ?? []) {
          const baseName = `read_${resourceNameToToolName(resource.name)}`;
          for (const candidate of getToolNameCandidates(baseName, otherServerName, otherPrefix, false)) candidates.add(candidate);
        }
      }
    }
    for (const candidate of getToolNameCandidates(toolName, serverName, resolveToolPrefix(definition, this.prefix), false)) candidates.delete(candidate);
    return candidates;
  }

  private rebuildServerTools(server: ServerState, entry: ServerCacheEntry): void {
    const existingState = new Map<string, boolean>();
    for (const t of server.tools) existingState.set(t.name, t.isDirect);

    const newTools: ToolState[] = [];
    for (const tool of entry.tools ?? []) {
      if (!isUiToolVisibleToModel(tool.uiVisibility)) continue;
      if (!isToolAllowed(tool.name, server.name, this.prefix, server.includeTools, server.excludeTools, this.getOtherCurrentCandidates(server.name, server, entry, tool.name))) {
        continue;
      }

      const prev = existingState.get(tool.name);
      const isDirect = prev !== undefined ? prev : false;
      newTools.push({
        name: tool.name,
        description: tool.description ?? "",
        isDirect,
        wasDirect: prev !== undefined ? server.tools.find((t) => t.name === tool.name)?.wasDirect ?? false : false,
        estimatedTokens: estimateTokens(tool),
      });
    }

    if (server.exposeResources) {
      for (const resource of entry.resources ?? []) {
        const baseName = `read_${resourceNameToToolName(resource.name)}`;
        if (!isToolAllowed(baseName, server.name, this.prefix, server.includeTools, server.excludeTools, this.getOtherCurrentCandidates(server.name, server, entry, baseName))) {
          continue;
        }

        const prev = existingState.get(baseName);
        const isDirect = prev !== undefined ? prev : false;
        const ct: CachedTool = {
          name: baseName,
          ...(resource.description !== undefined ? { description: resource.description } : {}),
        };
        newTools.push({
          name: baseName,
          description: resource.description ?? `Read resource: ${resource.uri}`,
          isDirect,
          wasDirect: prev !== undefined ? server.tools.find((t) => t.name === baseName)?.wasDirect ?? false : false,
          estimatedTokens: estimateTokens(ct),
        });
      }
    }

    server.tools = newTools;
    server.directCount = 0;
    server.directTokens = 0;
    for (const tool of newTools) {
      if (!tool.isDirect) continue;
      server.directCount++;
      server.directTokens += tool.estimatedTokens;
    }
    this.rebuildVisibleItems();
    this.updateDirty();
  }

  private getViewState(): McpPanelViewState {
    return {
      noticeLines: this.noticeLines,
      servers: this.servers,
      visibleItems: this.visibleItems,
      cursorIndex: this.cursorIndex,
      nameQuery: this.nameQuery,
      descSearchActive: this.descSearchActive,
      descQuery: this.descQuery,
      dirty: this.dirty,
      confirmingDiscard: this.confirmingDiscard,
      discardSelected: this.discardSelected,
      importNotice: this.importNotice,
      authNotice: this.authNotice,
      authInFlight: this.authInFlight,
      authOnly: this.authOnly,
      saveLabel: this.keys.saveLabel(),
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

export function createMcpPanel(
  config: McpConfig,
  cache: MetadataCache | null,
  provenance: Map<string, ServerProvenance>,
  callbacks: McpPanelCallbacks,
  tui: { requestRender(): void },
  done: (result: McpPanelResult) => void,
  options?: { noticeLines?: string[]; authOnly?: boolean; keybindings?: PanelKeybindings; theme?: Theme },
): McpPanel & { dispose(): void } {
  return new McpPanel(config, cache, provenance, callbacks, tui, done, options ?? {});
}
