import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("cli init helper", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
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
