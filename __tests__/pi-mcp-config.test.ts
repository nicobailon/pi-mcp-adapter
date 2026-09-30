import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { McpPanelCallbacks } from "../types.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Pi mcp.json config sources", () => {
  let root: string;
  let home: string;
  let cwd: string;
  let piGlobal: string;
  let piProject: string;

  beforeEach(() => {
    vi.resetModules();
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-json-")));
    home = join(root, "home");
    cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    piGlobal = join(home, ".pi", "agent", "mcp.json");
    piProject = join(cwd, ".pi", "mcp.json");
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", "");
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  async function loadConfigModule(piSupportsMcp = true) {
    const config = await import("../config.ts");
    config.setPiMcpConfigEnabled(piSupportsMcp);
    return config;
  }

  it("places each Pi file right below the adapter file in the same folder", async () => {
    writeJson(join(home, ".agents", "mcp", "mcp.json"), { mcpServers: { a: { command: "agents" } } });
    writeJson(piGlobal, { mcpServers: { a: { command: "pi-global" }, b: { command: "pi-global" } } });
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { mcpServers: { b: { command: "adapter" }, e: { command: "adapter" } } });
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { c: { command: "shared-project" } } });
    writeJson(piProject, { mcpServers: { c: { command: "pi-project" }, d: { command: "pi-project" }, e: { command: "pi-project" } } });
    writeJson(join(cwd, ".pi", "mcp-adapter.json"), { mcpServers: { d: { command: "adapter-project" } } });
    const { loadMcpConfig } = await loadConfigModule();

    expect(loadMcpConfig(undefined, cwd).mcpServers).toEqual({
      a: { command: "pi-global" },
      b: { command: "adapter" },
      c: { command: "pi-project" },
      d: { command: "adapter-project" },
      e: { command: "pi-project" },
    });

    // An explicit --mcp-config replaces only the adapter file; Pi's files are still read.
    const override = join(root, "override.json");
    writeJson(override, { mcpServers: { b: { command: "override" } } });
    expect(loadMcpConfig(override, cwd).mcpServers).toMatchObject({ a: { command: "pi-global" }, b: { command: "override" } });
  });

  it("replaces a global Pi entry with the project Pi entry of the same name instead of merging fields", async () => {
    writeJson(join(home, ".config", "mcp", "mcp.json"), { mcpServers: { shared: { command: "a", env: { KEEP: "1" } } } });
    writeJson(piGlobal, {
      mcpServers: { docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer global" }, timeout: 5, exposure: "direct" } },
    });
    writeJson(piProject, { mcpServers: { docs: { url: "https://docs.example/mcp" }, shared: { command: "b" } } });
    const { loadMcpConfig } = await loadConfigModule();

    const servers = loadMcpConfig(undefined, cwd).mcpServers;
    expect(servers.docs).toEqual({ url: "https://docs.example/mcp" });
    // The rest of the chain still merges field by field.
    expect(servers.shared).toEqual({ command: "b", env: { KEEP: "1" } });
  });

  it.each([
    ["enabled: false", { command: "srv", enabled: false }, { command: "srv", disabled: true }],
    ["timeout in seconds", { command: "srv", timeout: 2.5 }, { command: "srv", requestTimeoutMs: 2500 }],
    [
      "oauth client fields",
      { url: "https://x.example/mcp", oauth: { clientId: "id", clientSecret: "${SECRET}", scope: "a b", clientName: "Pi" } },
      { url: "https://x.example/mcp", oauth: { clientId: "id", clientSecret: "${SECRET}", scope: "a b", clientName: "Pi" } },
    ],
    [
      "oauth.callbackPort",
      { url: "https://x.example/mcp", oauth: { callbackPort: 8123 } },
      { url: "https://x.example/mcp", oauth: { redirectUri: "http://127.0.0.1:8123/callback" } },
    ],
    [
      "oauth.callbackUrl with a port",
      { url: "https://x.example/mcp", oauth: { callbackUrl: "http://localhost:8080/oauth/callback" } },
      { url: "https://x.example/mcp", oauth: { redirectUri: "http://localhost:8080/oauth/callback" } },
    ],
    [
      "oauth.callbackUrl without a port, with callbackPort",
      { url: "https://x.example/mcp", oauth: { callbackUrl: "http://localhost/oauth/callback", callbackPort: 9000 } },
      { url: "https://x.example/mcp", oauth: { redirectUri: "http://localhost:9000/oauth/callback" } },
    ],
    [
      "oauth.callbackUrl without a port",
      { url: "https://x.example/mcp", oauth: { callbackUrl: "http://[::1]/oauth/callback" } },
      { url: "https://x.example/mcp", oauth: { redirectUri: "http://[::1]:{port}/oauth/callback" } },
    ],
    ["exposure: direct", { command: "srv", exposure: "direct" }, { command: "srv", directTools: true }],
    ["exposure: deferred", { command: "srv", exposure: "deferred" }, { command: "srv", directTools: "search" }],
    ["exposure: codemode", { command: "srv", exposure: "codemode" }, { command: "srv" }],
    ["exposure: hidden", { command: "srv", exposure: "hidden" }, { command: "srv", disabled: true }],
    [
      "toolExposure exact names set to direct",
      { command: "srv", toolExposure: { read_file: "direct", list_dir: "direct" } },
      { command: "srv", directTools: ["read_file", "list_dir"] },
    ],
    [
      "toolExposure exact names set to hidden",
      { command: "srv", exposure: "direct", toolExposure: { delete_file: "hidden" } },
      { command: "srv", directTools: true, excludeTools: ["delete_file"] },
    ],
    [
      "stdio fields",
      { type: "stdio", command: "srv", args: ["--flag"], env: { TOKEN: "${TOKEN}" }, cwd: "tools", description: "Tools" },
      { command: "srv", args: ["--flag"], env: { TOKEN: "${TOKEN}" }, cwd: "tools", description: "Tools" },
    ],
    [
      "http fields",
      { type: "streamable-http", url: "https://x.example/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
      { url: "https://x.example/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
    ],
    ["auth.provider", { url: "https://x.example/mcp", auth: { provider: "github" } }, { url: "https://x.example/mcp", auth: { provider: "github" } }],
  ])("translates %s", async (_row, piEntry, adapterEntry) => {
    writeJson(piGlobal, { mcpServers: { server: piEntry } });
    const { loadMcpConfig } = await loadConfigModule();

    expect(loadMcpConfig(undefined, cwd).mcpServers.server).toEqual(adapterEntry);
  });

  it("skips SSE entries and auth.provider over plain http, and reports them with old adapter keys in one notice per file", async () => {
    writeJson(piGlobal, {
      settings: { toolPrefix: "short" },
      imports: ["cursor"],
      autoEnableCodemode: false,
      mcpServers: {
        legacy: { type: "sse", url: "https://sse.example/sse" },
        provider: { url: "http://provider.example/mcp", auth: { provider: "github" } },
        kept: { command: "kept" },
      },
    });
    writeJson(piProject, { mcpServers: { tuned: { command: "tuned", exposure: "direct", toolExposure: { "read_*": "codemode" }, lifecycle: "eager" } } });
    const { getLegacyMcpMigrationNotices, loadMcpConfig } = await loadConfigModule();

    const config = loadMcpConfig(undefined, cwd);
    expect(config.mcpServers).toEqual({
      kept: { command: "kept" },
      tuned: { command: "tuned", directTools: true },
    });
    expect(config.settings).toBeUndefined();
    expect(getLegacyMcpMigrationNotices(cwd)).toEqual([
      `${piGlobal}: pi-mcp-adapter does not read settings, imports in this file; move them into ${join(home, ".pi", "agent", "mcp-adapter.json")}. Skipped "legacy" (legacy SSE transport is not supported; use the streamable HTTP URL); "provider" (auth.provider requires an https URL, or http on localhost, 127.0.0.1, or [::1]).`,
      `${piProject}: Ignored settings (details in /mcp-adapter): "tuned": lifecycle, toolExposure "read_*": codemode.`,
    ]);
  });

  it("strips project-scope auth.provider servers, including project overrides of global ones, with one notice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeJson(piGlobal, {
      mcpServers: {
        github: { url: "https://api.example/mcp", auth: { provider: "github" } },
        local: { url: "http://127.0.0.1:8080/mcp", auth: { provider: "github" } },
      },
    });
    writeJson(piProject, { mcpServers: { fromPi: { url: "https://pi.example/mcp", auth: { provider: "github" } } } });
    writeJson(join(cwd, ".pi", "mcp-adapter.json"), { mcpServers: { fromAdapter: { url: "https://adapter.example/mcp", auth: { provider: "github" } } } });
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { github: { lifecycle: "eager" } } });
    const { loadMcpConfigWithSources } = await loadConfigModule();

    const loaded = loadMcpConfigWithSources(undefined, cwd);
    expect(loaded.config.mcpServers).toEqual({ local: { url: "http://127.0.0.1:8080/mcp", auth: { provider: "github" } } });
    expect([...loaded.projectServers.keys()]).toEqual([]);
    expect(warn.mock.calls).toEqual([[
      'Ignoring MCP servers "github", "fromPi", "fromAdapter": auth.provider is only allowed in user-global config, and project config defines or overrides them',
    ]]);
  });

  it("drops an inherited auth.provider when a higher-precedence file changes the server's url", async () => {
    writeJson(join(home, ".config", "mcp", "mcp.json"), { mcpServers: { api: { url: "https://api.example/mcp", auth: { provider: "github" } } } });
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { mcpServers: { api: { url: "https://other.example/mcp" } } });
    const { loadMcpConfig } = await loadConfigModule();

    expect(loadMcpConfig(undefined, cwd).mcpServers.api).toEqual({ url: "https://other.example/mcp" });
  });

  it("rejects adapter-config auth.provider servers without a provider name or on plain http outside loopback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), {
      mcpServers: {
        plain: { url: "http://api.example/mcp", auth: { provider: "github" } },
        unnamed: { url: "https://api.example/mcp", auth: { provider: "" } },
        kept: { url: "https://api.example/mcp", auth: { provider: "github" } },
      },
    });
    const { loadMcpConfig } = await loadConfigModule();

    expect(loadMcpConfig(undefined, cwd).mcpServers).toEqual({ kept: { url: "https://api.example/mcp", auth: { provider: "github" } } });
    expect(warn).toHaveBeenCalledWith('Ignoring MCP server "plain": auth.provider requires an https URL, or http on localhost, 127.0.0.1, or [::1]');
    expect(warn).toHaveBeenCalledWith('Ignoring MCP server "unnamed": auth.provider must be a provider name');
  });

  it("never exposes a tool Pi hides", async () => {
    // `tuned_x` is also the prefixed name of tool `x`, and `?` is literal in Pi but a wildcard here.
    const toolExposure = { tuned_x: "hidden", "write_*": "hidden", "what?": "hidden" };
    writeJson(piGlobal, { mcpServers: { tuned: { command: "tuned", exposure: "direct", toolExposure } } });
    const { loadMcpConfig } = await loadConfigModule();
    const { isToolAllowed } = await import("../types.ts");

    const { includeTools, excludeTools } = loadMcpConfig(undefined, cwd).mcpServers.tuned!;
    const allowed = (tool: string) => isToolAllowed(tool, "tuned", "server", includeTools, excludeTools);
    expect(["tuned_x", "write_file", "what?"].filter(allowed)).toEqual([]);
    expect(allowed("read_file")).toBe(true);
  });

  it("lists untranslated settings in the server's /mcp-adapter detail", async () => {
    writeJson(piGlobal, { mcpServers: { tuned: { command: "tuned", toolExposure: { "search_*": "direct" } } } });
    const { getServerProvenance, loadMcpConfig } = await loadConfigModule();
    const { createMcpPanel } = await import("../mcp-panel.ts");
    const callbacks: McpPanelCallbacks = {
      reconnect: async () => true,
      canAuthenticate: () => false,
      authenticate: async () => ({ ok: false }),
      getConnectionStatus: () => "idle",
      refreshCacheAfterReconnect: () => null,
    };

    const panel = createMcpPanel(loadMcpConfig(undefined, cwd), null, getServerProvenance(undefined, cwd), callbacks, { requestRender: () => {} }, () => {});
    const output = stripAnsi(panel.render(100).join("\n"));
    panel.dispose();

    expect(output).toContain('Ignored Pi mcp.json settings: toolExposure "search_*": direct');
  });

  it("reads neither Pi file in exclusive mode", async () => {
    vi.stubEnv("PI_MCP_CONFIG_MODE", "exclusive");
    writeJson(piGlobal, { settings: { toolPrefix: "short" }, mcpServers: { pi: { type: "sse", url: "https://sse.example/sse" } } });
    writeJson(piProject, { mcpServers: { piProject: { command: "pi-project" } } });
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { mcpServers: { adapter: { command: "adapter" } } });
    const { getLegacyMcpMigrationNotices, loadMcpConfig } = await loadConfigModule();

    expect(loadMcpConfig(undefined, cwd).mcpServers).toEqual({ adapter: { command: "adapter" } });
    expect(getLegacyMcpMigrationNotices(cwd)).toEqual([]);
  });

  it("reads nothing from Pi's files and keeps the migration notice on Pi without MCP support", async () => {
    writeJson(piGlobal, { mcpServers: { old: { command: "old" } } });
    writeJson(piProject, { mcpServers: { oldProject: { command: "old" } } });
    const { getLegacyMcpMigrationNotices, loadMcpConfig } = await loadConfigModule(false);

    expect(loadMcpConfig(undefined, cwd).mcpServers).toEqual({});
    expect(getLegacyMcpMigrationNotices(cwd)).toEqual([
      `pi-mcp-adapter no longer reads ${piGlobal}. Move it with: mv ${JSON.stringify(piGlobal)} ${JSON.stringify(join(home, ".pi", "agent", "mcp-adapter.json"))}`,
      `pi-mcp-adapter no longer reads ${piProject}. Move it with: mv ${JSON.stringify(piProject)} ${JSON.stringify(join(cwd, ".pi", "mcp-adapter.json"))}`,
    ]);
  });

  it("puts .pi/mcp.json servers through project trust and approval", async () => {
    writeJson(piGlobal, { mcpServers: { global: { command: "global" } } });
    writeJson(piProject, { mcpServers: { project: { command: "project" } } });
    const { loadMcpConfigWithSources } = await loadConfigModule();
    const { applyProjectServerTrust } = await import("../project-server-trust.ts");

    const loaded = loadMcpConfigWithSources(undefined, cwd);
    expect([...loaded.projectServers]).toEqual([["project", { path: piProject }]]);
    const result = await applyProjectServerTrust(loaded, { cwd, hasUI: false, mode: "print", ui: undefined as never, isProjectTrusted: () => false });
    expect([...result.blockedServers.keys()]).toEqual(["project"]);
    expect(result.config.mcpServers.global).toEqual({ command: "global" });
  });
});
