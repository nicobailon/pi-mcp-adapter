import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

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

    const piConfigPath = join(home, ".pi", "agent", "mcp.json");
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
    expect(logs.join("\n")).toContain("Detected host configs to import into Pi: codex");
    expect(existsSync(join(home, ".pi", "agent", "mcp.json"))).toBe(false);
  });

  it("loads existing Pi config as JSONC and lists .agents standard paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-jsonc-home-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-jsonc-project-"));
    process.env.HOME = home;
    process.chdir(project);

    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "mcp.json"), `{
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
    expect(output).toContain("No Pi config changes needed.");
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
    const piConfigPath = join(home, ".pi", "agent", "mcp.json");
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

    const piConfigPath = join(agentDir, "mcp.json");
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
    expect(logs.join("\n")).toContain(`Pi global override: ${join(agentDir, "mcp.json")}`);
    expect(logs.join("\n")).toContain(`Project Pi override: ${join(process.cwd(), ".arc", "mcp.json")}`);
    expect(logs.join("\n")).toContain(`Dry run: would update ${join(agentDir, "mcp.json")}`);
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
    expect(result.stdout).toContain("No Pi config changes needed.");
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
