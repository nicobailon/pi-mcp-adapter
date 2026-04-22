import { KeybindingsManager, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { KeybindingDefinitions } from "@mariozechner/pi-tui";
import { isToolExcluded } from "./types.js";
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerProvenance } from "./types.js";
import { resourceNameToToolName } from "./resource-tools.js";
import type { MetadataCache, ServerCacheEntry, CachedTool } from "./metadata-cache.js";


// All panel action IDs — every keybinding is configurable via
// ~/.pi/agent/keybindings.json using the "mcp.panel.*" keys.
// Declaration merging into the global Keybindings interface is not done here because
// @mariozechner/pi-tui is a peer dep not in the project's own node_modules.
// We use a local union type and a one-shot `as any` at the call site instead.
type PanelAction =
  | "mcp.panel.navigateUp"
  | "mcp.panel.navigateDown"
  | "mcp.panel.confirm"
  | "mcp.panel.toggle"
  | "mcp.panel.cancel"
  | "mcp.panel.save"
  | "mcp.panel.quit"
  | "mcp.panel.reconnect"
  | "mcp.panel.pause"
  | "mcp.panel.descSearch"
  | "mcp.panel.deleteBack"
  | "mcp.panel.discardConfirm"
  | "mcp.panel.discardCancel"
  | "mcp.panel.discardSwitch";

const MCP_PANEL_KB_DEFS: KeybindingDefinitions = {
  "mcp.panel.navigateUp":     { defaultKeys: "up",                        description: "Navigate up" },
  "mcp.panel.navigateDown":   { defaultKeys: "down",                      description: "Navigate down" },
  "mcp.panel.confirm":        { defaultKeys: "return",                    description: "Expand server / toggle tool" },
  "mcp.panel.toggle":         { defaultKeys: "space",                     description: "Toggle direct tool on/off" },
  "mcp.panel.cancel":         { defaultKeys: "escape",                    description: "Clear search / close panel" },
  "mcp.panel.save":           { defaultKeys: "ctrl+s",                    description: "Save changes" },
  "mcp.panel.quit":           { defaultKeys: "ctrl+c",                    description: "Quit without saving" },
  "mcp.panel.reconnect":      { defaultKeys: "ctrl+r",                    description: "Reconnect server" },
  "mcp.panel.pause":          { defaultKeys: "ctrl+x",                    description: "Pause / resume server" },
  "mcp.panel.descSearch":     { defaultKeys: "?",                         description: "Open description search" },
  "mcp.panel.deleteBack":     { defaultKeys: "backspace",                 description: "Delete character from search" },
  "mcp.panel.discardConfirm": { defaultKeys: ["y", "shift+y"],            description: "Confirm discard changes" },
  "mcp.panel.discardCancel":  { defaultKeys: ["n", "shift+n"],            description: "Cancel discard (keep changes)" },
  "mcp.panel.discardSwitch":  { defaultKeys: ["left", "right", "tab"],    description: "Switch between Discard/Keep buttons" },
};

// Single cast point — avoids scattering "as any" throughout the class
function panelMatches(kb: KeybindingsManager, data: string, action: PanelAction): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return kb.matches(data, action as any);
}
function panelKeys(kb: KeybindingsManager, action: PanelAction): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return kb.getKeys(action as any);
}

/** Format a raw key id into a readable symbol/label for the hint bar. */
function fmtKey(key: string): string {
  const map: Record<string, string> = {
    up: "↑", down: "↓", left: "←", right: "→",
    enter: "⏎", return: "⏎", escape: "esc", space: "␣", backspace: "⌫",
  };
  return map[key.toLowerCase()] ?? key;
}

// All panel action IDs — every keybinding is configurable via
// ~/.pi/agent/keybindings.json using the "mcp.panel.*" keys.
// Declaration merging into the global Keybindings interface is not done here because
// @mariozechner/pi-tui is a peer dep not in the project's own node_modules.
// We use a local union type and a one-shot `as any` at the call site instead.
type PanelAction =
  | "mcp.panel.navigateUp"
  | "mcp.panel.navigateDown"
  | "mcp.panel.confirm"
  | "mcp.panel.toggle"
  | "mcp.panel.cancel"
  | "mcp.panel.save"
  | "mcp.panel.quit"
  | "mcp.panel.reconnect"
  | "mcp.panel.pause"
  | "mcp.panel.descSearch"
  | "mcp.panel.deleteBack"
  | "mcp.panel.discardConfirm"
  | "mcp.panel.discardCancel"
  | "mcp.panel.discardSwitch";

const MCP_PANEL_KB_DEFS: KeybindingDefinitions = {
  "mcp.panel.navigateUp":     { defaultKeys: "up",                        description: "Navigate up" },
  "mcp.panel.navigateDown":   { defaultKeys: "down",                      description: "Navigate down" },
  "mcp.panel.confirm":        { defaultKeys: "return",                    description: "Expand server / toggle tool" },
  "mcp.panel.toggle":         { defaultKeys: "space",                     description: "Toggle direct tool on/off" },
  "mcp.panel.cancel":         { defaultKeys: "escape",                    description: "Clear search / close panel" },
  "mcp.panel.save":           { defaultKeys: "ctrl+s",                    description: "Save changes" },
  "mcp.panel.quit":           { defaultKeys: "ctrl+c",                    description: "Quit without saving" },
  "mcp.panel.reconnect":      { defaultKeys: "ctrl+r",                    description: "Reconnect server" },
  "mcp.panel.pause":          { defaultKeys: "ctrl+x",                    description: "Pause / resume server" },
  "mcp.panel.descSearch":     { defaultKeys: "?",                         description: "Open description search" },
  "mcp.panel.deleteBack":     { defaultKeys: "backspace",                 description: "Delete character from search" },
  "mcp.panel.discardConfirm": { defaultKeys: ["y", "shift+y"],            description: "Confirm discard changes" },
  "mcp.panel.discardCancel":  { defaultKeys: ["n", "shift+n"],            description: "Cancel discard (keep changes)" },
  "mcp.panel.discardSwitch":  { defaultKeys: ["left", "right", "tab"],    description: "Switch between Discard/Keep buttons" },
};

// Single cast point — avoids scattering "as any" throughout the class
function panelMatches(kb: KeybindingsManager, data: string, action: PanelAction): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return kb.matches(data, action as any);
}
function panelKeys(kb: KeybindingsManager, action: PanelAction): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return kb.getKeys(action as any);
}

/** Format a raw key id into a readable symbol/label for the hint bar. */
function fmtKey(key: string): string {
  const map: Record<string, string> = {
    up: "↑", down: "↓", left: "←", right: "→",
    enter: "⏎", return: "⏎", escape: "esc", space: "␣", backspace: "⌫",
  };
  return map[key.toLowerCase()] ?? key;
}

interface PanelTheme {
  border: string;
  title: string;
  selected: string;
  direct: string;
  needsAuth: string;
  placeholder: string;
  description: string;
  hint: string;
  confirm: string;
  cancel: string;
}

const DEFAULT_THEME: PanelTheme = {
  border: "2",
  title: "2",
  selected: "36",
  direct: "32",
  needsAuth: "33",
  placeholder: "2;3",
  description: "2",
  hint: "2",
  confirm: "32",
  cancel: "31",
};

function fg(code: string, text: string): string {
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const RAINBOW_COLORS = [
  "38;2;178;129;214",
  "38;2;215;135;175",
  "38;2;254;188;56",
  "38;2;228;192;15",
  "38;2;137;210;129",
  "38;2;0;175;175",
  "38;2;23;143;185",
];

function rainbowProgress(filled: number, total: number): string {
  const dots: string[] = [];
  for (let i = 0; i < total; i++) {
    const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length];
    dots.push(fg(color, i < filled ? "●" : "○"));
  }
  return dots.join(" ");
}

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

function estimateTokens(tool: CachedTool): number {
  const schemaLen = JSON.stringify(tool.inputSchema ?? {}).length;
  const descLen = tool.description?.length ?? 0;
  return Math.ceil((tool.name.length + descLen + schemaLen) / 4) + 10;
}

type ConnectionStatus = "connected" | "idle" | "failed" | "needs-auth" | "connecting";

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
  excludeTools?: string[];
  exposeResources: boolean;
  connectionStatus: ConnectionStatus;
  tools: ToolState[];
  hasCachedData: boolean;
  paused: boolean;
}

interface VisibleItem {
  type: "server" | "tool";
  serverIndex: number;
  toolIndex?: number;
}

class McpPanel {
  private noticeLines: string[];
  private prefix: "server" | "none" | "short";
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
  private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  private visibleItems: VisibleItem[] = [];
  private tui: { requestRender(): void };
  private t = DEFAULT_THEME;
  private kb: KeybindingsManager;

  private static readonly MAX_VISIBLE = 12;
  private static readonly INACTIVITY_MS = 60_000;

  constructor(
    config: McpConfig,
    cache: MetadataCache | null,
    provenance: Map<string, ServerProvenance>,
    private callbacks: McpPanelCallbacks,
    tui: { requestRender(): void },
    piKeybindings: KeybindingsManager,
    private done: (result: McpPanelResult) => void,
    noticeLines: string[] = [],
  ) {
    this.tui = tui;
    this.noticeLines = noticeLines;
    this.prefix = config.settings?.toolPrefix ?? "server";
    // Build a panel-local manager so users can override these actions via
    // ~/.pi/agent/keybindings.json using the "mcp.panel.*" action IDs.
    this.kb = new KeybindingsManager(MCP_PANEL_KB_DEFS, piKeybindings.getUserBindings());

    for (const [serverName, definition] of Object.entries(config.mcpServers)) {
      const prov = provenance.get(serverName);
      const serverCache = cache?.servers?.[serverName];

      const globalDirect = config.settings?.directTools;
      let toolFilter: true | string[] | false = false;
      if (definition.directTools !== undefined) {
        toolFilter = definition.directTools;
      } else if (globalDirect) {
        toolFilter = globalDirect;
      }

      const tools: ToolState[] = [];
      if (serverCache) {
        for (const tool of serverCache.tools ?? []) {
          if (isToolExcluded(tool.name, serverName, this.prefix, definition.excludeTools)) {
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
            const baseName = `get_${resourceNameToToolName(resource.name)}`;
            if (isToolExcluded(baseName, serverName, this.prefix, definition.excludeTools)) {
              continue;
            }

            const isDirect = toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(baseName));
            const ct: CachedTool = { name: baseName, description: resource.description };
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

      this.servers.push({
        name: serverName,
        expanded: false,
        source: prov?.kind ?? "user",
        importKind: prov?.importKind,
        excludeTools: definition.excludeTools,
        exposeResources: definition.exposeResources !== false,
        connectionStatus: status,
        tools,
        hasCachedData: !!serverCache,
        paused: callbacks.isPaused(serverName),
      });
    }

    this.rebuildVisibleItems();
    this.resetInactivityTimeout();
  }

  private resetInactivityTimeout(): void {
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
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
      this.visibleItems.push({ type: "server", serverIndex: si });
      if (server.expanded || query) {
        for (let ti = 0; ti < server.tools.length; ti++) {
          const tool = server.tools[ti];
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

    if (query) {
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
    this.dirty = this.servers.some((s) => s.tools.some((t) => t.isDirect !== t.wasDirect));
  }

  private buildResult(): McpPanelResult {
    const changes = new Map<string, true | string[] | false>();
    for (const server of this.servers) {
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
    return { changes, cancelled: false };
  }

  handleInput(data: string): void {
    this.resetInactivityTimeout();
    this.importNotice = null;
    this.authNotice = null;

    if (this.confirmingDiscard) {
      this.handleDiscardInput(data);
      return;
    }

    // Global shortcuts — always work, even during desc search
    if (panelMatches(this.kb, data, "mcp.panel.quit")) {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }

    if (panelMatches(this.kb, data, "mcp.panel.save")) {
      this.cleanup();
      this.done(this.buildResult());
      return;
    }

    // Modal description search mode
    if (this.descSearchActive) {
      if (panelMatches(this.kb, data, "mcp.panel.cancel") || panelMatches(this.kb, data, "mcp.panel.confirm")) {
        this.descSearchActive = false;
        this.descQuery = "";
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        return;
      }
      if (panelMatches(this.kb, data, "mcp.panel.deleteBack")) {
        if (this.descQuery.length > 0) {
          this.descQuery = this.descQuery.slice(0, -1);
          this.rebuildVisibleItems();
          this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
        }
        return;
      }
      if (panelMatches(this.kb, data, "mcp.panel.navigateUp")) { this.moveCursor(-1); return; }
      if (panelMatches(this.kb, data, "mcp.panel.navigateDown")) { this.moveCursor(1); return; }
      if (panelMatches(this.kb, data, "mcp.panel.toggle")) {
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

    if (panelMatches(this.kb, data, "mcp.panel.cancel")) {
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
      this.done({ cancelled: true, changes: new Map() });
      return;
    }

    if (panelMatches(this.kb, data, "mcp.panel.navigateUp")) { this.moveCursor(-1); return; }
    if (panelMatches(this.kb, data, "mcp.panel.navigateDown")) { this.moveCursor(1); return; }

    if (panelMatches(this.kb, data, "mcp.panel.toggle")) {
      const item = this.visibleItems[this.cursorIndex];
      if (item) this.toggleItem(item);
      return;
    }

    if (panelMatches(this.kb, data, "mcp.panel.confirm")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      if (item.type === "server") {
        if (server.connectionStatus === "needs-auth") {
          this.authNotice = `OAuth required — run /mcp-auth ${server.name} after closing this panel`;
          return;
        }
        server.expanded = !server.expanded;
        this.rebuildVisibleItems();
        this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      } else if (item.toolIndex !== undefined) {
        const tool = server.tools[item.toolIndex];
        tool.isDirect = !tool.isDirect;
        if (tool.isDirect && server.source === "import") {
          this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`;
        }
        this.updateDirty();
      }
      return;
    }

    if (panelMatches(this.kb, data, "mcp.panel.pause")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      this.toggleServerPause(server);
      return;
    }

    if (panelMatches(this.kb, data, "mcp.panel.reconnect")) {
      const item = this.visibleItems[this.cursorIndex];
      if (!item) return;
      const server = this.servers[item.serverIndex];
      if (server.paused || server.connectionStatus === "connecting") return;
      server.connectionStatus = "connecting";
      this.callbacks.reconnect(server.name).then(() => {
        server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
        if (server.connectionStatus === "connected") {
          const entry = this.callbacks.refreshCacheAfterReconnect(server.name);
          if (entry) {
            this.rebuildServerTools(server, entry);
          }
          server.hasCachedData = true;
        }
        this.tui.requestRender();
      }).catch((error) => {
        server.connectionStatus = "failed";
        const message = error instanceof Error ? error.message : String(error);
        this.authNotice = `Reconnect failed for ${server.name}: ${message}`;
        this.tui.requestRender();
      });
      return;
    }

    if (panelMatches(this.kb, data, "mcp.panel.descSearch")) {
      this.descSearchActive = true;
      this.descQuery = "";
      this.rebuildVisibleItems();
      this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
      return;
    }

    // Backspace removes from name query
    if (panelMatches(this.kb, data, "mcp.panel.deleteBack")) {
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

  private toggleItem(item: VisibleItem): void {
    const server = this.servers[item.serverIndex];
    if (item.type === "server") {
      const newState = !server.tools.every((t) => t.isDirect);
      if (server.source === "import" && newState) {
        this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`;
      }
      for (const t of server.tools) t.isDirect = newState;
    } else if (item.toolIndex !== undefined) {
      const tool = server.tools[item.toolIndex];
      tool.isDirect = !tool.isDirect;
      if (tool.isDirect && server.source === "import") {
        this.importNotice = `Imported from ${server.importKind ?? "external"} — will copy to user config on save`;
      }
    }
    this.updateDirty();
  }


  private toggleServerPause(server: ServerState): void {
    // Don't allow while a reconnect/previous pause is in progress
    if (server.connectionStatus === "connecting") return;

    const wasPaused = server.paused;
    server.paused = !wasPaused;
    if (!wasPaused) {
      // Collapsing tools immediately gives snappy feedback
      server.expanded = false;
      this.rebuildVisibleItems();
    }
    this.tui.requestRender();

    const action = wasPaused ? this.callbacks.resume.bind(this.callbacks) : this.callbacks.pause.bind(this.callbacks);
    action(server.name).then(() => {
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      this.tui.requestRender();
    }).catch(() => {
      // Revert optimistic update on error
      server.paused = wasPaused;
      if (wasPaused) server.expanded = false;
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      this.rebuildVisibleItems();
      this.tui.requestRender();
    });
  }

  private handleDiscardInput(data: string): void {
    if (panelMatches(this.kb, data, "mcp.panel.quit")) {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }
    if (panelMatches(this.kb, data, "mcp.panel.cancel") || panelMatches(this.kb, data, "mcp.panel.discardCancel")) {
      this.confirmingDiscard = false;
      return;
    }
    if (panelMatches(this.kb, data, "mcp.panel.confirm")) {
      if (this.discardSelected === 0) {
        this.cleanup();
        this.done({ cancelled: true, changes: new Map() });
      } else {
        this.confirmingDiscard = false;
      }
      return;
    }
    if (panelMatches(this.kb, data, "mcp.panel.discardConfirm")) {
      this.cleanup();
      this.done({ cancelled: true, changes: new Map() });
      return;
    }
    if (panelMatches(this.kb, data, "mcp.panel.discardSwitch")) {
      this.discardSelected = this.discardSelected === 0 ? 1 : 0;
    }
  }

  private moveCursor(delta: number): void {
    if (this.visibleItems.length === 0) return;
    this.cursorIndex = Math.max(0, Math.min(this.visibleItems.length - 1, this.cursorIndex + delta));
  }

  private rebuildServerTools(server: ServerState, entry: ServerCacheEntry): void {
    const existingState = new Map<string, boolean>();
    for (const t of server.tools) existingState.set(t.name, t.isDirect);

    const newTools: ToolState[] = [];
    for (const tool of entry.tools ?? []) {
      if (isToolExcluded(tool.name, server.name, this.prefix, server.excludeTools)) {
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
        const baseName = `get_${resourceNameToToolName(resource.name)}`;
        if (isToolExcluded(baseName, server.name, this.prefix, server.excludeTools)) {
          continue;
        }

        const prev = existingState.get(baseName);
        const isDirect = prev !== undefined ? prev : false;
        const ct: CachedTool = { name: baseName, description: resource.description };
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
    this.rebuildVisibleItems();
    this.updateDirty();
  }

  private toggleServerPause(server: ServerState): void {
    // Don't allow while a reconnect/previous pause is in progress
    if (server.connectionStatus === "connecting") return;

    const wasPaused = server.paused;
    server.paused = !wasPaused;
    if (!wasPaused) {
      // Collapsing tools immediately gives snappy feedback
      server.expanded = false;
      this.rebuildVisibleItems();
    }
    this.tui.requestRender();

    const action = wasPaused ? this.callbacks.resume.bind(this.callbacks) : this.callbacks.pause.bind(this.callbacks);
    action(server.name).then(() => {
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      this.tui.requestRender();
    }).catch(() => {
      // Revert optimistic update on error
      server.paused = wasPaused;
      if (wasPaused) server.expanded = false;
      server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
      this.rebuildVisibleItems();
      this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    const innerW = width - 2;
    const lines: string[] = [];
    const t = this.t;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
    const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

    const row = (content: string) =>
      fg(t.border, "│") + truncateToWidth(" " + content, innerW, "…", true) + fg(t.border, "│");
    const emptyRow = () => fg(t.border, "│") + " ".repeat(innerW) + fg(t.border, "│");
    const divider = () => fg(t.border, "├" + "─".repeat(innerW) + "┤");

    const titleText = " MCP Servers ";
    const borderLen = innerW - visibleWidth(titleText);
    const leftB = Math.floor(borderLen / 2);
    const rightB = borderLen - leftB;
    lines.push(fg(t.border, "╭" + "─".repeat(leftB)) + fg(t.title, titleText) + fg(t.border, "─".repeat(rightB) + "╮"));

    lines.push(emptyRow());

    const cursor = fg(t.selected, "│");
    const searchIcon = fg(t.border, "◎");
    if (this.descSearchActive) {
      lines.push(row(`${searchIcon}  ${fg(t.needsAuth, "desc:")} ${this.descQuery}${cursor}`));
    } else if (this.nameQuery) {
      lines.push(row(`${searchIcon}  ${this.nameQuery}${cursor}`));
    } else {
      lines.push(row(`${searchIcon}  ${fg(t.placeholder, italic("search..."))}`));
    }

    lines.push(emptyRow());
    if (this.noticeLines.length > 0) {
      for (const notice of this.noticeLines) {
        lines.push(row(fg(t.hint, italic(notice))));
      }
      lines.push(emptyRow());
    }
    lines.push(divider());

    if (this.servers.length === 0) {
      lines.push(emptyRow());
      lines.push(row(fg(t.hint, italic("No MCP servers configured."))));
      lines.push(emptyRow());
    } else {
      const maxVis = McpPanel.MAX_VISIBLE;
      const total = this.visibleItems.length;
      const startIdx = Math.max(0, Math.min(this.cursorIndex - Math.floor(maxVis / 2), total - maxVis));
      const endIdx = Math.min(startIdx + maxVis, total);

      lines.push(emptyRow());

      for (let i = startIdx; i < endIdx; i++) {
        const item = this.visibleItems[i];
        const isCursor = i === this.cursorIndex;
        const server = this.servers[item.serverIndex];

        if (item.type === "server") {
          lines.push(row(this.renderServerRow(server, isCursor)));
        } else if (item.toolIndex !== undefined) {
          lines.push(row(this.renderToolRow(server.tools[item.toolIndex], isCursor, innerW)));
        }
      }

      lines.push(emptyRow());

      if (total > maxVis) {
        const prog = Math.round(((this.cursorIndex + 1) / total) * 10);
        lines.push(row(`${rainbowProgress(prog, 10)}  ${fg(t.hint, `${this.cursorIndex + 1}/${total}`)}`));
        lines.push(emptyRow());
      }

      if (this.importNotice) {
        lines.push(row(fg(t.needsAuth, italic(this.importNotice))));
        lines.push(emptyRow());
      }
      if (this.authNotice) {
        lines.push(row(fg(t.needsAuth, italic(this.authNotice))));
        lines.push(emptyRow());
      }
    }

    lines.push(divider());
    lines.push(emptyRow());

    if (this.confirmingDiscard) {
      const discardBtn = this.discardSelected === 0
        ? inverse(bold(fg(t.cancel, "  Discard  ")))
        : fg(t.hint, "  Discard  ");
      const keepBtn = this.discardSelected === 1
        ? inverse(bold(fg(t.confirm, "  Keep  ")))
        : fg(t.hint, "  Keep  ");
      lines.push(row(`Discard unsaved changes?  ${discardBtn}   ${keepBtn}`));
    } else {
      const directCount = this.servers.reduce((sum, s) => sum + s.tools.filter((t) => t.isDirect).length, 0);
      const totalTokens = this.servers.reduce(
        (sum, s) => sum + s.tools.filter((t) => t.isDirect).reduce((ts, t) => ts + t.estimatedTokens, 0),
        0,
      );
      const stats =
        directCount > 0 ? `${directCount} direct  ~${totalTokens.toLocaleString()} tokens` : "no direct tools";
      lines.push(row(fg(t.description, stats + (this.dirty ? fg(t.needsAuth, "  (unsaved)") : ""))));
    }

    lines.push(emptyRow());
    const upKey       = fmtKey(panelKeys(this.kb, "mcp.panel.navigateUp")[0]   ?? "up");
    const dnKey       = fmtKey(panelKeys(this.kb, "mcp.panel.navigateDown")[0] ?? "down");
    const toggleKey   = fmtKey(panelKeys(this.kb, "mcp.panel.toggle")[0]       ?? "space");
    const confirmKey  = fmtKey(panelKeys(this.kb, "mcp.panel.confirm")[0]      ?? "return");
    const reconnKey   = fmtKey(panelKeys(this.kb, "mcp.panel.reconnect")[0]    ?? "ctrl+r");
    const pauseKey    = fmtKey(panelKeys(this.kb, "mcp.panel.pause")[0]        ?? "ctrl+x");
    const dsearchKey  = fmtKey(panelKeys(this.kb, "mcp.panel.descSearch")[0]   ?? "?");
    const saveKey     = fmtKey(panelKeys(this.kb, "mcp.panel.save")[0]         ?? "ctrl+s");
    const cancelKey   = fmtKey(panelKeys(this.kb, "mcp.panel.cancel")[0]       ?? "escape");
    const quitKey     = fmtKey(panelKeys(this.kb, "mcp.panel.quit")[0]         ?? "ctrl+c");
    const navStr      = upKey === "↑" && dnKey === "↓" ? "↑↓" : `${upKey}/${dnKey}`;
    const hints = [
      italic(navStr)       + " navigate",
      italic(toggleKey)    + " toggle",
      italic(confirmKey)   + " expand",
      italic(reconnKey)    + " reconnect",
      italic(pauseKey)     + " pause/resume",
      italic(dsearchKey)   + " desc search",
      italic(saveKey)      + " save",
      italic(cancelKey)    + " clear/close",
      italic(quitKey)      + " quit",
    ];
    const gap = "  ";
    const gapW = 2;
    const maxW = innerW - 2;
    let curLine = "";
    let curW = 0;
    for (const hint of hints) {
      const hw = visibleWidth(hint);
      const needed = curW === 0 ? hw : gapW + hw;
      if (curW > 0 && curW + needed > maxW) {
        lines.push(row(fg(t.hint, curLine)));
        curLine = hint;
        curW = hw;
      } else {
        curLine += (curW > 0 ? gap : "") + hint;
        curW += needed;
      }
    }
    if (curLine) lines.push(row(fg(t.hint, curLine)));

    lines.push(fg(t.border, "╰" + "─".repeat(innerW) + "╯"));

    return lines;
  }

  private renderServerRow(server: ServerState, isCursor: boolean): string {
    const t = this.t;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

    const importLabel = server.source === "import" ? fg(t.description, ` (${server.importKind ?? "import"})`) : "";

    if (server.paused) {
      const pauseIcon = fg(t.hint, "⏸");
      const dot = fg(t.hint, "·");
      const nameStr = isCursor ? bold(fg(t.selected, server.name)) : fg(t.hint, server.name);
      const toolCount = server.tools.length;
      const label = fg(t.hint, `(paused, ${toolCount} tool${toolCount === 1 ? "" : "s"} hidden)`);
      return `${pauseIcon} ${dot} ${nameStr}${importLabel}  ${label}`;
    }

    const expandIcon = server.expanded ? "▾" : "▸";
    const prefix = isCursor ? fg(t.selected, expandIcon) : fg(t.border, server.expanded ? expandIcon : "·");

    const nameStr = isCursor ? bold(fg(t.selected, server.name)) : server.name;

    if (!server.hasCachedData) {
      return `${prefix}   ${nameStr}${importLabel}  ${fg(t.description, "(not cached)")}`;
    }

    const directCount = server.tools.filter((t) => t.isDirect).length;
    const totalCount = server.tools.length;
    let toggleIcon = fg(t.description, "○");
    if (directCount === totalCount && totalCount > 0) {
      toggleIcon = fg(t.direct, "●");
    } else if (directCount > 0) {
      toggleIcon = fg(t.needsAuth, "◐");
    }

    let toolInfo = "";
    if (totalCount > 0) {
      toolInfo = `${directCount}/${totalCount}`;
      if (directCount > 0) {
        const tokens = server.tools.filter((t) => t.isDirect).reduce((s, t) => s + t.estimatedTokens, 0);
        toolInfo += `  ~${tokens.toLocaleString()}`;
      }
      toolInfo = fg(t.description, toolInfo);
    }

    return `${prefix} ${toggleIcon} ${nameStr}${importLabel}  ${toolInfo}`;
  }

  private renderToolRow(tool: ToolState, isCursor: boolean, innerW: number): string {
    const t = this.t;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

    const toggleIcon = tool.isDirect ? fg(t.direct, "●") : fg(t.description, "○");
    const cursor = isCursor ? fg(t.selected, "▸") : " ";
    const nameStr = isCursor ? bold(fg(t.selected, tool.name)) : tool.name;

    const prefixLen = 7 + visibleWidth(tool.name);
    const maxDescLen = Math.max(0, innerW - prefixLen - 8);
    const descStr =
      maxDescLen > 5 && tool.description
        ? fg(t.description, "— " + truncateToWidth(tool.description, maxDescLen, "…"))
        : "";

    return `  ${cursor} ${toggleIcon} ${nameStr} ${descStr}`;
  }

  invalidate(): void {}

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
  piKeybindings: KeybindingsManager,
  done: (result: McpPanelResult) => void,
  options?: { noticeLines?: string[] },
): McpPanel & { dispose(): void } {
  return new McpPanel(config, cache, provenance, callbacks, tui, piKeybindings, done, options?.noticeLines ?? []);
}
