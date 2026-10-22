import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

const caseInsensitiveFs = (() => {
  const probe = mkdtempSync(join(tmpdir(), "mcp-case-probe-"));
  try {
    return existsSync(join(dirname(probe), basename(probe).toUpperCase()));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe("project MCP server trust", () => {
  let root: string;
  let home: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-project-trust-"));
    home = join(root, "home");
    cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    vi.resetModules();
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
    vi.stubEnv("PI_MCP_CONFIG_MODE", "merge");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  async function load() {
    const config = await import("../config.ts");
    const trust = await import("../project-server-trust.ts");
    return { config, trust };
  }

  function context(overrides: Record<string, unknown> = {}) {
    return {
      cwd,
      hasUI: false,
      mode: "rpc",
      isProjectTrusted: () => true,
      ui: { select: vi.fn() },
      ...overrides,
    } as any;
  }

  it("tracks every project-scoped definition and excludes it before session trust is known", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { mcpServers: { inherited: { command: "global" } } });
    writeJson(join(cwd, ".mcp.json"), { mcpServers: {
      inherited: { args: ["project"] },
      local: { command: "node", lifecycle: "eager" },
    } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect([...loaded.projectServers.keys()].sort()).toEqual(["inherited", "local"]);
    expect(loaded.config.mcpServers.inherited).toEqual({ command: "global", args: ["project"] });
    expect(trust.excludeProjectServersAtLoadTime(loaded).mcpServers).toEqual({});
  });

  it("blocks project servers when Pi reports the project untrusted", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { command: "node" } } });
    const { config, trust } = await load();
    const result = await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ isProjectTrusted: () => false, hasUI: true }),
    );

    expect(result.config.mcpServers.local.disabled).toBe(true);
    expect(result.blockedServers.get("local")?.reason).toBe("untrusted");
  });

  it("does not request approval for an inherited server disabled by project config", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), {
      mcpServers: { inherited: { command: "global", args: ["server.js"] } },
    });
    writeJson(join(cwd, ".pi", "mcp-adapter.json"), {
      mcpServers: { inherited: { disabled: true } },
    });
    const { config, trust } = await load();
    const select = vi.fn();

    const result = await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui: { select } }),
    );

    expect(result.config.mcpServers.inherited?.disabled).toBe(true);
    expect(result.blockedServers.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("names the project override file for an inherited server re-enabled by project config", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), {
      mcpServers: { inherited: { command: "global", args: ["server.js"], disabled: true } },
    });
    const overridePath = join(cwd, ".pi", "mcp-adapter.json");
    writeJson(overridePath, { mcpServers: { inherited: { disabled: false } } });
    const { config, trust } = await load();
    const select = vi.fn().mockResolvedValue(undefined);

    await trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, cwd),
      context({ hasUI: true, mode: "tui", ui: { select } }),
    );

    expect(select).toHaveBeenCalledWith(
      expect.stringContaining(`Project config: ${overridePath}\nEndpoint: "global" "server.js"`),
      expect.any(Array),
    );
  });

  it("persists an interactive approval and re-prompts after the definition changes", async () => {
    const path = join(cwd, ".mcp.json");
    writeJson(path, { mcpServers: { local: { command: "node", args: ["one.js"] } } });
    const { config, trust } = await load();
    const select = vi.fn().mockResolvedValue("Allow");

    let result = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui: { select } }));
    expect(result.blockedServers.size).toBe(0);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(expect.stringContaining(`Project config: ${path}\n`), expect.any(Array));

    result = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui: { select } }));
    expect(result.blockedServers.size).toBe(0);
    expect(select).toHaveBeenCalledTimes(1);

    writeJson(path, { mcpServers: { local: { command: "node", args: ["two.js"] } } });
    result = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui: { select } }));
    expect(result.blockedServers.size).toBe(0);
    expect(select).toHaveBeenCalledTimes(2);
    expect(statSync(join(home, ".pi", "agent", "mcp-project-approvals.json")).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!caseInsensitiveFs)("keeps an approval when the same project folder is opened with different casing", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { command: "node", args: ["one.js"] } } });
    const differentlyCased = join(root, "PROJECT");
    const { config, trust } = await load();
    const select = vi.fn().mockResolvedValue("Allow");

    await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, differentlyCased), context({ cwd: differentlyCased, hasUI: true, mode: "tui", ui: { select } }));
    const result = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui: { select } }));

    expect(result.blockedServers.size).toBe(0);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("shares approvals across a repository's git worktrees but not with directories that only claim one", async () => {
    const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git(cwd, "init", "-q");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(root, "worktree");
    git(cwd, "worktree", "add", "-q", worktree);
    // A bare repository stored as container/.git: the container is not a checkout of it.
    const container = join(root, "container");
    const bare = join(container, ".git");
    git(root, "clone", "-q", "--bare", cwd, bare);
    const [bareFirst, bareSecond] = [join(container, "first"), join(container, "second")];
    git(bare, "worktree", "add", "-q", bareFirst);
    git(bare, "worktree", "add", "-q", bareSecond);
    const copied = join(root, "copied");
    mkdirSync(copied);
    writeFileSync(join(copied, ".git"), readFileSync(join(worktree, ".git")));
    const symlinked = join(root, "symlinked");
    mkdirSync(symlinked);
    symlinkSync(join(worktree, ".git"), join(symlinked, ".git"));
    // Tracked files cannot create a .git file, but a malicious branch can plant an admin entry at the repo root.
    const forged = join(root, "forged");
    const planted = join(cwd, "worktrees", "x");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "gitdir"), `${join(forged, ".git")}\n`);
    mkdirSync(forged);
    writeFileSync(join(forged, ".git"), `gitdir: ${planted}\n`);
    for (const dir of [cwd, worktree, container, bareFirst, bareSecond, copied, symlinked, forged]) {
      writeJson(join(dir, ".mcp.json"), { mcpServers: { local: { command: "node", args: ["server.js"] } } });
    }
    const { config, trust } = await load();
    const select = vi.fn().mockResolvedValue("Allow");
    const open = (dir: string) => trust.applyProjectServerTrust(
      config.loadMcpConfigWithSources(undefined, dir),
      context({ cwd: dir, hasUI: true, mode: "tui", ui: { select } }),
    );

    await open(cwd);
    await open(worktree);
    expect(select).toHaveBeenCalledTimes(1);
    await open(container);
    await open(bareFirst);
    await open(bareSecond);
    expect(select).toHaveBeenCalledTimes(3);
    await open(copied);
    await open(symlinked);
    await open(forged);
    expect(select).toHaveBeenCalledTimes(6);
  });

  it.each([
    { hasUI: false, mode: "print" },
    { hasUI: true, mode: "rpc" },
  ])("skips unapproved servers without a dialog in $mode mode unless the global policy allows them", async (session) => {
    writeJson(join(cwd, ".mcp.json"), { settings: { projectServers: "allow" }, mcpServers: { local: { command: "node" } } });
    let modules = await load();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const select = vi.fn();
    let loaded = modules.config.loadMcpConfigWithSources(undefined, cwd);
    expect(loaded.projectServerPolicy).toBe("ask");
    const blocked = (await modules.trust.applyProjectServerTrust(loaded, context({ ...session, ui: { select } }))).blockedServers;
    expect(blocked.get("local")?.reason).toBe("approval-required");
    expect(select).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Ignoring settings.projectServers"));

    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { settings: { projectServers: "allow" }, mcpServers: {} });
    vi.resetModules();
    modules = await load();
    loaded = modules.config.loadMcpConfigWithSources(undefined, cwd);
    expect(loaded.projectServerPolicy).toBe("allow");
    expect((await modules.trust.applyProjectServerTrust(loaded, context({ ...session, ui: { select } }))).blockedServers.size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("denies on the preselected option or escape and keeps the server blocked for the session", async () => {
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { local: { url: "https://example.test/mcp" } } });
    const { config, trust } = await load();
    const pressEnter = vi.fn(async (_title: string, options: string[]) => options[0]);
    const pressEscape = vi.fn(async () => undefined);

    for (const select of [pressEnter, pressEscape]) {
      const result = await trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), context({ hasUI: true, mode: "tui", ui: { select } }));
      expect(select).toHaveBeenCalledTimes(1);
      expect(result.config.mcpServers.local.disabled).toBe(true);
      expect(result.blockedServers.get("local")?.reason).toBe("denied");
    }
    expect(existsSync(join(home, ".pi", "agent", "mcp-project-approvals.json"))).toBe(false);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toContain("example.test");
  });

  it("treats Claude-plugin servers enabled by project config as project-scoped", async () => {
    const plugin = join(cwd, "evil-plugin");
    writeJson(join(plugin, ".mcp.json"), { mcpServers: {
      evil: { command: "node", args: ["marker.js"], lifecycle: "eager" },
    } });
    writeJson(join(cwd, ".mcp.json"), {
      claudePlugins: [{ path: "./evil-plugin", mcp: true }],
      mcpServers: {},
    });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.get("evil")?.path).toBe(join(cwd, ".mcp.json"));
    const result = await trust.applyProjectServerTrust(loaded, context({ isProjectTrusted: () => false }));
    expect(result.config.mcpServers.evil).toMatchObject({ disabled: true, lifecycle: "eager" });
  });

  it("treats Agent Plugin servers enabled by project settings as project-scoped", async () => {
    const plugin = join(cwd, "evil-agent-plugin");
    writeJson(join(plugin, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "evil-agent",
    });
    writeJson(join(plugin, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { marker: { type: "stdio", command: "node", args: ["marker.js"] } },
    });
    writeJson(join(cwd, ".mcp.json"), {
      settings: { agentPluginPaths: ["./evil-agent-plugin"] },
      mcpServers: {},
    });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);
    const name = "evil-agent__marker";

    expect(loaded.projectServers.get(name)?.path).toBe(join(cwd, ".mcp.json"));
    const result = await trust.applyProjectServerTrust(loaded, context({ isProjectTrusted: () => false }));
    expect(result.config.mcpServers[name]).toMatchObject({ disabled: true, command: "node" });
  });

  it("gates repo-local imports enabled by global config", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { imports: ["vscode"], mcpServers: {} });
    writeJson(join(cwd, ".vscode", "mcp.json"), { mcpServers: { host: { command: "node" } } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.get("host")?.path).toBe(join(cwd, ".vscode", "mcp.json"));
  });

  it("gates repo-local host discovery enabled by global config", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), {
      settings: { hostConfigDiscovery: "on" },
      mcpServers: {},
    });
    writeJson(join(cwd, "opencode.json"), { mcp: {
      host: { type: "local", command: ["node", "marker.js"] },
    } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.get("host")?.path).toBe(join(cwd, "opencode.json"));
  });

  it("keeps home-level imports outside project-server gating", async () => {
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { imports: ["cursor"], mcpServers: {} });
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { home: { command: "node" } } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.has("home")).toBe(false);
    expect(trust.excludeProjectServersAtLoadTime(loaded).mcpServers.home).toEqual({ command: "node" });
  });

  it("gates home-level imports requested by a project config", async () => {
    writeJson(join(cwd, ".mcp.json"), { imports: ["cursor"], mcpServers: {} });
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { home: { command: "node" } } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);

    expect(loaded.projectServers.get("home")?.path).toBe(join(cwd, ".mcp.json"));
  });

  it("treats Pi package servers enabled by project settings as project-scoped", async () => {
    const packageRoot = join(cwd, ".pi", "packages", "evil-package");
    writeJson(join(cwd, ".pi", "settings.json"), { packages: ["./packages/evil-package"] });
    writeJson(join(packageRoot, "package.json"), {
      name: "evil-package",
      pi: { mcp: "./mcp.json" },
    });
    writeJson(join(packageRoot, "mcp.json"), { mcpServers: {
      marker: { command: "node", args: ["marker.js"], lifecycle: "eager" },
    } });
    const { config, trust } = await load();
    const loaded = config.loadMcpConfigWithSources(undefined, cwd);
    const name = "evil-package__marker";

    expect(loaded.projectServers.get(name)?.path).toBe(join(cwd, ".pi", "settings.json"));
    const result = await trust.applyProjectServerTrust(loaded, context({ isProjectTrusted: () => false }));
    expect(result.config.mcpServers[name]).toMatchObject({ disabled: true, lifecycle: "eager" });
  });

  describe("project script tools", () => {
    const globalPath = () => join(home, ".pi", "agent", "mcp-adapter.json");
    const projectPath = () => join(cwd, ".pi", "mcp-adapter.json");
    const closeStale = { description: "Close stale issues", file: "./close.js", inputSchema: { type: "object", properties: { repo: { type: "string" } } } };
    const tui = (select: ReturnType<typeof vi.fn>) => context({ hasUI: true, mode: "tui", ui: { select } });
    async function gate(ctx: any) {
      const { config, trust } = await load();
      return trust.applyProjectServerTrust(config.loadMcpConfigWithSources(undefined, cwd), ctx);
    }

    it("records which script tools a project file set last, and leaves them out before trust is known", async () => {
      writeJson(globalPath(), { scriptTools: { kept: { description: "Global", file: "/g.js" }, close_stale: { description: "Global", file: "/g.js" } } });
      writeJson(projectPath(), { scriptTools: { close_stale: closeStale } });
      const { config, trust } = await load();
      const loaded = config.loadMcpConfigWithSources(undefined, cwd);

      expect([...loaded.projectScriptTools!]).toEqual([["close_stale", { path: projectPath() }]]);
      expect(trust.hasProjectScriptToolDefinitions(config.loadMcpConfig(undefined, cwd))).toBe(true);
      expect(Object.keys(trust.excludeProjectServersAtLoadTime(loaded).scriptTools ?? {})).toEqual(["kept"]);
    });

    it("blocks a project script tool in an untrusted project, and never gates a global one", async () => {
      writeJson(globalPath(), { scriptTools: { triage: { description: "Global", file: "/g.js" } } });
      writeJson(projectPath(), { scriptTools: { close_stale: closeStale } });
      const select = vi.fn();
      const result = await gate({ ...tui(select), isProjectTrusted: () => false });

      expect(Object.keys(result.config.scriptTools ?? {})).toEqual(["triage"]);
      expect(result.blockedScriptTools).toEqual(new Map([["close_stale", { reason: "untrusted", source: { path: projectPath() } }]]));
      expect(select).not.toHaveBeenCalled();
    });

    it("needs approval in a trusted project without a dialog, unless user-global projectServers is \"allow\"", async () => {
      writeJson(projectPath(), { scriptTools: { close_stale: closeStale } });
      const blocked = await gate(context());
      expect(blocked.config.scriptTools).toEqual({});
      expect(blocked.blockedScriptTools?.get("close_stale")?.reason).toBe("approval-required");

      writeJson(globalPath(), { settings: { projectServers: "allow" } });
      vi.resetModules();
      const allowed = await gate(context());
      expect(Object.keys(allowed.config.scriptTools ?? {})).toEqual(["close_stale"]);
      expect(allowed.blockedScriptTools?.size).toBe(0);
    });

    it("asks with the tool, the config file and the script path; Allow keeps the tool and records it, Enter denies", async () => {
      writeJson(projectPath(), { scriptTools: { close_stale: closeStale } });
      const allow = vi.fn().mockResolvedValue("Allow");
      const allowed = await gate(tui(allow));

      expect(allow).toHaveBeenCalledWith(
        `Allow project script tool “close_stale”?\nProject config: ${projectPath()}\nScript: ${join(cwd, ".pi", "close.js")}\n\nThis tool runs the script in Pi's codemode, where it can call your MCP and Pi tools. The script file can change without asking you again.`,
        ["Don't allow", "Allow"],
      );
      expect(Object.keys(allowed.config.scriptTools ?? {})).toEqual(["close_stale"]);
      expect(JSON.parse(readFileSync(join(home, ".pi", "agent", "mcp-project-approvals.json"), "utf8")).approvals)
        .toEqual([expect.objectContaining({ serverName: "scriptTools/close_stale" })]);

      rmSync(join(home, ".pi", "agent", "mcp-project-approvals.json"));
      // Pi preselects the first choice.
      const enter = vi.fn().mockResolvedValue("Don't allow");
      const denied = await gate(tui(enter));
      expect(denied.config.scriptTools).toEqual({});
      expect(denied.blockedScriptTools?.get("close_stale")?.reason).toBe("denied");
      expect(existsSync(join(home, ".pi", "agent", "mcp-project-approvals.json"))).toBe(false);
    });

    it("keeps an approval across restarts until the entry changes, its file, inputSchema or declare included", async () => {
      writeJson(projectPath(), { scriptTools: { close_stale: closeStale } });
      await gate(tui(vi.fn().mockResolvedValue("Allow")));
      vi.resetModules();
      expect(Object.keys((await gate(context())).config.scriptTools ?? {})).toEqual(["close_stale"]);

      for (const changed of [
        { ...closeStale, file: "./other.js" },
        { ...closeStale, inputSchema: { type: "object", properties: {} } },
        { ...closeStale, declare: true },
        { ...closeStale, description: "Close old issues" },
      ]) {
        writeJson(projectPath(), { scriptTools: { close_stale: changed } });
        vi.resetModules();
        expect((await gate(context())).blockedScriptTools?.get("close_stale")?.reason, JSON.stringify(changed)).toBe("approval-required");
      }
      // A project server of the same name gets nothing from the script tool's approval.
      writeJson(projectPath(), { mcpServers: { close_stale: { command: "node" } }, scriptTools: { close_stale: closeStale } });
      vi.resetModules();
      const both = await gate(context());
      expect(both.blockedServers.get("close_stale")?.reason).toBe("approval-required");
      expect(Object.keys(both.config.scriptTools ?? {})).toEqual(["close_stale"]);
    });

    it("never lets a server approval stand in for a script tool's, nor the reverse", async () => {
      const definition = { description: "Close stale issues", file: "/abs/close.js" };
      writeJson(projectPath(), {
        mcpServers: { "scriptTools/close_stale": { ...definition } },
        scriptTools: { close_stale: { ...definition } },
      });
      // Allow the server, deny the script tool.
      const select = vi.fn(async (title: string) => title.startsWith("Allow project MCP server") ? "Allow" : "Don't allow");
      const first = await gate(tui(select));
      expect(first.blockedScriptTools?.get("close_stale")?.reason).toBe("denied");

      vi.resetModules();
      const second = await gate(context());
      expect(Object.keys(second.config.scriptTools ?? {})).toEqual([]);
      expect(second.blockedScriptTools?.get("close_stale")?.reason).toBe("approval-required");

      // Now allow only the script tool: the server stays unapproved.
      rmSync(join(home, ".pi", "agent", "mcp-project-approvals.json"));
      vi.resetModules();
      await gate(tui(vi.fn(async (title: string) => title.startsWith("Allow project script tool") ? "Allow" : "Don't allow")));
      vi.resetModules();
      const third = await gate(context());
      expect(Object.keys(third.config.scriptTools ?? {})).toEqual(["close_stale"]);
      expect(third.blockedServers.get("scriptTools/close_stale")?.reason).toBe("approval-required");
    });
  });
});
