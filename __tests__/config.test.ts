import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("config discovery", () => {
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.chdir(originalCwd);
  });

  it("loads standard MCP files first, then Pi overrides", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-config-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-config-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const realProject = realpathSync(project);

    writeJson(join(home, ".config", "mcp", "mcp.json"), {
      settings: { idleTimeout: 5, requestTimeoutMs: 1500 },
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
      settings: { toolPrefix: "none" },
      mcpServers: {
        shared: { command: "project" },
        projectOnly: { command: "project-only" },
      },
    });

    writeJson(join(project, ".pi", "mcp.json"), {
      settings: { autoAuth: true },
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
      toolPrefix: "none",
      directTools: true,
      autoAuth: true,
    });
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

  // Per-field coverage for every member of URL_BOUND_AUTH_FIELDS beyond
  // headers/bearerTokenEnv — guards against a regression that silently drops a
  // field from the strip set while the other tests stay green.
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
});
