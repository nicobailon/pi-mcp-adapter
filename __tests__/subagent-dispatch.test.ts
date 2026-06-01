import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function mkdirp(path: string): void {
  mkdirSync(path, { recursive: true });
}

describe("subagent-dispatch agent resolution", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  });

  it("resolves a configured local pi-subagents package source", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-subagent-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-subagent-agent-dir-"));
    const packageDir = mkdtempSync(join(tmpdir(), "pi-subagents-source-"));
    const packageAgent = join(packageDir, "agents", "delegate.md");
    mkdirp(join(packageDir, "agents"));
    writeFileSync(packageAgent, "---\nname: delegate\n---\nconfigured package delegate\n");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const { resolveAgentFile } = await import("../subagent-dispatch.ts");

    expect(resolveAgentFile("delegate")).toBe(packageAgent);
  });

  it("resolves the active Pi npm package location for npm:pi-subagents", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-subagent-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-subagent-agent-dir-"));
    const packageAgent = join(agentDir, "npm", "node_modules", "pi-subagents", "agents", "delegate.md");
    mkdirp(join(agentDir, "npm", "node_modules", "pi-subagents", "agents"));
    writeFileSync(packageAgent, "---\nname: delegate\n---\nactive npm delegate\n");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-subagents"] }));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const { resolveAgentFile } = await import("../subagent-dispatch.ts");

    expect(resolveAgentFile("delegate")).toBe(packageAgent);
  });

  it("does not resolve arbitrary repo-local project agents from cwd", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-subagent-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-subagent-agent-dir-"));
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-subagent-project-"));
    const projectAgent = join(project, ".pi", "agents", "delegate.md");
    mkdirp(join(project, ".pi", "agents"));
    writeFileSync(projectAgent, "---\nname: delegate\n---\nuntrusted project delegate\n");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(project);

    const { resolveAgentFile } = await import("../subagent-dispatch.ts");

    expect(resolveAgentFile("delegate")).toBe(null);
  });

  it("prefers user-scope agent prompts over package prompts", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-subagent-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-subagent-agent-dir-"));
    const userAgent = join(agentDir, "agents", "delegate.md");
    const packageDir = mkdtempSync(join(tmpdir(), "pi-subagents-source-"));
    const packageAgent = join(packageDir, "agents", "delegate.md");
    mkdirp(join(agentDir, "agents"));
    mkdirp(join(packageDir, "agents"));
    writeFileSync(userAgent, "---\nname: delegate\n---\nuser delegate\n");
    writeFileSync(packageAgent, "---\nname: delegate\n---\npackage delegate\n");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const { resolveAgentFile } = await import("../subagent-dispatch.ts");

    expect(resolveAgentFile("delegate")).toBe(userAgent);
  });
});
