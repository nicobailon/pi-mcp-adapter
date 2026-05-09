import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("oauth-handler path resolution", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;

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
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
  });

  it("reads tokens from PI_CODING_AGENT_DIR when MCP_OAUTH_DIR is unset", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-handler-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-handler-agent-"));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.MCP_OAUTH_DIR;

    const tokensPath = join(agentDir, "mcp-oauth", "demo", "tokens.json");
    mkdirSync(join(agentDir, "mcp-oauth", "demo"), { recursive: true });
    writeFileSync(tokensPath, JSON.stringify({ access_token: "abc", token_type: "bearer" }), "utf-8");

    const { getStoredTokens } = await import("../oauth-handler.ts");
    expect(getStoredTokens("demo")).toEqual({
      access_token: "abc",
      token_type: "bearer",
      refresh_token: undefined,
      expires_in: undefined,
    });
  });

  it("prefers MCP_OAUTH_DIR over PI_CODING_AGENT_DIR", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-handler-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-handler-agent-"));
    const oauthDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-handler-oauth-"));
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.MCP_OAUTH_DIR = oauthDir;

    mkdirSync(join(agentDir, "mcp-oauth", "demo"), { recursive: true });
    writeFileSync(
      join(agentDir, "mcp-oauth", "demo", "tokens.json"),
      JSON.stringify({ access_token: "from-agent" }),
      "utf-8",
    );

    mkdirSync(join(oauthDir, "demo"), { recursive: true });
    writeFileSync(
      join(oauthDir, "demo", "tokens.json"),
      JSON.stringify({ access_token: "from-override", token_type: "bearer" }),
      "utf-8",
    );

    const { getStoredTokens } = await import("../oauth-handler.ts");
    expect(getStoredTokens("demo")?.access_token).toBe("from-override");
  });
});
