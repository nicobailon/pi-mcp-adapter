import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEnv } from "./test-env.js";

const tempDirs: string[] = [];
const restoreEnv = captureEnv(["HOME", "MCP_OAUTH_DIR", "PI_CODING_AGENT_DIR"]);

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-adapter-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  restoreEnv();

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Pi agent dir paths", () => {
  it("stores Pi-owned MCP state under Pi's agent dir", async () => {
    const agentDir = createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const { getPiGlobalConfigPath } = await import("../config.js");
    const { getMetadataCachePath } = await import("../metadata-cache.js");
    const { getOnboardingStatePath } = await import("../onboarding-state.js");
    const { getTokensFilePath } = await import("../mcp-auth.js");

    expect(getPiGlobalConfigPath()).toBe(join(agentDir, "mcp.json"));
    expect(getMetadataCachePath()).toBe(join(agentDir, "mcp-cache.json"));
    expect(getOnboardingStatePath()).toBe(join(agentDir, "mcp-onboarding.json"));
    expect(getTokensFilePath("demo-server")).toBe(join(agentDir, "mcp-oauth", "demo-server", "tokens.json"));
  });

  it("uses MCP_OAUTH_DIR before the Pi agent dir for OAuth token storage", async () => {
    const agentDir = createTempDir();
    const oauthDir = createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.MCP_OAUTH_DIR = oauthDir;

    const { getTokensFilePath } = await import("../mcp-auth.js");

    expect(getTokensFilePath("demo-server")).toBe(join(oauthDir, "demo-server", "tokens.json"));
  });
});
