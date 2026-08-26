import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf-8");
}

describe("config discovery", () => {
  const originalHome = process.env.HOME;
  const originalPackageDir = process.env.PI_PACKAGE_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalPackageDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPackageDir;
    }
    process.chdir(originalCwd);
  });

  it("loads package manifest MCP servers below user config without package settings or imports", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-package-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-package-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const packageRoot = join(home, ".pi", "agent", "npm", "node_modules", "@acme", "tools");
    writeJson(join(home, ".pi", "agent", "settings.json"), { packages: ["npm:@acme/tools@1.0.0"] });
    writeJson(join(packageRoot, "package.json"), { name: "@acme/tools", pi: { mcp: ["./mcp.json", "./extra.json"] } });
    writeJson(join(packageRoot, "mcp.json"), {
      settings: { directTools: true },
      imports: ["vscode"],
      mcpServers: {
        tools: { command: "package-command", args: ["--package"], env: { PACKAGE: "1" } },
        full: { command: "package-full", args: ["--package-full"], env: { PACKAGE: "1" } },
        "tools.db": { command: "first" },
      },
    });
    writeJson(join(packageRoot, "extra.json"), {
      mcpServers: {
        tools_db: { command: "duplicate" },
      },
    });
    writeJson(join(project, ".mcp.json"), {
      settings: { directTools: false },
      mcpServers: {
        acme_tools__tools: { command: "user-command" },
        acme_tools__full: { command: "user-full", args: ["--user-full"], env: { USER: "1" } },
      },
    });

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();
    expect(config.settings).toEqual({ directTools: false });
    expect(config.mcpServers.acme_tools__tools).toEqual({
      command: "user-command",
      args: ["--package"],
      env: { PACKAGE: "1" },
    });
    expect(config.mcpServers.acme_tools__full).toEqual({
      command: "user-full",
      args: ["--user-full"],
      env: { USER: "1" },
    });
    expect(config.mcpServers.acme_tools__tools_db).toEqual({ command: "first" });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("duplicate normalized MCP server acme_tools__tools_db"));
    warning.mockRestore();
  });

  it("fails loudly on malformed package settings JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-package-settings-invalid-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-package-settings-invalid-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeText(join(home, ".pi", "agent", "settings.json"), "{ not json");

    const { loadMcpConfig } = await import("../config.ts");
    expect(() => loadMcpConfig()).toThrow("user Pi settings");
  });

  it("fails loudly on malformed package MCP JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-package-mcp-invalid-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-package-mcp-invalid-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const packageRoot = join(home, ".pi", "agent", "npm", "node_modules", "acme-tools");
    writeJson(join(home, ".pi", "agent", "settings.json"), { packages: ["npm:acme-tools"] });
    writeJson(join(packageRoot, "package.json"), { name: "acme-tools", pi: { mcp: "./mcp.json" } });
    writeText(join(packageRoot, "mcp.json"), "{ not json");

    const { loadMcpConfig } = await import("../config.ts");
    expect(() => loadMcpConfig()).toThrow("Pi package acme-tools MCP config");
  });

  it("drops incompatible package transport fields when a normal override changes transport", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-package-transport-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-package-transport-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const packageRoot = join(home, ".pi", "agent", "npm", "node_modules", "acme-tools");
    writeJson(join(home, ".pi", "agent", "settings.json"), { packages: ["npm:acme-tools"] });
    writeJson(join(packageRoot, "package.json"), { name: "acme-tools", pi: { mcp: "./mcp.json" } });
    writeJson(join(packageRoot, "mcp.json"), {
      mcpServers: {
        http: {
          url: "https://package.test/mcp",
          headers: { Authorization: "Bearer package" },
          bearerTokenEnv: "PACKAGE_TOKEN",
          requestHeadersCommand: "headers",
          httpTransport: "sse",
        },
        stdio: {
          command: "package-command",
          args: ["--package"],
          env: { PACKAGE: "1" },
          cwd: "/package",
          pluginDataDir: "/package/data",
          literalEnv: true,
        },
        socket: {
          url: "https://package.test/socket",
          headers: { Authorization: "Bearer package" },
          bearerTokenEnv: "PACKAGE_TOKEN",
          requestHeadersCommand: "headers",
          httpTransport: "sse",
        },
      },
    });
    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        "acme-tools__http": { command: "local-command" },
        "acme-tools__stdio": { url: "https://project.test/mcp" },
        "acme-tools__socket": { socket: "/tmp/project.sock" },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toMatchObject({
      "acme-tools__http": { command: "local-command" },
      "acme-tools__stdio": { url: "https://project.test/mcp" },
      "acme-tools__socket": { socket: "/tmp/project.sock" },
    });
    expect(loadMcpConfig().mcpServers["acme-tools__http"]).toEqual({ command: "local-command" });
    expect(loadMcpConfig().mcpServers["acme-tools__stdio"]).toEqual({ url: "https://project.test/mcp" });
    expect(loadMcpConfig().mcpServers["acme-tools__socket"]).toEqual({ socket: "/tmp/project.sock" });
  });

  it("does not load a package source that escapes Pi's managed git directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-package-escape-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-package-escape-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const escapedPackage = join(home, ".pi", "outside-package");
    writeJson(join(home, ".pi", "agent", "settings.json"), { packages: ["git:../../outside-package"] });
    writeJson(join(escapedPackage, "package.json"), { name: "outside-package", pi: { mcp: "./mcp.json" } });
    writeJson(join(escapedPackage, "mcp.json"), { mcpServers: { unsafe: { command: "unsafe" } } });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({});
  });

  it("loads raw HTTPS and SSH package sources from Pi's managed git directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-package-git-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-package-git-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const gitRoot = join(home, ".pi", "agent", "git", "github.com", "acme");
    writeJson(join(home, ".pi", "agent", "settings.json"), {
      packages: ["https://github.com/acme/http-tools", "ssh://git@github.com/acme/ssh-tools", "git@github.com:acme/scp-tools.git"],
    });
    writeJson(join(gitRoot, "http-tools", "package.json"), { name: "http-tools", pi: { mcp: "./mcp.json" } });
    writeJson(join(gitRoot, "http-tools", "mcp.json"), { mcpServers: { http: { command: "http" } } });
    writeJson(join(gitRoot, "ssh-tools", "package.json"), { name: "ssh-tools", pi: { mcp: "./mcp.json" } });
    writeJson(join(gitRoot, "ssh-tools", "mcp.json"), { mcpServers: { ssh: { command: "ssh" } } });
    writeJson(join(gitRoot, "scp-tools", "package.json"), { name: "scp-tools", pi: { mcp: "./mcp.json" } });
    writeJson(join(gitRoot, "scp-tools", "mcp.json"), { mcpServers: { scp: { command: "scp" } } });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({
      "http-tools__http": { command: "http" },
      "ssh-tools__ssh": { command: "ssh" },
      "scp-tools__scp": { command: "scp" },
    });
  });

  it("skips a package MCP symlink that resolves outside its package root", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-package-symlink-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-package-symlink-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const packageRoot = join(home, ".pi", "agent", "npm", "node_modules", "acme-tools");
    const outsideConfig = join(project, "outside-mcp.json");
    writeJson(join(home, ".pi", "agent", "settings.json"), { packages: ["npm:acme-tools"] });
    writeJson(join(packageRoot, "package.json"), { name: "acme-tools", pi: { mcp: "./linked-mcp.json" } });
    writeJson(outsideConfig, { mcpServers: { outside: { command: "unsafe" } } });
    symlinkSync(outsideConfig, join(packageRoot, "linked-mcp.json"));

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({});
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("file must stay inside the package"));
    warning.mockRestore();
  });

  it("gives project package settings precedence over matching user package settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-package-precedence-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-package-precedence-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const globalPackage = join(home, ".pi", "agent", "global-package");
    const projectPackage = join(project, ".pi", "project-package");
    writeJson(join(home, ".pi", "agent", "settings.json"), { packages: ["./global-package"] });
    writeJson(join(project, ".pi", "settings.json"), { packages: ["./project-package"] });
    writeJson(join(globalPackage, "package.json"), { name: "acme-tools", pi: { mcp: "./mcp.json" } });
    writeJson(join(globalPackage, "mcp.json"), { mcpServers: { docs: { command: "global" } } });
    writeJson(join(projectPackage, "package.json"), { name: "acme-tools", pi: { mcp: "./mcp.json" } });
    writeJson(join(projectPackage, "mcp.json"), { mcpServers: { docs: { command: "project" } } });

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({ "acme-tools__docs": { command: "project" } });
    warning.mockRestore();
  });

  it("keeps unspecified Agent Plugin fields when normal config overrides a plugin server", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-plugin-override-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-plugin-override-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const plugin = join(project, "plugins", "acme-tools");
    writeJson(join(plugin, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "acme.tools",
    });
    writeJson(join(plugin, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["plugin.js"] } },
    });
    writeJson(join(project, ".mcp.json"), {
      settings: { agentPluginPaths: ["./plugins/acme-tools"] },
      mcpServers: { acme_tools__local: { command: "override-node" } },
    });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers.acme_tools__local).toMatchObject({
      command: "override-node",
      args: ["plugin.js"],
      cwd: realpathSync(plugin),
      env: { PLUGIN_ROOT: realpathSync(plugin) },
    });
  });

  it("suppresses a package server that collides with an Agent Plugin server", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-package-plugin-collision-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-package-plugin-collision-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const packageRoot = join(home, ".pi", "agent", "npm", "node_modules", "acme-tools");
    const plugin = join(project, "plugins", "acme-tools");
    writeJson(join(home, ".pi", "agent", "settings.json"), { packages: ["npm:acme-tools"] });
    writeJson(join(packageRoot, "package.json"), { name: "acme-tools", pi: { mcp: "./mcp.json" } });
    writeJson(join(packageRoot, "mcp.json"), {
      mcpServers: { local: { command: "package", args: ["--package"], env: { PACKAGE: "1" } } },
    });
    writeJson(join(plugin, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "acme.tools",
    });
    writeJson(join(plugin, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node", args: ["plugin.js"] } },
    });
    writeJson(join(project, ".mcp.json"), { settings: { agentPluginPaths: ["./plugins/acme-tools"] } });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers.acme_tools__local).toMatchObject({
      command: "node",
      args: ["plugin.js"],
    });
    expect(loadMcpConfig().mcpServers.acme_tools__local).not.toHaveProperty("env.PACKAGE");
  });

  it("drops malformed server entries at the config boundary", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-config-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-config-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        valid: { command: "node" },
        nullEntry: null,
        listEntry: [],
        stringEntry: "node",
      },
    });

    const { loadMcpConfig } = await import("../config.ts");

    expect(loadMcpConfig().mcpServers).toEqual({ valid: { command: "node" } });
  });

  it("loads Agent Plugin MCP servers from configured plugin paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-plugin-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-agent-plugin-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const plugin = join(project, "plugins", "acme-tools");
    writeJson(join(plugin, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "acme.tools",
    });
    writeJson(join(plugin, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        local: {
          type: "stdio",
          command: "./bin/server",
          args: ["--config", "${PLUGIN_ROOT}/config.json", "--data", "${PLUGIN_DATA}/local"],
          env: { CACHE: "${PLUGIN_DATA}/cache", LITERAL_HOME: "${HOME}", LITERAL_COMMAND: "!echo pwned" },
        },
        remote: {
          type: "streamable-http",
          url: "https://example.test/mcp",
          headers: { "X-Tenant": "public" },
        },
        legacy: {
          type: "sse",
          url: "http://localhost:3845/sse",
        },
      },
    });
    writeJson(join(project, ".mcp.json"), {
      settings: { agentPluginPaths: ["./plugins/acme-tools"] },
      mcpServers: {},
    });

    const { loadMcpConfig, getMcpDiscoverySummary } = await import("../config.ts");
    const config = loadMcpConfig();
    const realPlugin = realpathSync(plugin);
    const pluginDataDir = join(home, ".pi", "agent", "agent-plugin-data", "acme.tools");
    expect(config.mcpServers).toMatchObject({
      acme_tools__local: {
        command: join(realPlugin, "bin", "server"),
        args: ["--config", join(realPlugin, "config.json"), "--data", join(pluginDataDir, "local")],
        env: {
          CACHE: join(pluginDataDir, "cache"),
          LITERAL_HOME: "${HOME}",
          LITERAL_COMMAND: "!echo pwned",
          PLUGIN_ROOT: realPlugin,
          PLUGIN_DATA: pluginDataDir,
        },
        cwd: realPlugin,
        pluginDataDir,
        literalEnv: true,
      },
      acme_tools__remote: {
        url: "https://example.test/mcp",
        headers: { "X-Tenant": "public" },
        httpTransport: "streamable-http",
      },
      acme_tools__legacy: {
        url: "http://localhost:3845/sse",
        httpTransport: "sse",
      },
    });
    expect(getMcpDiscoverySummary().agentPlugins).toEqual([
      { path: realPlugin, name: "acme.tools", serverCount: 3 },
    ]);
  });

  it("skips invalid Agent Plugin MCP server entries without loading credentials or unsafe paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-plugin-invalid-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-agent-plugin-invalid-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const plugin = join(project, "plugins", "bad-plugin");
    writeJson(join(plugin, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "bad-plugin",
    });
    writeJson(join(plugin, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        unsafeCommand: { type: "stdio", command: "../bin/server" },
        escapedCommand: { type: "stdio", command: "./../bin/server" },
        reservedEnv: { type: "stdio", command: "node", env: { PLUGIN_ROOT: "override" } },
        insecureRemote: { type: "streamable-http", url: "http://example.test/mcp" },
        duplicateHeader: { type: "streamable-http", url: "https://example.test/mcp", headers: { "X-Test": "one", "x-test": "two" } },
        valid: { type: "stdio", command: "node" },
      },
    });
    writeJson(join(project, ".mcp.json"), {
      settings: { agentPluginPaths: [plugin] },
      mcpServers: { native: { command: "native" } },
    });

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadMcpConfig } = await import("../config.ts");
    expect(Object.keys(loadMcpConfig().mcpServers).sort()).toEqual(["bad-plugin__valid", "native"]);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("does not let Agent Plugin normalized server-name collisions overwrite servers", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-plugin-collision-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-agent-plugin-collision-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const plugin = join(project, "plugins", "collision-plugin");
    writeJson(join(plugin, "plugin.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "collision-plugin",
    });
    writeJson(join(plugin, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        "tools.db": { type: "stdio", command: "node", args: ["first.js"] },
        tools_db: { type: "stdio", command: "node", args: ["second.js"] },
      },
    });
    writeJson(join(project, ".mcp.json"), {
      settings: { agentPluginPaths: [plugin] },
      mcpServers: {},
    });

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers["collision-plugin__tools_db"].args).toEqual(["first.js"]);
    expect(Object.keys(loadMcpConfig().mcpServers)).toEqual(["collision-plugin__tools_db"]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("normalized server name collision-plugin__tools_db already exists"));
    warning.mockRestore();
  });

  it("loads standard MCP files first, then Pi overrides", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-config-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-config-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const realProject = realpathSync(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      settings: { idleTimeout: 5, requestTimeoutMs: 1500, showStatusIcon: true },
      mcpServers: {
        shared: { command: "generic" },
        genericOnly: { command: "generic-only" },
      },
    });

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      settings: { toolPrefix: "short", directTools: true },
      mcpServers: {
        shared: { command: "pi-global" },
        piOnly: { command: "pi-only" },
      },
    });

    writeJson(join(project, ".mcp.json"), {
      settings: { toolPrefix: "none", oauthDir: "shared-oauth" },
      mcpServers: {
        shared: { command: "project" },
        projectOnly: { command: "project-only" },
      },
    });

    writeJson(join(project, ".pi", "mcp.json"), {
      settings: { autoAuth: true, oauthDir: ".pi/oauth", showStatusIcon: false },
      mcpServers: {
        shared: { command: "project-pi" },
        projectPiOnly: { command: "project-pi-only" },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers.shared).toMatchObject({ command: "project-pi" });
    expect(config.mcpServers.genericOnly).toMatchObject({ command: "generic-only" });
    expect(config.mcpServers.piOnly).toMatchObject({ command: "pi-only" });
    expect(config.mcpServers.projectOnly).toMatchObject({ command: "project-only" });
    expect(config.mcpServers.projectPiOnly).toMatchObject({ command: "project-pi-only" });
    expect(config.settings).toEqual({
      idleTimeout: 5,
      requestTimeoutMs: 1500,
      showStatusIcon: false,
      toolPrefix: "none",
      directTools: true,
      autoAuth: true,
      oauthDir: ".pi/oauth",
    });
  });

  it("loads the branded project Pi override path", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-config-branded-home-"));
    const packageDir = mkdtempSync(join(tmpdir(), "pi-mcp-config-branded-package-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-config-branded-project-"));
    process.env.HOME = home;
    process.env.PI_PACKAGE_DIR = packageDir;
    process.chdir(project);

    writeJson(join(packageDir, "package.json"), { piConfig: { name: "arc", configDir: ".arc" } });
    writeJson(join(project, ".arc", "mcp.json"), {
      mcpServers: {
        brandedProject: { command: "branded" },
      },
    });

    const { getProjectPiConfigPath, loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(getProjectPiConfigPath(project)).toBe(join(project, ".arc", "mcp.json"));
    expect(config.mcpServers.brandedProject).toMatchObject({ command: "branded" });
  });

  it("replaces transport-specific fields when an override switches to or from a socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-config-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-config-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        toSocket: { command: "old", args: ["--old"], env: { OLD: "1" }, cwd: "/old" },
        toCommand: { socket: "/old.sock" },
        toUrl: { socket: "/old.sock" },
      },
    });
    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      mcpServers: {
        toSocket: { socket: "/shared.sock" },
        toCommand: { command: "new" },
        toUrl: { url: "https://example.test/mcp" },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const servers = loadMcpConfig().mcpServers;
    expect(servers.toSocket).toEqual({ socket: "/shared.sock" });
    expect(servers.toCommand).toEqual({ command: "new" });
    expect(servers.toUrl).toEqual({ url: "https://example.test/mcp" });
  });

  it("loads tool-agnostic .agents global MCP files before Pi overrides", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-agents-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-agents-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        shared: { command: "generic" },
        genericOnly: { command: "generic-only" },
      },
    });
    writeJson(join(home, ".agents", "mcp.json"), {
      mcpServers: {
        shared: { command: "agents-flat" },
        agentsShared: { command: "agents-flat-shared" },
        agentsFlatOnly: { command: "agents-flat-only" },
      },
    });
    writeJson(join(home, ".agents", "mcp", "mcp.json"), {
      mcpServers: {
        shared: { command: "agents-nested" },
        agentsShared: { command: "agents-nested-shared" },
        agentsNestedOnly: { command: "agents-nested-only" },
      },
    });
    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      mcpServers: {
        shared: { command: "pi-global" },
        piOnly: { command: "pi-only" },
      },
    });

    const { loadMcpConfig, getMcpDiscoverySummary } = await import("../config.ts");

    expect(loadMcpConfig().mcpServers).toMatchObject({
      shared: { command: "pi-global" },
      genericOnly: { command: "generic-only" },
      agentsShared: { command: "agents-nested-shared" },
      agentsFlatOnly: { command: "agents-flat-only" },
      agentsNestedOnly: { command: "agents-nested-only" },
      piOnly: { command: "pi-only" },
    });
    expect(getMcpDiscoverySummary().sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "shared-global", path: join(home, ".config", "mcp", "mcp.json"), serverCount: 2 }),
        expect.objectContaining({ id: "agents-global", path: join(home, ".agents", "mcp.json"), serverCount: 3 }),
        expect.objectContaining({ id: "agents-nested-global", path: join(home, ".agents", "mcp", "mcp.json"), serverCount: 3 }),
      ]),
    );
  });

  it("loads JSONC MCP config files with comments and trailing commas", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-jsonc-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-jsonc-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const realProject = realpathSync(project);

    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "mcp.json"),
      `{
        // Import editor configs with documented servers.
        "imports": ["vscode",],
        "mcpServers": {
          "global": {
            "command": "global-server",
          },
        },
      }`,
      "utf-8",
    );

    mkdirSync(join(project, ".vscode"), { recursive: true });
    writeFileSync(
      join(project, ".vscode", "mcp.json"),
      `{
        "mcpServers": {
          /* Common team server. */
          "editor": {
            "command": "editor-server",
          },
        },
      }`,
      "utf-8",
    );

    writeFileSync(
      join(project, ".mcp.json"),
      `{
        "mcpServers": {
          "project": {
            "command": "project-server",
          },
        },
      }`,
      "utf-8",
    );

    const { loadMcpConfig, getMcpDiscoverySummary } = await import("../config.ts");

    expect(loadMcpConfig().mcpServers).toMatchObject({
      global: { command: "global-server" },
      editor: { command: "editor-server" },
      project: { command: "project-server" },
    });
    expect(getMcpDiscoverySummary().imports).toEqual([
      expect.objectContaining({ kind: "vscode", path: resolve(realProject, ".vscode", "mcp.json"), serverCount: 1 }),
    ]);
  });

  it("updates project Pi overrides that were hand-edited as JSONC", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-jsonc-write-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-jsonc-write-project-"));
    process.env.HOME = home;
    process.chdir(project);

    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "mcp.json"),
      `{
        // Keep this file easy to hand edit.
        "mcp-servers": {
          "server": {
            "command": "original",
          },
        },
      }`,
      "utf-8",
    );

    const { writeProjectServerDisabledOverride } = await import("../config.ts");
    expect(writeProjectServerDisabledOverride(undefined, project, "server", true)).toEqual({
      path: join(project, ".pi", "mcp.json"),
      changed: true,
    });
    expect(JSON.parse(readFileSync(join(project, ".pi", "mcp.json"), "utf-8"))).toEqual({
      "mcp-servers": {
        server: {
          command: "original",
          disabled: true,
        },
      },
    });
  });

  it("resolves configured oauthDir against the active project cwd", async () => {
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-oauthdir-project-"));
    const absolute = mkdtempSync(join(tmpdir(), "pi-mcp-oauthdir-absolute-"));

    const { resolveConfiguredOAuthDir } = await import("../config.ts");

    expect(resolveConfiguredOAuthDir(".pi/oauth", project)).toBe(resolve(project, ".pi/oauth"));
    expect(resolveConfiguredOAuthDir(absolute, project)).toBe(resolve(absolute));
    expect(resolveConfiguredOAuthDir("  ", project)).toBeUndefined();
    expect(() => resolveConfiguredOAuthDir(123, project)).toThrow(/settings\.oauthDir must be a string/);
  });

  it("prefers modern Claude Code config detection over legacy paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-import-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-import-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const realProject = realpathSync(project);

    writeJson(join(home, ".claude", "mcp.json"), { mcpServers: { modern: { command: "modern" } } });
    writeJson(join(home, ".claude.json"), { mcpServers: { old: { command: "old" } } });
    writeJson(join(project, ".vscode", "mcp.json"), { mcpServers: { editor: { command: "code" } } });

    const { findAvailableImportConfigs } = await import("../config.ts");
    const imports = findAvailableImportConfigs();

    expect(imports).toEqual(
      expect.arrayContaining([
        { kind: "claude-code", path: join(home, ".claude", "mcp.json") },
        { kind: "vscode", path: resolve(realProject, ".vscode", "mcp.json") },
      ]),
    );
  });

  it("keeps host discovery opt-in and reports active sources, precedence, conflicts, and provenance", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-host-discovery-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-host-discovery-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        hostOnly: { command: "cursor-server" },
        shared: {
          url: "https://host.example/mcp",
          headers: { Authorization: "Bearer host-secret" },
        },
      },
    });
    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        shared: { url: "https://shared.example/mcp" },
      },
    });

    const { getMcpDiscoverySummary, getServerProvenance, loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({ shared: { url: "https://shared.example/mcp" } });
    expect(getMcpDiscoverySummary().hostConfigs).toEqual([
      expect.objectContaining({ kind: "cursor", active: false, serverCount: 2 }),
    ]);

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      settings: { hostConfigDiscovery: "on" },
      mcpServers: {},
    });

    const config = loadMcpConfig();
    expect(config.mcpServers.hostOnly).toEqual({ command: "cursor-server" });
    expect(config.mcpServers.shared).toEqual({ url: "https://shared.example/mcp" });
    expect(getMcpDiscoverySummary().hostConfigs).toEqual([
      expect.objectContaining({ kind: "cursor", active: true, serverCount: 2 }),
    ]);
    expect(getMcpDiscoverySummary().conflicts).toEqual([
      expect.objectContaining({
        serverName: "shared",
        winner: { kind: "shared", path: join(home, ".config", "mcp", "mcp.json") },
      }),
    ]);
    expect(getServerProvenance().get("hostOnly")).toEqual({
      path: join(home, ".pi", "agent", "mcp.json"),
      kind: "import",
      importKind: "cursor",
    });
    expect(config.mcpServers.shared.headers).toBeUndefined();
  });

  it("reports the deterministic winning host provenance for same-name servers", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-host-collision-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-host-collision-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: { same: { command: "cursor-server" } },
    });
    writeJson(join(home, ".codex", "config.json"), {
      mcp_servers: { same: { command: "codex-server" } },
    });
    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      settings: { hostConfigDiscovery: "on" },
      mcpServers: {},
    });

    const { getServerProvenance, loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers.same).toEqual({ command: "codex-server" });
    expect(getServerProvenance().get("same")).toEqual({
      path: join(home, ".pi", "agent", "mcp.json"),
      kind: "import",
      importKind: "codex",
    });
  });

  it("classifies project Pi overrides as Pi-owned conflict sources", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-project-pi-conflict-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-project-pi-conflict-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const sharedPath = join(home, ".config", "mcp", "mcp.json");
    const projectPiPath = join(process.cwd(), ".pi", "mcp.json");
    writeJson(sharedPath, { mcpServers: { same: { command: "shared-server" } } });
    writeJson(projectPiPath, { mcpServers: { same: { command: "project-pi-server" } } });

    const { getMcpDiscoverySummary, loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers.same).toEqual({ command: "project-pi-server" });
    expect(getMcpDiscoverySummary().conflicts).toEqual([
      {
        serverName: "same",
        sources: [
          { kind: "shared", path: sharedPath },
          { kind: "pi", path: projectPiPath },
        ],
        winner: { kind: "pi", path: projectPiPath },
      },
    ]);
  });

  it("imports Codex MCP servers from config.toml", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-codex-toml-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-codex-toml-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      imports: ["codex"],
      mcpServers: {},
    });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.context7]",
        'url = "https://mcp.context7.com/mcp"',
        "",
        "[mcp_servers.serena]",
        'command = "uvx"',
        'args = ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"]',
      ].join("\n"),
    );

    const { loadMcpConfig, getMcpDiscoverySummary, getServerProvenance } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers).toEqual({
      context7: { url: "https://mcp.context7.com/mcp" },
      serena: {
        command: "uvx",
        args: ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"],
      },
    });
    expect(getMcpDiscoverySummary().imports).toEqual([
      expect.objectContaining({ kind: "codex", path: join(home, ".codex", "config.toml"), serverCount: 2 }),
    ]);
    expect(getServerProvenance().get("context7")).toEqual({
      path: join(home, ".pi", "agent", "mcp.json"),
      kind: "import",
      importKind: "codex",
    });
  });

  it("maps Codex HTTP authentication fields to adapter fields", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-codex-http-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-codex-http-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), { imports: ["codex"], mcpServers: {} });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.remote]",
        'url = "https://mcp.example.com/mcp"',
        'bearer_token_env_var = "CODEX_TOKEN"',
        'http_headers = { "X-API-Key" = "literal-key" }',
        'env_http_headers = { "X-Trace-ID" = "CODEX_TRACE_ID" }',
      ].join("\n"),
    );

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers.remote).toEqual({
      url: "https://mcp.example.com/mcp",
      auth: "bearer",
      bearerTokenEnv: "CODEX_TOKEN",
      headers: {
        "X-API-Key": "literal-key",
        "X-Trace-ID": "$env:CODEX_TRACE_ID",
      },
    });
  });

  it("preserves invalid TOML warnings and JSON fallback in provenance", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-codex-fallback-provenance-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-codex-fallback-provenance-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    writeJson(join(home, ".pi", "agent", "mcp.json"), { imports: ["codex"], mcpServers: {} });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.exa\\nurl = \\\"broken\\\"\\n");
    writeJson(join(home, ".codex", "config.json"), {
      mcpServers: { exa: { url: "https://mcp.exa.ai/mcp" } },
    });

    const { getServerProvenance } = await import("../config.ts");
    expect(getServerProvenance().get("exa")).toEqual({
      path: join(home, ".pi", "agent", "mcp.json"),
      kind: "import",
      importKind: "codex",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to inspect imported MCP config from codex:"),
      expect.anything(),
    );
  });

  it("reports invalid TOML warnings while discovering the JSON fallback", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-codex-fallback-discovery-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-codex-fallback-discovery-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.exa\\nurl = \\\"broken\\\"\\n");
    writeJson(join(home, ".codex", "config.json"), {
      mcpServers: { exa: { url: "https://mcp.exa.ai/mcp" } },
    });

    const { findAvailableImportConfigs, getMcpDiscoverySummary } = await import("../config.ts");
    expect(findAvailableImportConfigs()).toContainEqual({ kind: "codex", path: join(home, ".codex", "config.json") });
    expect(getMcpDiscoverySummary().imports).toEqual([
      expect.objectContaining({ kind: "codex", path: join(home, ".codex", "config.json"), serverCount: 1 }),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to discover imported MCP config from codex:"),
      expect.anything(),
    );
  });

  it("keeps Codex JSON imports working when config.toml is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-codex-json-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-codex-json-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), { imports: ["codex"], mcpServers: {} });
    writeJson(join(home, ".codex", "config.json"), {
      mcpServers: { exa: { url: "https://mcp.exa.ai/mcp" } },
    });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({ exa: { url: "https://mcp.exa.ai/mcp" } });
  });

  it("merges partial Pi overrides into shared and imported server definitions", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-merge-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-merge-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        sharedServer: { command: "shared", args: ["--stdio"], env: { TOKEN: "shared-token" } },
      },
    });

    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        importedStdio: { command: "cursor-stdio", args: ["--from-cursor"], env: { TOKEN: "cursor-token" } },
        importedHttp: {
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer imported" },
          auth: "bearer",
        },
      },
    });

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      imports: ["cursor"],
      mcpServers: {
        sharedServer: { directTools: true },
        importedStdio: { directTools: ["search"] },
        importedHttp: { directTools: true, auth: false },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers.sharedServer).toEqual({
      command: "shared",
      args: ["--stdio"],
      env: { TOKEN: "shared-token" },
      directTools: true,
    });
    expect(config.mcpServers.importedStdio).toEqual({
      command: "cursor-stdio",
      args: ["--from-cursor"],
      env: { TOKEN: "cursor-token" },
      directTools: ["search"],
    });
    expect(config.mcpServers.importedHttp).toEqual({
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer imported" },
      auth: false,
      directTools: true,
    });
  });

  // SECURITY: credential/url binding in mergeServerMaps. A lower-precedence
  // source (~/.config/mcp/mcp.json) defines an HTTP server with an
  // Authorization header; a higher-precedence source (~/.pi/agent/mcp.json)
  // overrides it. Auth material bound to the original url must not follow the
  // server to a different url. See config.ts mergeServerMaps.
  const URL_A = "https://litellm.internal/mcp/";
  const URL_B = "https://attacker.example/mcp/";

  function writeBakedAndOverride(
    home: string,
    project: string,
    baked: Record<string, unknown>,
    override: Record<string, unknown>,
  ): void {
    process.env.HOME = home;
    process.chdir(project);
    // Lowest precedence — the baked, credential-bearing definition.
    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: { litellm: baked },
    });
    // Higher precedence — the (potentially untrusted) override.
    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      mcpServers: { litellm: override },
    });
  }

  it("preserves inherited auth when a higher-precedence override keeps the same url", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-a-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-a-project-"));
    writeBakedAndOverride(
      home,
      project,
      { url: URL_A, headers: { Authorization: "Bearer secret-vk" } },
      { url: URL_A, directTools: true },
    );

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers.litellm).toEqual({
      url: URL_A,
      headers: { Authorization: "Bearer secret-vk" },
      directTools: true,
    });
  });

  it("drops inherited auth when a higher-precedence override changes the url without supplying new auth", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-b-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-b-project-"));
    writeBakedAndOverride(
      home,
      project,
      { url: URL_A, headers: { Authorization: "Bearer secret-vk" } },
      { url: URL_B },
    );

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers.litellm).toEqual({ url: URL_B });
    expect(config.mcpServers.litellm.headers).toBeUndefined();
  });

  it("keeps only the new auth when a higher-precedence override changes both url and headers", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-c-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-c-project-"));
    writeBakedAndOverride(
      home,
      project,
      { url: URL_A, headers: { Authorization: "Bearer secret-vk" } },
      { url: URL_B, headers: { Authorization: "Bearer override-token" } },
    );

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers.litellm).toEqual({
      url: URL_B,
      headers: { Authorization: "Bearer override-token" },
    });
  });

  it("does not exfiltrate the baked VK when a url-only override repoints the server", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-d-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-d-project-"));
    // The baked config carries the real VK as an unexpanded interpolation
    // template; expansion happens at egress. If the header survives a url-only
    // override, the interpolated VK is shipped to the attacker url.
    writeBakedAndOverride(
      home,
      project,
      {
        url: URL_A,
        headers: { Authorization: "Bearer ${LITELLM_API_KEY}" },
        bearerTokenEnv: "LITELLM_API_KEY",
      },
      { url: URL_B },
    );

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    const entry = config.mcpServers.litellm;
    expect(entry.url).toBe(URL_B);
    expect(entry.headers).toBeUndefined();
    expect(entry.bearerTokenEnv).toBeUndefined();
    // No auth-bearing material of any kind may reference the VK.
    expect(JSON.stringify(entry)).not.toContain("LITELLM_API_KEY");
  });

  // Per-field coverage for each URL-bound auth shape beyond headers and
  // bearerTokenEnv — guards against regressions where one credential path keeps
  // leaking while the other tests stay green.
  it("drops an inherited bearerToken when a url-only override repoints the server", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-bt-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-bt-project-"));
    writeBakedAndOverride(
      home,
      project,
      { url: URL_A, bearerToken: "secret-bearer-token" },
      { url: URL_B },
    );

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    const entry = config.mcpServers.litellm;
    expect(entry).toEqual({ url: URL_B });
    expect(entry.bearerToken).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("secret-bearer-token");
  });

  it("drops inherited bearerTokenStore when a url-only override repoints the server", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-bts-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-bts-project-"));
    writeBakedAndOverride(
      home,
      project,
      { url: URL_A, auth: "bearer", bearerTokenStore: true },
      { url: URL_B },
    );

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    const entry = config.mcpServers.litellm;
    expect(entry).toEqual({ url: URL_B, auth: "bearer" });
    expect(entry.bearerTokenStore).toBeUndefined();
  });

  it("drops an inherited request headers command when a url-only override repoints the server", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-rhc-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-rhc-project-"));
    writeBakedAndOverride(
      home,
      project,
      { url: URL_A, requestHeadersCommand: { command: "sign-old-url", args: ["${REQUEST_SECRET}"] } },
      { url: URL_B },
    );

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    const entry = config.mcpServers.litellm;
    expect(entry).toEqual({ url: URL_B });
    expect(entry.requestHeadersCommand).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("REQUEST_SECRET");
  });

  it("drops inherited oauth config when a url-only override repoints the server", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-oauth-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-oauth-project-"));
    writeBakedAndOverride(
      home,
      project,
      { url: URL_A, oauth: { clientId: "client", clientSecret: "oauth-client-secret" } },
      { url: URL_B },
    );

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    const entry = config.mcpServers.litellm;
    expect(entry).toEqual({ url: URL_B });
    expect(entry.oauth).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("oauth-client-secret");
  });

  it("preserves inherited oauth false when a url-only override repoints the server", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-oauth-false-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-oauth-false-project-"));
    writeBakedAndOverride(home, project, { url: URL_A, oauth: false }, { url: URL_B });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers.litellm).toEqual({ url: URL_B, oauth: false });
  });

  // Three-source laundering: the accumulated (folded) entry's url — not just a
  // pairwise base — must drive the strip decision. A middle source re-supplies
  // the auth WITHOUT a url (so it is inherited against the still-url-A entry),
  // then the top source repoints the url; the top override must still strip the
  // accumulated auth.
  it("does not launder auth across three sources when the top source changes the url", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-3src-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-urlauth-3src-project-"));
    process.env.HOME = home;
    process.chdir(project);

    // Lowest precedence (shared-global): baked url + VK header.
    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: { litellm: { url: URL_A, headers: { Authorization: "Bearer secret-vk" } } },
    });
    // Middle precedence (pi-global): re-supplies auth but NO url — inherited
    // against the still-url-A accumulated entry.
    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      mcpServers: { litellm: { headers: { Authorization: "Bearer secret-vk" } } },
    });
    // Highest precedence (shared-project): repoints the url, supplies no auth.
    writeJson(join(project, ".mcp.json"), {
      mcpServers: { litellm: { url: URL_B } },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    const entry = config.mcpServers.litellm;
    expect(entry).toEqual({ url: URL_B });
    expect(entry.headers).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("secret-vk");
  });

  it("tracks provenance so project servers write locally and shared/imported servers write to Pi config", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-provenance-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-provenance-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const realProject = realpathSync(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        genericServer: { command: "generic" },
      },
    });

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      imports: ["cursor"],
      mcpServers: {
        userServer: { command: "user" },
      },
    });

    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        importedServer: { command: "cursor" },
      },
    });

    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        projectServer: { command: "project" },
      },
    });

    writeJson(join(project, ".pi", "mcp.json"), {
      mcpServers: {
        projectPiServer: { command: "project-pi" },
      },
    });

    const { getServerProvenance, getPiGlobalConfigPath } = await import("../config.ts");
    const provenance = getServerProvenance();
    const piConfigPath = getPiGlobalConfigPath();

    expect(provenance.get("genericServer")).toEqual({
      path: piConfigPath,
      kind: "import",
      importKind: "global MCP config",
    });
    expect(provenance.get("importedServer")).toEqual({
      path: piConfigPath,
      kind: "import",
      importKind: "cursor",
    });
    expect(provenance.get("userServer")).toEqual({
      path: piConfigPath,
      kind: "user",
      importKind: undefined,
    });
    expect(provenance.get("projectServer")).toEqual({
      path: resolve(realProject, ".mcp.json"),
      kind: "project",
      importKind: undefined,
    });
    expect(provenance.get("projectPiServer")).toEqual({
      path: resolve(realProject, ".pi", "mcp.json"),
      kind: "project",
      importKind: undefined,
    });
  });

  it("summarizes discovery and detects RepoPrompt suggestions", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-summary-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-summary-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const realProject = realpathSync(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        sharedServer: { command: "shared" },
      },
    });

    writeJson(join(project, "package.json"), { name: "fixture" });
    writeJson(join(home, "RepoPrompt", "repoprompt_cli"), "#!/bin/sh\n");
    writeJson(join(home, ".cursor", "mcp.json"), {
      mcpServers: {
        importedServer: { command: "cursor" },
      },
    });

    const { getMcpDiscoverySummary } = await import("../config.ts");
    const summary = getMcpDiscoverySummary();

    expect(summary.hasSharedServers).toBe(true);
    expect(summary.sources.find((source) => source.id === "shared-global")?.serverCount).toBe(1);
    expect(summary.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "cursor", serverCount: 1 }),
      ]),
    );
    expect(summary.repoPrompt).toMatchObject({
      configured: false,
      executablePath: join(home, "RepoPrompt", "repoprompt_cli"),
      targetPath: resolve(realProject, ".mcp.json"),
      serverName: "repoprompt",
    });
  });

  it("writes imported/global changes to Pi config and project changes to the project file", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-write-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-write-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      mcpServers: {
        genericServer: { command: "generic" },
      },
    });

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      mcpServers: {},
    });

    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        projectServer: { command: "project" },
      },
    });

    const { getServerProvenance, loadMcpConfig, writeDirectToolsConfig, getPiGlobalConfigPath } = await import("../config.ts");
    const fullConfig = loadMcpConfig();
    const provenance = getServerProvenance();

    writeDirectToolsConfig(
      new Map([
        ["genericServer", true],
        ["projectServer", ["search"]],
      ]),
      provenance,
      fullConfig,
    );

    const userConfig = JSON.parse(readFileSync(getPiGlobalConfigPath(), "utf-8"));
    expect(userConfig.mcpServers.genericServer).toMatchObject({ command: "generic", directTools: true });

    const projectConfig = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf-8"));
    expect(projectConfig.mcpServers.projectServer).toMatchObject({ command: "project", directTools: ["search"] });
  });

  it("builds real diff previews for compatibility imports and shared server writes", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-preview-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-preview-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      imports: ["cursor"],
      mcpServers: {
        existing: { command: "demo" },
      },
    });

    const {
      previewCompatibilityImports,
      previewSharedServerEntry,
      getGenericGlobalConfigPath,
    } = await import("../config.ts");

    const importsPreview = previewCompatibilityImports(["cursor", "codex"]);
    expect(importsPreview.path).toContain(".pi/agent/mcp.json");
    expect(importsPreview.changed).toBe(true);
    expect(importsPreview.diffText).toContain("+++ after");
    expect(importsPreview.diffText).toContain('+     "codex"');

    const sharedPreview = previewSharedServerEntry(getGenericGlobalConfigPath(), "repoprompt", {
      command: "/tmp/repoprompt_cli",
      args: [],
      lifecycle: "lazy",
    });
    expect(sharedPreview.existed).toBe(false);
    expect(sharedPreview.diffText).toContain('+   "mcpServers": {');
    expect(sharedPreview.diffText).toContain('+     "repoprompt": {');
  });

  it("preserves the mcp toolPrefix setting from config files", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-prefix-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-prefix-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".pi", "agent", "mcp.json"), {
      settings: { toolPrefix: "mcp" },
      mcpServers: { demo: { command: "demo" } },
    });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().settings?.toolPrefix).toBe("mcp");
  });

  it("writes selected compatibility imports and a starter project config", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-setup-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-setup-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const { ensureCompatibilityImports, getPiGlobalConfigPath, writeStarterProjectConfig } = await import("../config.ts");
    const importResult = ensureCompatibilityImports(["cursor", "codex"]);
    expect(importResult.added).toEqual(["cursor", "codex"]);

    const piConfig = JSON.parse(readFileSync(getPiGlobalConfigPath(), "utf-8"));
    expect(piConfig.imports).toEqual(["cursor", "codex"]);

    const starterPath = writeStarterProjectConfig();
    const starter = JSON.parse(readFileSync(starterPath, "utf-8"));
    expect(starter.mcpServers).toEqual({});
  });

  it("imports OpenCode servers from the global V1 config", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-global-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-global-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(home, ".pi", "agent", "mcp.json"), { imports: ["opencode"], mcpServers: {} });
    writeJson(join(home, ".config", "opencode", "opencode.json"), {
      mcp: {
        local: { type: "local", command: ["node", "server.js"], environment: { TOKEN: "global" }, cwd: "./servers" },
        remote: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer global" } },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({
      local: { command: "node", args: ["server.js"], env: { TOKEN: "global" }, cwd: "./servers" },
      remote: { url: "https://example.test/mcp", headers: { Authorization: "Bearer global" } },
    });
  });

  it("does not load OpenCode files without an explicit import", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-explicit-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-explicit-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(home, ".config", "opencode", "opencode.json"), {
      mcp: { shouldNotLoad: { type: "local", command: ["unexpected"] } },
    });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({});
  });

  it("imports OpenCode servers from the project V1 config", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-project-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-project-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(home, ".pi", "agent", "mcp.json"), { imports: ["opencode"], mcpServers: {} });
    writeJson(join(project, "opencode.json"), {
      mcp: { projectOnly: { type: "local", command: ["npx", "project-server"] } },
    });

    const { loadMcpConfig, findAvailableImportConfigs } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers.projectOnly).toEqual({ command: "npx", args: ["project-server"] });
    expect(findAvailableImportConfigs()).toContainEqual({ kind: "opencode", path: resolve(realpathSync(project), "opencode.json") });
  });

  it("merges OpenCode global and project servers with nested project precedence", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-merge-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-merge-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(home, ".pi", "agent", "mcp.json"), { imports: ["opencode"], mcpServers: {} });
    writeJson(join(home, ".config", "opencode", "opencode.json"), {
      mcp: {
        shared: {
          type: "remote",
          url: "https://global.test/mcp",
          headers: { "X-Global": "global", "X-Shared": "global" },
          oauth: { clientId: "global-client", scope: "global-scope", skipIssuerMetadataValidation: false },
        },
        globalOnly: { type: "local", command: ["global"] },
      },
    });
    writeJson(join(project, "opencode.json"), {
      mcp: {
        shared: {
          headers: { "X-Project": "project", "X-Shared": "project" },
          oauth: { scope: "project-scope", clientSecret: "project-secret", skipIssuerMetadataValidation: true },
        },
        projectOnly: { type: "local", command: ["project"] },
        oauthFalse: { type: "remote", url: "https://false.test/mcp", oauth: false },
        oauthEmpty: { type: "remote", url: "https://empty.test/mcp", oauth: {} },
        disabled: { type: "local", command: ["disabled"], enabled: false },
        malformed: { type: "local", command: "not-an-array" },
        malformedArgs: { type: "local", command: ["node", 42] },
      },
    });

    const { loadMcpConfig, getMcpDiscoverySummary } = await import("../config.ts");
    const config = loadMcpConfig();
    expect(config.mcpServers).toEqual({
      shared: {
        url: "https://global.test/mcp",
        headers: { "X-Global": "global", "X-Shared": "project", "X-Project": "project" },
        auth: "oauth",
        oauth: {
          clientId: "global-client",
          scope: "project-scope",
          clientSecret: "project-secret",
          skipIssuerMetadataValidation: true,
        },
      },
      globalOnly: { command: "global", args: [] },
      projectOnly: { command: "project", args: [] },
      oauthFalse: { url: "https://false.test/mcp", oauth: false },
      oauthEmpty: { url: "https://empty.test/mcp", auth: "oauth", oauth: {} },
    });
    expect(getMcpDiscoverySummary().imports).toEqual([
      expect.objectContaining({ kind: "opencode", path: resolve(realpathSync(project), "opencode.json"), serverCount: 5 }),
    ]);
  });

  it("finds the nearest OpenCode project config from a nested Git worktree directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-nested-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-nested-project-"));
    const nested = join(project, "packages", "app");
    process.env.HOME = home;
    mkdirSync(join(project, ".git"));
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    writeJson(join(home, ".pi", "agent", "mcp.json"), { imports: ["opencode"], mcpServers: {} });
    writeJson(join(project, "opencode.json"), {
      mcp: { projectRoot: { type: "local", command: ["root-server"] } },
    });

    const { loadMcpConfig, findAvailableImportConfigs } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers.projectRoot).toEqual({ command: "root-server", args: [] });
    expect(findAvailableImportConfigs()).toContainEqual({
      kind: "opencode",
      path: resolve(realpathSync(project), "opencode.json"),
    });
  });

  it("does not inherit remote credentials or local process secrets across identity changes", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-identity-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-identity-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(home, ".pi", "agent", "mcp.json"), { imports: ["opencode"], mcpServers: {} });
    writeJson(join(home, ".config", "opencode", "opencode.json"), {
      mcp: {
        remote: {
          type: "remote",
          url: "https://trusted.test/mcp",
          headers: { Authorization: "Bearer global-secret" },
          oauth: { clientId: "global-client", clientSecret: "global-secret" },
        },
        local: {
          type: "local",
          command: ["trusted-server"],
          environment: { TOKEN: "global-secret" },
          cwd: "/trusted",
        },
      },
    });
    writeJson(join(project, "opencode.json"), {
      mcp: {
        remote: { url: "https://project.test/mcp" },
        local: { command: ["project-server"] },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers).toEqual({
      remote: { url: "https://project.test/mcp" },
      local: { command: "project-server", args: [] },
    });
  });

  it("reports the highest-precedence OpenCode file that parsed successfully", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-malformed-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-opencode-malformed-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(home, ".pi", "agent", "mcp.json"), { imports: ["opencode"], mcpServers: {} });
    const globalPath = join(home, ".config", "opencode", "opencode.json");
    writeJson(globalPath, {
      mcp: { globalOnly: { type: "local", command: ["global"] } },
    });
    writeFileSync(join(project, "opencode.json"), "{ malformed", "utf-8");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loadMcpConfig, getMcpDiscoverySummary } = await import("../config.ts");
    expect(loadMcpConfig().mcpServers.globalOnly).toEqual({ command: "global", args: [] });
    expect(getMcpDiscoverySummary().imports).toEqual([
      expect.objectContaining({ kind: "opencode", path: globalPath, serverCount: 1 }),
    ]);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("uses automatic protocol negotiation for remote known-server presets", async () => {
    const { KNOWN_SERVER_PRESETS } = await import("../config.ts");
    for (const preset of KNOWN_SERVER_PRESETS.filter(({ entry }) => entry.url)) {
      expect(preset.entry.protocolVersion).toBe("auto");
    }
    expect(KNOWN_SERVER_PRESETS.find(({ id }) => id === "parallel-search")?.entry).toEqual({
      url: "https://search.parallel.ai/mcp",
      protocolVersion: "auto",
      directTools: true,
    });
    expect(KNOWN_SERVER_PRESETS.find(({ id }) => id === "chrome-devtools")?.entry.protocolVersion).toBeUndefined();
  });
});
