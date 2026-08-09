import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDirectToolExecutor, getMissingConfiguredDirectToolServers, resolveDirectTools } from "../direct-tools.ts";
import { executeAuthStart, executeCall, executeConnect, executeDescribe, executeInstructions, executeList, executeSearch, executeStatus } from "../proxy-modes.ts";
import { initializeMcp, updateStatusBar } from "../init.ts";
import { loadMcpConfig, writeProjectServerDisabledOverride } from "../config.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import { McpServerManager } from "../server-manager.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

const cache: MetadataCache = {
  version: 1,
  servers: {
    disabled: {
      configHash: "disabled-cache",
      cachedAt: Date.now(),
      tools: [{ name: "search", description: "disabled search" }],
      resources: [{ name: "doc", uri: "mcp://doc" }],
      instructions: "disabled instructions",
    },
    enabled: {
      configHash: "enabled-cache",
      cachedAt: Date.now(),
      tools: [{ name: "search", description: "enabled search" }],
      resources: [],
    },
  },
};

function disabledState() {
  const connection = {
    status: "connected",
    tools: [{ name: "search" }],
    resources: [],
    client: { callTool: vi.fn(), readResource: vi.fn() },
  };
  return {
    config: { mcpServers: { disabled: { command: "node", disabled: true }, enabled: { command: "node" } } },
    toolMetadata: new Map([["disabled", [{ name: "disabled_search", originalName: "search", description: "cached" }]]]),
    serverInstructions: new Map([["disabled", "cached instructions"]]),
    manager: {
      getConnection: vi.fn((name: string) => name === "disabled" ? connection : undefined),
      getAllConnections: vi.fn(() => new Map([["disabled", connection]])),
      isConnecting: vi.fn(() => false),
      connect: vi.fn(),
      close: vi.fn(),
    },
    failureTracker: new Map(),
    failureMessages: new Map(),
    owner: { signal: new AbortController().signal },
    ui: undefined,
  } as any;
}

afterEach(() => vi.restoreAllMocks());

describe("disabled MCP servers", () => {
  it("only literal true disables direct tools and configured bootstrap", () => {
    const config = {
      settings: { directTools: true },
      mcpServers: {
        disabled: { command: "node", disabled: true },
        string: { command: "node", disabled: "true" as unknown as boolean },
        enabled: { command: "node" },
      },
    };
    const directCache = {
      ...cache,
      servers: {
        disabled: { ...cache.servers.disabled, configHash: computeServerHash(config.mcpServers.disabled) },
        string: { ...cache.servers.enabled, configHash: computeServerHash(config.mcpServers.string) },
        enabled: { ...cache.servers.enabled, configHash: computeServerHash(config.mcpServers.enabled) },
      },
    };

    expect(resolveDirectTools(config, directCache, "server").map((spec) => spec.serverName).sort()).toEqual(["enabled", "string"]);
    expect(getMissingConfiguredDirectToolServers(config, directCache)).not.toContain("disabled");
  });

  it("rejects stale direct executors before connect or auth", async () => {
    const state = disabledState();
    const execute = createDirectToolExecutor(() => state, () => null, {
      serverName: "disabled",
      originalName: "search",
      prefixedName: "disabled_search",
      description: "cached",
    });

    const result = await execute("call", {}, undefined, undefined, {} as any);
    expect(result.details).toMatchObject({ error: "server_disabled", server: "disabled" });
    expect(result.content[0].text).toContain("/reload");
    expect(state.manager.connect).not.toHaveBeenCalled();
  });

  it("rejects proxy execution and hides disabled cached metadata while listing it in status", async () => {
    const state = disabledState();
    expect(executeStatus(state).content[0].text).toContain("disabled");
    expect(executeStatus(state).content[0].text).toContain("0/1 servers");
    expect(executeList(state, "disabled").details).toMatchObject({ error: "server_disabled" });
    expect(executeInstructions(state, "disabled").details).toMatchObject({ error: "server_disabled" });
    state.toolMetadata.set("enabled", [{ name: "disabled_search", originalName: "search", description: "enabled duplicate" }]);
    expect(executeDescribe(state, "disabled_search").details).toMatchObject({ server: "enabled" });
    state.toolMetadata.delete("enabled");
    expect(executeDescribe(state, "disabled_search").details).toMatchObject({ error: "server_disabled" });
    expect(executeSearch(state, "cached").details).toMatchObject({ count: 0 });
    expect(executeSearch(state, "cached", false, "disabled").details).toMatchObject({ error: "server_disabled" });
    expect((await executeCall(state, "disabled_search", {})).details).toMatchObject({ error: "server_disabled" });
    expect((await executeCall(state, "disabled_search", {}, "disabled")).details).toMatchObject({ error: "server_disabled" });
    expect((await executeConnect(state, "disabled")).details).toMatchObject({ error: "server_disabled" });
    expect((await executeAuthStart(state, "disabled")).details).toMatchObject({ error: "server_disabled" });
    expect(state.manager.connect).not.toHaveBeenCalled();
  });

  it("rejects manager and UI resource connections for disabled definitions", async () => {
    const manager = new McpServerManager();
    await expect(manager.connect("disabled", { command: "node", disabled: true })).rejects.toThrow("disabled");
    const handler = new UiResourceHandler({
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getConnection: vi.fn(),
    } as any, { mcpServers: { disabled: { url: "https://example.test", disabled: true } } });
    await expect(handler.readUiResource("disabled", "ui://example")).rejects.toThrow("disabled");
  });

  it("writes only a project-local disabled override and removes it cleanly", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-disabled-override-"));
    const filePath = join(cwd, ".pi", "mcp.json");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(filePath, JSON.stringify({ unrelated: { keep: true }, mcpServers: {
      disabled: { disabled: false, directTools: true },
      onlyFlag: { disabled: true },
    }}));

    expect(writeProjectServerDisabledOverride(undefined, cwd, "disabled", true)).toMatchObject({ changed: true, path: filePath });
    const disabledRaw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(disabledRaw.unrelated).toEqual({ keep: true });
    expect(disabledRaw.mcpServers.disabled).toEqual({ disabled: true, directTools: true });

    expect(writeProjectServerDisabledOverride(undefined, cwd, "onlyFlag", false)).toMatchObject({ changed: true });
    const enabledRaw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(enabledRaw.mcpServers.onlyFlag).toBeUndefined();
    expect(enabledRaw.mcpServers.disabled.directTools).toBe(true);
  });

  it("writes an explicit enabled override when a lower config disables the server", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-disabled-layer-"));
    const overridePath = join(cwd, "factory.json");
    writeFileSync(overridePath, JSON.stringify({ mcpServers: { lower: { command: "node", disabled: true } } }));

    expect(writeProjectServerDisabledOverride(overridePath, cwd, "lower", false)).toMatchObject({ changed: true });
    expect(JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8")).mcpServers.lower).toEqual({ disabled: false });
    expect(loadMcpConfig(overridePath, cwd).mcpServers.lower.disabled).toBe(false);
  });

  it("enables a server disabled by an import declared in the project override", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-disabled-project-import-"));
    mkdirSync(join(cwd, ".vscode"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".vscode", "mcp.json"), JSON.stringify({
      mcpServers: { imported: { command: "node", disabled: true } },
    }));
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({
      imports: ["vscode"],
      mcpServers: { imported: { disabled: true } },
    }));

    expect(writeProjectServerDisabledOverride(undefined, cwd, "imported", false)).toMatchObject({ changed: true });
    expect(JSON.parse(readFileSync(join(cwd, ".pi", "mcp.json"), "utf8")).mcpServers.imported).toEqual({ disabled: false });
    expect(loadMcpConfig(undefined, cwd).mcpServers.imported).toMatchObject({ command: "node", disabled: false });
  });

  it("preserves the supported raw server-map key while updating an override", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-disabled-alias-"));
    const filePath = join(cwd, ".pi", "mcp.json");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(filePath, JSON.stringify({ "mcp-servers": { alias: { command: "node", args: ["server"] } } }));

    expect(writeProjectServerDisabledOverride(undefined, cwd, "alias", true)).toMatchObject({ changed: true });
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.mcpServers).toBeUndefined();
    expect(raw["mcp-servers"].alias).toEqual({ command: "node", args: ["server"], disabled: true });
    expect(loadMcpConfig(undefined, cwd).mcpServers.alias).toMatchObject({ command: "node", args: ["server"], disabled: true });
  });

  it("preserves malformed project overrides instead of replacing them", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-disabled-malformed-"));
    const filePath = join(cwd, ".pi", "mcp.json");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(filePath, "{ malformed");

    expect(() => writeProjectServerDisabledOverride(undefined, cwd, "server", true)).toThrow("Failed to read project MCP override");
    expect(readFileSync(filePath, "utf8")).toBe("{ malformed");
  });

  it("initializes all-disabled config without attempting connections or cache bootstrap", async () => {
    const notify = vi.fn();
    const state = await initializeMcp({ getFlag: vi.fn() } as any, {
      cwd: mkdtempSync(join(tmpdir(), "pi-mcp-disabled-init-")),
      hasUI: true,
      mode: "tui",
      ui: { notify, setStatus: vi.fn() },
      signal: new AbortController().signal,
    } as any, undefined, { config: { mcpServers: { one: { command: "node", disabled: true } } } });

    expect(notify).toHaveBeenCalledWith("MCP: All 1 server(s) are disabled", "info");
    expect(state.manager.getAllConnections().size).toBe(0);
  });

  it("connects only enabled servers during mixed eager initialization", async () => {
    const connect = vi.spyOn(McpServerManager.prototype, "connect").mockResolvedValue({
      status: "connected",
      tools: [],
      resources: [],
    } as any);
    await initializeMcp({ getFlag: vi.fn() } as any, {
      cwd: mkdtempSync(join(tmpdir(), "pi-mcp-disabled-mixed-")),
      hasUI: false,
      mode: "json",
      signal: new AbortController().signal,
    } as any, undefined, { config: { mcpServers: {
      disabled: { command: "node", lifecycle: "eager", disabled: true },
      enabled: { command: "node", lifecycle: "eager" },
    } } });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("enabled", expect.objectContaining({ lifecycle: "eager" }), expect.any(AbortSignal));
  });

  it("keeps no-theme status usable and reports disabled count", () => {
    const setStatus = vi.fn();
    updateStatusBar({
      ...disabledState(),
      ui: { setStatus, theme: undefined },
    });
    expect(setStatus).toHaveBeenCalledWith("mcp", "🔌 MCP: 1 server enabled (1 disabled)");
  });
});
