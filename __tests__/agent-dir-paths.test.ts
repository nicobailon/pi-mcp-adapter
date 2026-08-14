import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Pi agent dir paths", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  const originalPackageDir = process.env.PI_PACKAGE_DIR;
  const originalArcAgentDir = process.env.ARC_CODING_AGENT_DIR;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.PI_PACKAGE_DIR;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
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
  });

  it("uses PI_CODING_AGENT_DIR for Pi-owned config and state files", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-"));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.MCP_OAUTH_DIR;

    const { getAgentDir } = await import("../agent-dir.ts");
    const { getPiGlobalConfigPath } = await import("../config.ts");
    const { getMetadataCachePath } = await import("../metadata-cache.ts");
    const { getOnboardingStatePath } = await import("../onboarding-state.ts");
    const { getAuthEntryFilePath, saveAuthEntry } = await import("../mcp-auth.ts");

    expect(getAgentDir()).toBe(agentDir);
    expect(getPiGlobalConfigPath()).toBe(join(agentDir, "mcp.json"));
    expect(getMetadataCachePath()).toBe(join(agentDir, "mcp-cache.json"));
    expect(getOnboardingStatePath()).toBe(join(agentDir, "mcp-onboarding.json"));

    saveAuthEntry("demo", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
    expect(existsSync(getAuthEntryFilePath("demo"))).toBe(false);
    expect(getAuthEntryFilePath("demo").startsWith(join(agentDir, "mcp-oauth"))).toBe(true);
    expect(existsSync(join(agentDir, "mcp-oauth", "demo", "tokens.json"))).toBe(false);
    expect(existsSync(join(home, ".pi", "agent", "mcp-oauth", "demo", "tokens.json"))).toBe(false);
  });

  it("expands tilde in PI_CODING_AGENT_DIR", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-home-"));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = "~/custom-pi-agent";

    const { getAgentDir } = await import("../agent-dir.ts");

    expect(getAgentDir()).toBe(join(home, "custom-pi-agent"));
  });

  it("uses the branded host environment key and config directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-home-"));
    const packageDir = mkdtempSync(join(tmpdir(), "pi-mcp-package-dir-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-"));
    process.env.HOME = home;
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ piConfig: { name: "arc", configDir: ".arc" } }));
    process.env.PI_PACKAGE_DIR = packageDir;

    const { getAgentDir } = await import("../agent-dir.ts");

    expect(getAgentDir()).toBe(join(home, ".arc", "agent"));

    process.env.ARC_CODING_AGENT_DIR = agentDir;
    expect(getAgentDir()).toBe(agentDir);

    process.env.ARC_CODING_AGENT_DIR = "~/custom-agent";
    expect(getAgentDir()).toBe(join(home, "custom-agent"));

    process.env.ARC_CODING_AGENT_DIR = "relative-agent";
    expect(getAgentDir()).toBe(join(process.cwd(), "relative-agent"));
  });

  it("keeps MCP_OAUTH_DIR as the explicit OAuth storage override", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-"));
    const oauthDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-dir-"));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.MCP_OAUTH_DIR = oauthDir;

    const { getAuthEntryFilePath, saveAuthEntry } = await import("../mcp-auth.ts");

    saveAuthEntry("demo", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
    expect(existsSync(getAuthEntryFilePath("demo"))).toBe(false);
    expect(getAuthEntryFilePath("demo").startsWith(oauthDir)).toBe(true);
    expect(existsSync(join(oauthDir, "demo", "tokens.json"))).toBe(false);
    expect(existsSync(join(agentDir, "mcp-oauth", "demo", "tokens.json"))).toBe(false);
  });
});
