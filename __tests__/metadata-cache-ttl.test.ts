import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServerManager } from "../server-manager.ts";
import { computeServerHash, isServerCacheValid, loadMetadataCache } from "../metadata-cache.ts";
import { updateMetadataCache } from "../init.ts";
import type { ServerCacheEntry, ServerEntry } from "../types.ts";

const BASE_TIME = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function definition(): ServerEntry {
  return { command: "node", args: ["server.js"] };
}

function entry(server: ServerEntry, ageMs: number, ttlMs?: number): ServerCacheEntry {
  return {
    configHash: computeServerHash(server),
    tools: [{ name: "search" }],
    resources: [],
    ...(ttlMs === undefined ? {} : { ttlMs }),
    cachedAt: Date.now() - ageMs,
  };
}

describe("metadata cache ttl hints", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-cache-ttl-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("expires at the declared ttl, including ttlMs zero", () => {
    const server = definition();

    expect(isServerCacheValid(entry(server, 0, 0), server)).toBe(false);
    expect(isServerCacheValid(entry(server, -1, 0), server)).toBe(false);
    expect(isServerCacheValid(entry(server, 500, 1_000), server)).toBe(true);
    expect(isServerCacheValid(entry(server, 1_000, 1_000), server)).toBe(false);
  });

  it("never lets a declared ttl extend the default max age", () => {
    const server = definition();

    expect(isServerCacheValid(entry(server, 8 * DAY_MS, 14 * DAY_MS), server)).toBe(false);
    expect(isServerCacheValid(entry(server, 6 * DAY_MS, 14 * DAY_MS), server)).toBe(true);
  });

  it("keeps list hints at the result and cache-entry levels, not on tools", async () => {
    const manager = new McpServerManager();
    const result = await (manager as any).fetchAllTools({
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: "search" }],
        ttlMs: 5_000,
        cacheScope: "private",
      }),
    });

    expect(result).toEqual({
      tools: [{ name: "search" }],
      hints: { ttlMs: 5_000, cacheScope: "private" },
    });
    expect(result.tools[0]).not.toHaveProperty("ttlMs");
    expect(result.tools[0]).not.toHaveProperty("cacheScope");

    updateMetadataCache({
      config: { mcpServers: { demo: definition() } },
      manager: {
        getConnection: () => ({
          status: "connected",
          tools: result.tools,
          resources: [],
          prompts: [],
          toolListHints: result.hints,
        }),
      },
    } as any, "demo");

    const cached = loadMetadataCache()?.servers.demo;
    expect(cached).toMatchObject({ ttlMs: 5_000, cacheScope: "private" });
    expect(cached?.tools[0]).toEqual({ name: "search" });
  });
});
