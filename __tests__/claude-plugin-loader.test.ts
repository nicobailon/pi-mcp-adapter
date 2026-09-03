import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function writeManifest(plugin: string, name: string): void {
  writeJson(join(plugin, ".claude-plugin", "plugin.json"), {
    name,
    description: `${name} fixture`,
    version: "1.0.0",
  });
}

describe("Claude plugin bundles", () => {
  const roots: string[] = [];
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.chdir(originalCwd);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setup(): { home: string; project: string; plugin: string } {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-claude-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-claude-project-"));
    const plugin = join(project, "plugins", "acme-tools");
    roots.push(home, project);
    process.env.HOME = home;
    process.chdir(project);
    return { home, project, plugin };
  }

  it("loads MCP defaults and exposes skills from one explicitly configured plugin", async () => {
    const { project, plugin } = setup();
    writeManifest(plugin, "acme-tools");
    writeJson(join(plugin, ".mcp.json"), {
      mcpServers: {
        docs: {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/server",
          args: ["--root", "${CLAUDE_PLUGIN_ROOT}"],
          env: { CONFIG: "${CLAUDE_PLUGIN_ROOT}/config.json" },
        },
      },
    });
    writeText(join(plugin, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n");
    writeJson(join(project, ".mcp.json"), {
      claudePlugins: [{ path: "./plugins/acme-tools", mcp: true, skills: true }],
      mcpServers: {},
    });

    const { discoverConfiguredClaudePluginSkills, loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();
    const root = realpathSync(plugin);

    expect(config.mcpServers.docs).toEqual({
      command: join(root, "bin", "server"),
      args: ["--root", root],
      env: {
        CONFIG: join(root, "config.json"),
        CLAUDE_PLUGIN_ROOT: root,
      },
    });
    expect(discoverConfiguredClaudePluginSkills(config, project)).toEqual([join(root, "skills", "review", "SKILL.md")]);
  });

  it("supports skills-only plugins without reading .mcp.json", async () => {
    const { project, plugin } = setup();
    writeManifest(plugin, "skills-only");
    writeText(join(plugin, ".mcp.json"), "{ malformed and intentionally ignored");
    writeText(join(plugin, "skills", "writer", "SKILL.md"), "---\nname: writer\ndescription: Write docs\n---\n");
    writeJson(join(project, ".mcp.json"), {
      claudePlugins: [{ path: plugin, skills: true }],
      mcpServers: {},
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { discoverConfiguredClaudePluginSkills, loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();
    expect(config.mcpServers).toEqual({});
    expect(discoverConfiguredClaudePluginSkills(config, project)).toEqual([realpathSync(join(plugin, "skills", "writer", "SKILL.md"))]);
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining("invalid MCP config"));
  });

  it("supports manifest-free MCP-only plugins without requiring skills", async () => {
    const { project, plugin } = setup();
    writeJson(join(plugin, ".mcp.json"), { mcpServers: { local: { command: "node", args: ["server.js"] } } });
    writeJson(join(project, ".mcp.json"), {
      claudePlugins: [{ path: plugin, mcp: true }],
      mcpServers: {},
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { discoverConfiguredClaudePluginSkills, loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();
    expect(config.mcpServers.local).toMatchObject({ command: "node", args: ["server.js"] });
    expect(discoverConfiguredClaudePluginSkills(config, project)).toEqual([]);
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining("skills"));
  });

  it("loads explicitly configured plugins for isolated SDK config", async () => {
    const { project, plugin } = setup();
    writeJson(join(plugin, ".mcp.json"), { mcpServers: { sdk: { command: "sdk-server" } } });

    const { resolveConfiguredClaudePluginMcp } = await import("../config.ts");
    const config = resolveConfiguredClaudePluginMcp({
      claudePlugins: [{ path: plugin, mcp: true }],
      mcpServers: {},
    }, project);

    expect(config.mcpServers.sdk.command).toBe("sdk-server");
  });

  it("lets normal Pi config override Claude plugin MCP defaults", async () => {
    const { project, plugin } = setup();
    writeManifest(plugin, "defaults");
    writeJson(join(plugin, ".mcp.json"), {
      mcpServers: {
        docs: { command: "plugin-command", args: ["--plugin"], env: { PLUGIN: "1" } },
        "normalized-name": { command: "plugin-normalized" },
        "数": { command: "plugin-unicode" },
      },
    });
    writeJson(join(project, ".mcp.json"), {
      claudePlugins: [{ path: plugin, mcp: true }],
      mcpServers: {
        docs: { command: "pi-command", args: ["--pi"], env: { PI: "1" } },
        normalized_name: { command: "pi-normalized" },
        _mcpns_6570: { command: "pi-marker" },
      },
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();
    expect(config.mcpServers.docs).toEqual({
      command: "pi-command",
      args: ["--pi"],
      env: { PI: "1" },
    });
    expect(config.mcpServers.normalized_name.command).toBe("pi-normalized");
    expect(config.mcpServers["normalized-name"]).toBeUndefined();
    expect(config.mcpServers["数"].command).toBe("plugin-unicode");
    expect(config.mcpServers._mcpns_6570.command).toBe("pi-marker");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("shadowed by higher-precedence"));
  });

  it("reports missing paths, malformed manifests, invalid MCP config, and naming conflicts", async () => {
    const { project, plugin } = setup();
    const malformed = join(project, "plugins", "malformed");
    const duplicate = join(project, "plugins", "duplicate");
    const invalidMcp = join(project, "plugins", "invalid-mcp");
    const missing = join(project, "plugins", "missing");
    writeText(join(malformed, ".claude-plugin", "plugin.json"), "{ bad json");
    writeManifest(plugin, "same-name");
    writeManifest(duplicate, "same-name");
    writeManifest(invalidMcp, "invalid-mcp");
    writeJson(join(plugin, ".mcp.json"), {
      mcpServers: { shared: { command: "first" }, "数": { command: "unicode" } },
    });
    writeJson(join(duplicate, ".mcp.json"), {
      mcpServers: { shared: { command: "second" }, _mcpns_6570: { command: "marker" } },
    });
    writeJson(join(invalidMcp, ".mcp.json"), { mcpServers: [] });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeJson(join(project, ".mcp.json"), {
      claudePlugins: [
        { path: missing, mcp: true },
        { path: malformed, mcp: true },
        { path: plugin, mcp: true },
        { path: duplicate, mcp: true },
        { path: invalidMcp, mcp: true },
        { path: 42, mcp: true },
      ],
      mcpServers: {},
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();
    expect(config.mcpServers.shared.command).toBe("first");
    expect(config.mcpServers["数"].command).toBe("unicode");
    expect(config.mcpServers._mcpns_6570.command).toBe("marker");
    const messages = warning.mock.calls.flat().map(String).join("\n");
    expect(messages).toContain("Invalid claudePlugins[5]");
    expect(messages).toContain("does not exist");
    expect(messages).toContain("manifest contains invalid JSON");
    expect(messages).toContain("name conflict");
    expect(messages).toContain("MCP server name conflict");
    expect(messages).toContain("must contain an mcpServers object");
  });

  it("rejects component symlinks that escape the explicitly configured directory", async () => {
    const { project, plugin } = setup();
    const outside = join(project, "outside");
    writeManifest(plugin, "contained");
    writeJson(join(outside, ".mcp.json"), { mcpServers: { escaped: { command: "escaped" } } });
    mkdirSync(plugin, { recursive: true });
    symlinkSync(join(outside, ".mcp.json"), join(plugin, ".mcp.json"));
    writeJson(join(project, ".mcp.json"), {
      claudePlugins: [{ path: plugin, mcp: true }],
      mcpServers: {},
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("resolves outside"));
  });

  it("does not discover skills through symlinks that leave the plugin skills directory", async () => {
    const { project, plugin } = setup();
    writeManifest(plugin, "skills-scope");
    writeText(join(plugin, "shared-skills", "escaped", "SKILL.md"), "---\nname: escaped\ndescription: Escaped skill\n---\n");
    mkdirSync(join(plugin, "skills"), { recursive: true });
    symlinkSync(join(plugin, "shared-skills"), join(plugin, "skills", "linked"));
    writeJson(join(project, ".mcp.json"), {
      claudePlugins: [{ path: plugin, skills: true }],
      mcpServers: {},
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { discoverConfiguredClaudePluginSkills, loadMcpConfig } = await import("../config.ts");
    expect(discoverConfiguredClaudePluginSkills(loadMcpConfig(), project)).toEqual([]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("outside its skills directory"));
  });

  it("preserves existing config behavior when claudePlugins is absent", async () => {
    const { project } = setup();
    writeJson(join(project, ".mcp.json"), { mcpServers: { native: { command: "native" } } });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig()).toEqual({ mcpServers: { native: { command: "native" } } });
    expect(warning).not.toHaveBeenCalled();
  });
});
