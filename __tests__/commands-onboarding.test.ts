import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

const mocks = {
  createMcpPanel: vi.fn(),
  createMcpSetupPanel: vi.fn(),
};

vi.mock("../mcp-panel.ts", () => ({
  createMcpPanel: mocks.createMcpPanel,
}));

vi.mock("../mcp-setup-panel.ts", () => ({
  createMcpSetupPanel: mocks.createMcpSetupPanel,
}));

describe("commands onboarding", () => {
  const originalHome = process.env.HOME;
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
    mocks.createMcpPanel.mockReset().mockImplementation((_config, _cache, _prov, _callbacks, _tui, done) => {
      done({ cancelled: true, changes: new Map() });
      return { dispose() {} };
    });
    mocks.createMcpSetupPanel.mockReset().mockImplementation((_discovery, _callbacks, _options, _tui, done) => {
      done();
      return { dispose() {} };
    });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
    process.chdir(originalCwd);
  });

  function createUi() {
    return {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn((renderer: any) => renderer({ requestRender: vi.fn() }, {}, {}, vi.fn())),
    };
  }

  it("opens setup mode when no MCP servers are configured", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-commands-home-"));
    const ui = createUi();
    const { openMcpPanel } = await import("../commands.ts");

    await openMcpPanel({
      config: { mcpServers: {} },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", ui } as any);

    expect(mocks.createMcpSetupPanel).toHaveBeenCalled();
    expect(mocks.createMcpPanel).not.toHaveBeenCalled();
  });

  it("shows a one-time shared-config notice in the MCP panel", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-commands-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-commands-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        sharedServer: { command: "shared" },
      },
    });

    const ui = createUi();
    const { loadMcpConfig } = await import("../config.ts");
    const { openMcpPanel } = await import("../commands.ts");
    const { loadOnboardingState } = await import("../onboarding-state.ts");

    await openMcpPanel({
      config: loadMcpConfig(),
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", ui } as any);

    expect(mocks.createMcpPanel).toHaveBeenCalled();
    const options = mocks.createMcpPanel.mock.calls[0]?.[6];
    expect(options.noticeLines[0]).toContain("Using standard MCP config");
    expect(loadOnboardingState().sharedConfigHintShown).toBe(true);
  });

  it("does not inspect host-specific configs when opening the MCP panel", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-commands-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-commands-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: { sharedServer: { command: "shared" } },
    });
    writeFileSync(join(home, ".claude.json"), "{ malformed", "utf-8");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), "{ malformed", "utf-8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ui = createUi();
    const { loadMcpConfig } = await import("../config.ts");
    const { openMcpPanel } = await import("../commands.ts");

    await openMcpPanel({
      config: loadMcpConfig(),
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", ui, cwd: process.cwd() } as any);

    expect(mocks.createMcpPanel).toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("does not inspect host-specific configs when /mcp opens empty setup", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-commands-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-commands-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeFileSync(join(home, ".claude.json"), "{ malformed", "utf-8");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), "{ malformed", "utf-8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ui = createUi();
    const { openMcpPanel } = await import("../commands.ts");

    await openMcpPanel({
      config: { mcpServers: {} },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", ui, cwd: process.cwd() } as any);

    expect(mocks.createMcpSetupPanel).toHaveBeenCalled();
    const discovery = mocks.createMcpSetupPanel.mock.calls[0]?.[0];
    expect(discovery.imports).toEqual([]);
    expect(discovery.hostConfigs).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("clears OAuth credentials, cancels pending auth, and closes the server on logout", async () => {
    process.env.MCP_OAUTH_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-commands-logout-"));
    const ui = createUi();
    const close = vi.fn();
    const { getAuthEntry, updateOAuthState, updateTokens } = await import("../mcp-auth.ts");
    const { waitForCallback } = await import("../mcp-callback-server.ts");
    const { logoutServer } = await import("../commands.ts");

    updateTokens("oauth-server", { accessToken: "token", refreshToken: "refresh" }, "https://example.com/mcp");
    updateOAuthState("oauth-server", "pending-state", "https://example.com/mcp");
    const pendingCallback = waitForCallback("pending-state");
    const pendingCallbackRejection = expect(pendingCallback).rejects.toThrow("Authorization cancelled");

    const result = await logoutServer("oauth-server", {
      config: { mcpServers: { "oauth-server": { url: "https://example.com/mcp", auth: "oauth" } } },
      manager: { close },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { hasUI: true, mode: "tui", ui } as any);

    await pendingCallbackRejection;
    expect(result.ok).toBe(true);
    expect(getAuthEntry("oauth-server")).toBeUndefined();
    expect(close).toHaveBeenCalledWith("oauth-server");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("OAuth credentials cleared"), "info");
  });

  it("marks explicit OAuth servers as needs-auth when only stale URL tokens exist", async () => {
    process.env.MCP_OAUTH_DIR = mkdtempSync(join(tmpdir(), "pi-mcp-commands-oauth-"));
    const ui = createUi();
    const { updateTokens } = await import("../mcp-auth.ts");
    const { openMcpPanel } = await import("../commands.ts");

    updateTokens("legacy", { accessToken: "legacy-token" });
    updateTokens("stale", { accessToken: "stale-token" }, "https://old.example.com/mcp");

    await openMcpPanel({
      config: {
        mcpServers: {
          legacy: { url: "https://new.example.com/mcp", auth: "oauth" },
          stale: { url: "https://new.example.com/mcp", auth: "oauth" },
        },
      },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", ui } as any);

    const callbacks = mocks.createMcpPanel.mock.calls[0]?.[3];
    expect(callbacks.getConnectionStatus("legacy")).toBe("needs-auth");
    expect(callbacks.getConnectionStatus("stale")).toBe("needs-auth");
  });

  it("panel reconnect force-clears stale needs-auth state", async () => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "pi-mcp-commands-reconnect-"));
    const ui = createUi();
    const { updateTokens } = await import("../mcp-auth.ts");
    updateTokens("notion", { accessToken: "token" }, "https://mcp.notion.com/mcp");
    let currentConnection: any = { status: "needs-auth" };
    const close = vi.fn(async () => {
      currentConnection = null;
    });
    const connect = vi.fn(async () => {
      currentConnection = {
        status: "connected",
        tools: [{ name: "search", description: "Search" }],
        resources: [],
      };
      return currentConnection;
    });
    const state = {
      config: { mcpServers: { notion: { url: "https://mcp.notion.com/mcp", auth: "oauth" } } },
      manager: {
        close,
        connect,
        getConnection: vi.fn(() => currentConnection),
        getAllConnections: vi.fn(() => new Map(currentConnection?.status === "connected" ? [["notion", currentConnection]] : [])),
      },
      toolMetadata: new Map(),
      serverInstructions: new Map(),
      failureTracker: new Map([["notion", Date.now()]]),
      lifecycle: { markKeepAlive: vi.fn() },
    } as any;
    const { openMcpPanel } = await import("../commands.ts");

    await openMcpPanel(state, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", ui } as any);

    const callbacks = mocks.createMcpPanel.mock.calls[0]?.[3];
    await expect(callbacks.reconnect("notion")).resolves.toBe(true);

    expect(close).toHaveBeenCalledWith("notion");
    expect(connect).toHaveBeenCalledWith("notion", state.config.mcpServers.notion);
    expect(state.failureTracker.has("notion")).toBe(false);
    expect(state.toolMetadata.get("notion")?.[0]?.name).toBe("notion_search");
    expect(callbacks.getConnectionStatus("notion")).toBe("connected");
  });
});
