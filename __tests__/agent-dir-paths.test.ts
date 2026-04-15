import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mockedAgentDir = "";
const tempDirs: string[] = [];

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getAgentDir: () => mockedAgentDir,
}), { virtual: true });

function createTempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-adapter-agent-dir-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  mockedAgentDir = "";
  vi.resetModules();

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Pi agent dir paths", () => {
  it("loads the default MCP config from Pi's agent dir", async () => {
    const agentDir = createTempAgentDir();
    mockedAgentDir = agentDir;

    const configPath = join(agentDir, "mcp.json");
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        demo: {
          command: "npx",
          args: ["-y", "demo-server"],
        },
      },
    }), "utf-8");

    const { getDefaultConfigPath, loadMcpConfig } = await import("../config.js");

    expect(getDefaultConfigPath()).toBe(configPath);
    expect(loadMcpConfig()).toEqual({
      mcpServers: {
        demo: {
          command: "npx",
          args: ["-y", "demo-server"],
        },
      },
    });
  });

  it("stores metadata cache in Pi's agent dir", async () => {
    const agentDir = createTempAgentDir();
    mockedAgentDir = agentDir;

    const { getMetadataCachePath, loadMetadataCache, saveMetadataCache } = await import("../metadata-cache.js");
    const cache = {
      version: 1,
      servers: {
        demo: {
          configHash: "hash",
          cachedAt: 123,
          tools: [],
          resources: [],
        },
      },
    };

    saveMetadataCache(cache);

    expect(getMetadataCachePath()).toBe(join(agentDir, "mcp-cache.json"));
    expect(loadMetadataCache()).toEqual(cache);
  });

  it("reads OAuth tokens from Pi's agent dir", async () => {
    const agentDir = createTempAgentDir();
    mockedAgentDir = agentDir;

    const serverName = "demo-server";
    const tokenDir = join(agentDir, "mcp-oauth", serverName);
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(tokenDir, "tokens.json"), JSON.stringify({
      access_token: "secret-token",
      token_type: "bearer",
      expiresAt: Date.now() + 60_000,
    }), "utf-8");

    const { getStoredTokens } = await import("../oauth-handler.js");

    expect(getStoredTokens(serverName)).toEqual({
      access_token: "secret-token",
      token_type: "bearer",
      refresh_token: undefined,
      expires_in: undefined,
    });
  });

  it("derives the npx cache path from Pi's agent dir", async () => {
    const agentDir = createTempAgentDir();
    mockedAgentDir = agentDir;

    const { getNpxCachePath } = await import("../npx-resolver.js");

    expect(getNpxCachePath()).toBe(join(agentDir, "mcp-npx-cache.json"));
  });
});
