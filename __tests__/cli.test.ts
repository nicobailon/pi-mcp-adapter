import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("cli init helper", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalPackageDir = process.env.PI_PACKAGE_DIR;
  const originalArcAgentDir = process.env.ARC_CODING_AGENT_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    if (originalPackageDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPackageDir;
    }
    if (originalArcAgentDir === undefined) {
      delete process.env.ARC_CODING_AGENT_DIR;
    } else {
      process.env.ARC_CODING_AGENT_DIR = originalArcAgentDir;
    }
    process.chdir(originalCwd);
  });

  it("adds detected host imports to the Pi config", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-project-"));
    process.env.HOME = home;
    process.chdir(project);

    writeJson(join(home, ".claude", "mcp.json"), {
      mcpServers: {
        claudeServer: { command: "claude" },
      },
    });

    const logs: string[] = [];
    const errors: string[] = [];
    const { main } = await import("../cli.js");
    const exitCode = await main(["init"], (line) => logs.push(line), (line) => errors.push(line));

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);

    const piConfigPath = join(home, ".pi", "agent", "mcp-adapter.json");
    expect(existsSync(piConfigPath)).toBe(true);
    const config = JSON.parse(readFileSync(piConfigPath, "utf-8"));
    expect(config.imports).toContain("claude-code");
    expect(logs.join("\n")).toContain("Updated");
  });

  it("detects TOML-only Codex config during dry-run", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-codex-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-codex-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const codexConfigPath = join(home, ".codex", "config.toml");
    mkdirSync(dirname(codexConfigPath), { recursive: true });
    writeFileSync(codexConfigPath, '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n', "utf-8");

    const logs: string[] = [];
    const errors: string[] = [];
    const { main } = await import("../cli.js");
    const exitCode = await main(["init", "--dry-run"], (line) => logs.push(line), (line) => errors.push(line));

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain(`codex: ${codexConfigPath}`);
    expect(logs.join("\n")).toContain("Detected host configs to import into the MCP adapter: codex");
    expect(existsSync(join(home, ".pi", "agent", "mcp.json"))).toBe(false);
  });

  it("loads existing Pi config as JSONC and lists .agents standard paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-jsonc-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-jsonc-project-"));
    process.env.HOME = home;
    process.chdir(project);

    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "mcp-adapter.json"), `{
      // Existing config stays editable by humans.
      "imports": ["vscode",],
      "mcpServers": {
        "existing": { "command": "existing" },
      },
    }`, "utf-8");

    const logs: string[] = [];
    const errors: string[] = [];
    const { main } = await import("../cli.js");
    const exitCode = await main(["init", "--dry-run"], (line) => logs.push(line), (line) => errors.push(line));

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    const output = logs.join("\n");
    expect(output).toContain(`User-global .agents MCP: ${join(home, ".agents", "mcp.json")}`);
    expect(output).toContain(`User-global .agents nested MCP: ${join(home, ".agents", "mcp", "mcp.json")}`);
    expect(output).toContain("No MCP adapter config changes needed.");
  });

  it("preserves existing servers when init updates a config with a UTF-8 BOM", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-bom-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-bom-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const configPath = join(home, ".pi", "agent", "mcp-adapter.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, '\uFEFF{"mcpServers":{"existing":{"command":"existing-server"}}}');
    writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { imported: { command: "cursor-server" } } });

    const { main } = await import("../cli.js");
    expect(await main(["init", "--discover-host-configs"], () => {}, () => {})).toBe(0);
    const saved = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(saved.mcpServers.existing).toEqual({ command: "existing-server" });
    expect(saved.imports).toContain("cursor");
  });

  it("initializes an existing whitespace-only config", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-blank-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-blank-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const path = join(home, ".pi", "agent", "mcp-adapter.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "  \n");

    const { main } = await import("../cli.js");
    expect(await main(["init", "--discover-host-configs"], () => {}, () => {})).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf-8")).settings.hostConfigDiscovery).toBe("on");
  });

  it("preserves a comment-only config during init", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-comment-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-comment-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const path = join(home, ".pi", "agent", "mcp-adapter.json");
    const contents = "// Keep this note.\n";
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);

    const { main } = await import("../cli.js");
    await expect(main(["init", "--discover-host-configs"], () => {}, () => {})).rejects.toThrow();
    expect(readFileSync(path, "utf-8")).toBe(contents);
  });

  it.each([
    ["an array root", "[]"],
    ["non-string imports", '{"imports":["cursor",42]}'],
    ["non-object settings", '{"settings":42}'],
  ])("preserves %s when init would update the config", async (_kind, contents) => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-invalid-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-invalid-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const path = join(home, ".pi", "agent", "mcp-adapter.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);

    const { main } = await import("../cli.js");
    await expect(main(["init", "--discover-host-configs"])).rejects.toThrow(`Invalid MCP config at ${path}`);
    expect(readFileSync(path, "utf-8")).toBe(contents);
  });

  it("does not write through a config symlink whose target is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-broken-link-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-broken-link-project-"));
    process.env.HOME = home;
    process.chdir(project);
    const path = join(home, ".pi", "agent", "mcp-adapter.json");
    const target = join(home, ".pi", "agent", "missing.json");
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);

    const { main } = await import("../cli.js");
    await expect(main(["init", "--discover-host-configs"])).rejects.toThrow();
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it("explicitly enables host fallback discovery without changing external files", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-discovery-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-discovery-project-"));
    process.env.HOME = home;
    process.chdir(project);

    const hostPath = join(home, ".cursor", "mcp.json");
    writeJson(hostPath, { mcpServers: { cursorServer: { command: "cursor" } } });

    const logs: string[] = [];
    const errors: string[] = [];
    const { main } = await import("../cli.js");
    const exitCode = await main(["init", "--discover-host-configs"], (line) => logs.push(line), (line) => errors.push(line));

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    const piConfigPath = join(home, ".pi", "agent", "mcp-adapter.json");
    expect(JSON.parse(readFileSync(piConfigPath, "utf-8")).settings).toEqual({ hostConfigDiscovery: "on" });
    expect(readFileSync(hostPath, "utf-8")).toContain("cursorServer");
    expect(logs.join("\n")).toContain("Opting in to host-specific fallback discovery");
  });

  it("writes detected host imports to PI_CODING_AGENT_DIR when set", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-cli-agent-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-project-"));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(project);

    writeJson(join(home, ".claude", "mcp.json"), {
      mcpServers: {
        claudeServer: { command: "claude" },
      },
    });

    const logs: string[] = [];
    const errors: string[] = [];
    const { main } = await import("../cli.js");
    const exitCode = await main(["init"], (line) => logs.push(line), (line) => errors.push(line));

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);

    const piConfigPath = join(agentDir, "mcp-adapter.json");
    expect(existsSync(piConfigPath)).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "mcp.json"))).toBe(false);
    const config = JSON.parse(readFileSync(piConfigPath, "utf-8"));
    expect(config.imports).toContain("claude-code");
    expect(logs.join("\n")).toContain(piConfigPath);
  });


  it("writes init output to the branded host agent directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-branded-home-"));
    const packageDir = mkdtempSync(join(tmpdir(), "pi-mcp-cli-branded-package-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-cli-branded-agent-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-branded-project-"));
    process.env.HOME = home;
    process.env.PI_PACKAGE_DIR = packageDir;
    process.env.ARC_CODING_AGENT_DIR = agentDir;
    process.chdir(project);

    writeJson(join(packageDir, "package.json"), { piConfig: { name: "arc", configDir: ".arc" } });

    const logs: string[] = [];
    const errors: string[] = [];
    const { main } = await import("../cli.js");
    const exitCode = await main(["init", "--dry-run", "--discover-host-configs"], line => logs.push(line), line => errors.push(line));

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain(`MCP adapter global override: ${join(agentDir, "mcp-adapter.json")}`);
    expect(logs.join("\n")).toContain(`Project MCP adapter override: ${join(process.cwd(), ".arc", "mcp-adapter.json")}`);
    expect(logs.join("\n")).toContain(`Dry run: would update ${join(agentDir, "mcp-adapter.json")}`);
    expect(existsSync(join(home, ".pi", "agent", "mcp.json"))).toBe(false);
  });

  it("runs when invoked through a symlinked bin path", () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "pi-mcp-cli-bin-"));
    const symlinkPath = join(binDir, "pi-mcp-adapter");
    symlinkSync(resolve("cli.js"), symlinkPath);

    const result = spawnSync(process.execPath, [symlinkPath, "init", "--dry-run"], {
      cwd: mkdtempSync(join(tmpdir(), "pi-mcp-cli-project-")),
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      },
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Config discovery:");
    expect(result.stdout).toContain("No MCP adapter config changes needed.");
  });

  it("explains that install now goes through `pi install`", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const { main } = await import("../cli.js");
    const exitCode = await main(["install"], (line) => logs.push(line), (line) => errors.push(line));

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Use `pi install npm:pi-mcp-adapter` instead");
    expect(logs).toEqual([]);
  });
});

describe("cli token helper", () => {
  const originalHome = process.env.HOME;
  const originalAuthStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAuthStore === undefined) {
      delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    } else {
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = originalAuthStore;
    }
    process.chdir(originalCwd);
  });

  function setupProject(): void {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-token-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-token-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(project, ".mcp.json"), {
      mcpServers: {
        remote: { url: "https://example.test/mcp", auth: "bearer", bearerTokenStore: true },
      },
    });
  }

  function tokenStdin(text: string): NodeJS.ReadStream {
    return Readable.from([text]) as unknown as NodeJS.ReadStream;
  }

  it("stores a bearer token from stdin bound to the configured URL", async () => {
    setupProject();
    const { main } = await import("../cli.js");
    const { getBearerTokenForUrl, resetTestBearerTokenStore } = await import("../dist/mcp-bearer-store.js");
    resetTestBearerTokenStore();

    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = await main(["token", "set", "remote"], (line) => logs.push(line), (line) => errors.push(line), tokenStdin("secret-token\n"));

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(getBearerTokenForUrl("remote", "https://example.test/mcp")).toBe("secret-token");
    expect(getBearerTokenForUrl("remote", "https://other.test/mcp")).toBeUndefined();
    expect(logs.join("\n")).not.toContain("secret-token");
    expect(logs.join("\n")).not.toContain("https://example.test/mcp");
  });

  it("rejects a token passed as a command-line argument", async () => {
    setupProject();
    const { main } = await import("../cli.js");
    const { getTestBearerTokenStoreEntries, resetTestBearerTokenStore } = await import("../dist/mcp-bearer-store.js");
    resetTestBearerTokenStore();

    const errors: string[] = [];
    const exitCode = await main(["token", "set", "remote", "secret-token"], () => {}, (line) => errors.push(line), tokenStdin(""));

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("must not be passed on the command line");
    expect(getTestBearerTokenStoreEntries()).toEqual([]);
  });

  it("rejects servers that are not configured for bearerTokenStore", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-token-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-token-project-"));
    process.env.HOME = home;
    process.chdir(project);
    writeJson(join(project, ".mcp.json"), {
      mcpServers: { plain: { url: "https://example.test/mcp" } },
    });
    const { main } = await import("../cli.js");

    const errors: string[] = [];
    const exitCode = await main(["token", "set", "plain"], () => {}, (line) => errors.push(line), tokenStdin("secret-token\n"));

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain('not configured for bearerTokenStore');
  });

  it("reports status and removes stored tokens without exposing them", async () => {
    setupProject();
    const { main } = await import("../cli.js");
    const { getBearerTokenForUrl, resetTestBearerTokenStore, saveBearerTokenForUrl } = await import("../dist/mcp-bearer-store.js");
    resetTestBearerTokenStore();
    saveBearerTokenForUrl("remote", "secret-token", "https://example.test/mcp");

    const statusLogs: string[] = [];
    expect(await main(["token", "status", "remote"], (line) => statusLogs.push(line), () => {}, tokenStdin(""))).toBe(0);
    expect(statusLogs.join("\n")).toContain('Bearer token is stored for "remote".');
    expect(statusLogs.join("\n")).not.toContain("secret-token");

    const removeLogs: string[] = [];
    expect(await main(["token", "remove", "remote"], (line) => removeLogs.push(line), () => {}, tokenStdin(""))).toBe(0);
    expect(getBearerTokenForUrl("remote", "https://example.test/mcp")).toBeUndefined();

    const missingLogs: string[] = [];
    expect(await main(["token", "status", "remote"], (line) => missingLogs.push(line), () => {}, tokenStdin(""))).toBe(1);
    expect(missingLogs.join("\n")).toContain('No bearer token is stored for "remote".');
  });
});

describe("cli System One key helper", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    delete process.env.SYSTEMONE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SYSTEMONE_ENDPOINT;
  });

  function keyStdin(text: string): NodeJS.ReadStream {
    return Readable.from([text]) as unknown as NodeJS.ReadStream;
  }

  it("sets, reports, and removes a key without revealing it", async () => {
    const { main } = await import("../cli.js");
    const { resetTestSecureKeyring } = await import("../dist/secure-keyring.js");
    resetTestSecureKeyring();
    const logs: string[] = [];
    expect(await main(["key", "set", "systemone"], line => logs.push(line), () => {}, keyStdin("cli-secret\n"))).toBe(0);
    expect(logs.join("\n")).not.toContain("cli-secret");
    const status: string[] = [];
    expect(await main(["key", "status", "systemone"], line => status.push(line), () => {}, keyStdin(""))).toBe(0);
    expect(status).toEqual(["source=keyring", "endpoint=https://api.typesafe.ai/v1/systemone"]);
    expect(await main(["key", "remove", "systemone"], () => {}, () => {}, keyStdin(""))).toBe(0);
  });

  it("stores per endpoint and keeps the legacy provider alias working", async () => {
    const { main } = await import("../cli.js");
    const { resetTestSecureKeyring } = await import("../dist/secure-keyring.js");
    resetTestSecureKeyring();
    process.env.SYSTEMONE_ENDPOINT = "https://opencode.ai/zen/v1/systemone";
    expect(await main(["key", "set", "typesafe"], () => {}, () => {}, keyStdin("zen-secret\n"))).toBe(0);
    const status: string[] = [];
    expect(await main(["key", "status", "typesafe"], line => status.push(line), () => {}, keyStdin(""))).toBe(0);
    expect(status).toEqual(["source=keyring", "endpoint=https://opencode.ai/zen/v1/systemone"]);
    delete process.env.SYSTEMONE_ENDPOINT;
    expect(await main(["key", "status", "systemone"], () => {}, () => {}, keyStdin(""))).toBe(1);
  });

  it("refuses to store a key when the configured endpoint is invalid", async () => {
    const { main } = await import("../cli.js");
    process.env.SYSTEMONE_ENDPOINT = "http://evil.test/v1/systemone";
    const errors: string[] = [];
    expect(await main(["key", "set", "systemone"], () => {}, line => errors.push(line), keyStdin("never-stored\n"))).toBe(1);
    expect(errors.join("\n")).toContain("SYSTEMONE_ENDPOINT is set but invalid");
    expect(errors.join("\n")).not.toContain("never-stored");
  });

  it("explains that a legacy TypeSafe key is ignored on another endpoint", async () => {
    const { main } = await import("../cli.js");
    process.env.SYSTEMONE_ENDPOINT = "https://opencode.ai/zen/v1/systemone";
    process.env.TYPESAFE_API_KEY = "legacy-secret";
    const logs: string[] = [];
    expect(await main(["key", "remove", "systemone"], line => logs.push(line), () => {}, keyStdin(""))).toBe(0);
    expect(logs.join("\n")).toContain("ignored for https://opencode.ai/zen/v1/systemone");
    expect(logs.join("\n")).not.toContain("legacy-secret");
  });

  it("explains that OPENROUTER_API_KEY overrides a stored key on OpenRouter", async () => {
    const { main } = await import("../cli.js");
    process.env.SYSTEMONE_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
    process.env.OPENROUTER_API_KEY = "openrouter-secret";
    const logs: string[] = [];
    expect(await main(["key", "remove", "systemone"], line => logs.push(line), () => {}, keyStdin(""))).toBe(0);
    expect(logs.join("\n")).toContain("OPENROUTER_API_KEY is present and overrides");
    expect(logs.join("\n")).not.toContain("openrouter-secret");
  });

  it("rejects argv secrets and explains an environment override after removal", async () => {
    const { main } = await import("../cli.js");
    const errors: string[] = [];
    expect(await main(["key", "set", "systemone", "argv-secret"], () => {}, line => errors.push(line), keyStdin(""))).toBe(1);
    expect(errors.join("\n")).not.toContain("argv-secret");
    expect(errors.join("\n")).toContain("must not be passed");
    process.env.TYPESAFE_API_KEY = "environment-secret";
    const logs: string[] = [];
    expect(await main(["key", "remove", "systemone"], line => logs.push(line), () => {}, keyStdin(""))).toBe(0);
    expect(logs.join("\n")).toContain("TYPESAFE_API_KEY is present and overrides");
    expect(logs.join("\n")).not.toContain("environment-secret");
  });
});

describe("cli doctor", () => {
  const cliPath = resolve("cli.js");
  const fixtureUrl = pathToFileURL(resolve("__tests__/fixtures/tools-only-server.mjs")).href;
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  function setup(adapterConfig: unknown, projectConfig?: unknown) {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-doctor-home-"));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-doctor-project-")));
    const agentDir = join(home, ".pi", "agent");
    writeJson(join(agentDir, "mcp-adapter.json"), adapterConfig);
    if (projectConfig) writeJson(join(project, ".mcp.json"), projectConfig);
    return { home, project, agentDir };
  }

  function doctor(args: string[], { home, project, agentDir }: ReturnType<typeof setup>, env: NodeJS.ProcessEnv = {}) {
    const { PI_PACKAGE_DIR: _packageDir, ...inherited } = process.env;
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      execFile(process.execPath, [cliPath, "doctor", ...args], {
        cwd: project,
        env: { ...inherited, HOME: home, PI_CODING_AGENT_DIR: agentDir, ...env },
        timeout: 30_000,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") fail(error);
        else done({ code: error ? error.code as number : 0, stdout, stderr });
      });
    });
  }

  async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  }

  it.skipIf(process.platform === "win32")("checks Pi's own mcp.json only when Pi 0.99+ is on PATH", async () => {
    const url = await listen(() => {});
    await new Promise((done) => servers.pop()!.close(done));
    const context = setup({ mcpServers: {} });
    writeJson(join(context.agentDir, "mcp.json"), { mcpServers: { fromPi: { url } } });
    const fakePi = (version: string) => {
      const bin = mkdtempSync(join(tmpdir(), "pi-mcp-doctor-bin-"));
      writeFileSync(join(bin, "pi"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
      return { PATH: `${bin}:${process.env.PATH}` };
    };

    const current = await doctor([], context, fakePi("0.99.2"));
    expect(current.stdout).toContain("fromPi: failed");

    const old = await doctor([], context, fakePi("0.87.0"));
    expect(old.stdout).not.toContain("fromPi");
    expect(old.stderr).toContain("Pi's own mcp.json files were not checked");
  });

  it("exits 1 and explains a refused local server", async () => {
    const url = await listen(() => {});
    await new Promise((done) => servers.pop()!.close(done));

    const pathSecretUrl = url.replace("/mcp", "/${DOCTOR_PATH_SECRET}/mcp");
    const context = setup({ mcpServers: { local: { url, env: { DEBUG: "1" } }, pathSecret: { url: pathSecretUrl } } });
    const result = await doctor([], context, { DOCTOR_PATH_SECRET: "path-secret-value" });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("local: failed");
    expect(result.stdout).toContain(`Nothing is listening at ${url}`);
    expect(result.stdout).toContain(`Nothing is listening at ${pathSecretUrl}`);
    expect(result.stdout).not.toContain("path-secret-value");
  });

  it("reports OAuth servers without a sign-in and never starts an OAuth flow", async () => {
    const paths: string[] = [];
    const url = await listen((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", url)}"` });
      response.end();
    });

    const clientCredentials = { url, auth: "oauth", oauth: { grantType: "client_credentials", clientId: "doctor", clientSecret: "doctor-secret" } };
    const result = await doctor([], setup({ mcpServers: { explicit: { url, auth: "oauth" }, implicit: { url }, clientCredentials } }));

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("explicit: needs-auth — sign-in required: run /mcp-auth explicit in Pi");
    expect(result.stdout).toContain("clientCredentials: needs-auth");
    expect(result.stdout).toContain("implicit: needs-auth — sign-in required: run /mcp-auth implicit in Pi");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path === "/mcp")).toBe(true);
  });

  it("reports auth.provider servers as needing a Pi sign-in without connecting", async () => {
    let requests = 0;
    const url = await listen((_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    });

    const result = await doctor([], setup({ mcpServers: { provider: { url, auth: { provider: "github" } } } }));

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("provider: needs-auth — signs in with a Pi provider: run /login github in Pi");
    expect(requests).toBe(0);
  });

  it("treats a stored OAuth record without tokens as a missing sign-in", async () => {
    const paths: string[] = [];
    const url = await listen((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", url)}"` });
      response.end();
    });
    const context = setup({ settings: { oauthCredentialStore: "encrypted-file" }, mcpServers: { explicit: { url, auth: "oauth" } } });
    const env = { PI_MCP_ADAPTER_OAUTH_FILE_KEY: Buffer.alloc(32, 7).toString("base64") };
    const seeded = spawnSync(process.execPath, ["--input-type=module", "--eval", [
      `const { saveAuthEntry } = await import(${JSON.stringify(pathToFileURL(resolve("dist/mcp-auth.js")).href)});`,
      `saveAuthEntry("explicit", { clientInfo: { clientId: "doctor" } }, ${JSON.stringify(url)}, { credentialStore: "encrypted-file" });`,
    ].join("\n")], { env: { ...process.env, HOME: context.home, PI_CODING_AGENT_DIR: context.agentDir, ...env }, encoding: "utf-8" });
    expect(seeded.status, seeded.stderr).toBe(0);

    const result = await doctor([], context, env);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("explicit: needs-auth");
    expect(paths).toEqual([]);
  });

  it("never runs a server from an untrusted project or an unapproved project server", async () => {
    const marker = join(tmpdir(), `pi-mcp-doctor-ran-${process.pid}-${Date.now()}`);
    const projectServer = { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] };
    const context = setup({ mcpServers: {} }, { mcpServers: { project: projectServer } });

    const untrusted = await doctor([], context);
    expect(untrusted.code).toBe(0);
    expect(untrusted.stdout).toContain("project: blocked — blocked by project trust");

    writeJson(join(context.agentDir, "trust.json"), { [context.project]: true });
    const unapproved = await doctor([], context);
    expect(unapproved.code).toBe(0);
    expect(unapproved.stdout).toContain("project: blocked — blocked: project server approval required");

    expect(existsSync(marker)).toBe(false);
  });

  it("prints JSON without configured header, token, env, or URL query values", async () => {
    const url = await listen((request, response) => {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end(`rejected ${request.headers.authorization ?? request.headers["x-api-key"]} key=query-secret-value`);
    });
    const context = setup({
      mcpServers: {
        headers: { url: `${url}?key=query-secret-value`, headers: { "X-Api-Key": "Bearer header-secret-value" } },
        bearer: { url, auth: "bearer", bearerToken: "token-secret-value" },
        stdio: { command: process.execPath, args: ["-e", "console.error(process.env.CHILD_SECRET); process.exit(1)"], env: { CHILD_SECRET: "s3cr3t" }, debug: true },
        computed: { command: process.execPath, args: ["-e", "console.error('leaked-' + 6 * 7 + '-value'); process.exit(1)"] },
      },
    });

    const result = await doctor(["--json"], context);

    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as Array<{ name: string; state: string; tools: number | null; message: string | null }>;
    expect(report.map(({ name, state }) => [name, state])).toEqual([["headers", "failed"], ["bearer", "failed"], ["stdio", "failed"], ["computed", "failed"]]);
    for (const secret of ["header-secret-value", "token-secret-value", "s3cr3t", "query-secret-value", "leaked-42-value"]) {
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    }
  });

  it("reports tool counts and leaves no server process running after exit", async () => {
    const pidFile = join(tmpdir(), `pi-mcp-doctor-pid-${process.pid}-${Date.now()}`);
    const context = setup({
      mcpServers: {
        tools: { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); import(${JSON.stringify(fixtureUrl)})`] },
        off: { command: process.execPath, args: ["-e", "process.exit(1)"], disabled: true },
      },
    });

    const result = await doctor([], context);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("tools: ok, 1 tool");
    expect(result.stdout).toContain("off: disabled");
    const pid = Number(readFileSync(pidFile, "utf-8"));
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });
});
