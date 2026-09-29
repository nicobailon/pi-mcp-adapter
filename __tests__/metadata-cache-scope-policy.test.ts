import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServerManager } from "../server-manager.ts";
import { computeServerHash, isServerCacheValid, loadMetadataCache, saveMetadataCache } from "../metadata-cache.ts";
import { updateMetadataCache } from "../init.ts";
import type { ServerCacheEntry, ServerEntry } from "../types.ts";

const BASE_TIME = 1_700_000_000_000;

function definition(): ServerEntry {
  return { command: "node", args: ["server.js"] };
}

describe("metadata cache scope policy", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-cache-scope-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("never reuses private metadata from the persistent cache", () => {
    const server = definition();
    const cached: ServerCacheEntry = {
      configHash: computeServerHash(server),
      tools: [{ name: "search" }],
      resources: [],
      ttlMs: 5_000,
      cacheScope: "private",
      cachedAt: Date.now(),
    };

    expect(isServerCacheValid(cached, server)).toBe(false);
  });

  it("captures cache hints from prompts and resources", async () => {
    const manager = new McpServerManager();
    const promptResult = await (manager as any).fetchAllPrompts({
      getServerCapabilities: () => ({ prompts: {} }),
      listPrompts: vi.fn().mockResolvedValue({
        prompts: [{ name: "brief" }],
        ttlMs: 2_000,
        cacheScope: "private",
      }),
    });
    const resourceResult = await (manager as any).fetchAllResources({
      getServerCapabilities: () => ({ resources: {} }),
      listResources: vi.fn().mockResolvedValue({
        resources: [{ name: "guide", uri: "file://guide" }],
        ttlMs: 3_000,
        cacheScope: "public",
      }),
    });

    expect(promptResult).toEqual({
      prompts: [{ name: "brief" }],
      failed: false,
      hints: { ttlMs: 2_000, cacheScope: "private" },
    });
    expect(resourceResult).toEqual({
      resources: [{ name: "guide", uri: "file://guide" }],
      failed: false,
      hints: { ttlMs: 3_000, cacheScope: "public" },
    });
  });

  it("uses the strictest modern catalog policy for the bundled disk entry", () => {
    const server = definition();
    const connection = {
      status: "connected",
      definition: server,
      client: {
        getProtocolEra: () => "modern",
        getServerCapabilities: () => ({ tools: {}, prompts: {}, resources: {} }),
        getDiscoverResult: () => ({ ttlMs: 10_000, cacheScope: "public" }),
      },
      tools: [{ name: "search" }],
      resources: [{ name: "guide", uri: "file://guide" }],
      prompts: [{ name: "brief" }],
      resourceDiscoveryFailed: false,
      promptDiscoveryFailed: false,
      toolListHints: { ttlMs: 5_000, cacheScope: "public" },
      promptListHints: { ttlMs: 2_000, cacheScope: "public" },
      resourceListHints: { ttlMs: 3_000, cacheScope: "public" },
    };
    const state = {
      config: { mcpServers: { demo: server } },
      manager: { getConnection: () => connection },
      sessionMetadata: new Map<string, ServerCacheEntry>(),
    };

    updateMetadataCache(state as any, "demo");

    const publicEntry = loadMetadataCache()?.servers.demo;
    expect(publicEntry).toMatchObject({ ttlMs: 2_000, cacheScope: "public" });
    expect(publicEntry && isServerCacheValid(publicEntry, server)).toBe(true);

    const otherServer = { command: "node", args: ["other.js"] };
    saveMetadataCache({
      version: 1,
      servers: {
        other: {
          configHash: computeServerHash(otherServer),
          tools: [{ name: "other_tool" }],
          resources: [],
          cachedAt: Date.now(),
        },
      },
    });

    connection.promptListHints = { ttlMs: 2_000, cacheScope: "private" };
    updateMetadataCache(state as any, "demo");

    const persisted = loadMetadataCache();
    expect(persisted?.servers.demo).toBeUndefined();
    expect(persisted?.servers.other).toMatchObject({ tools: [{ name: "other_tool" }] });
    expect(state.sessionMetadata.get("demo")).toMatchObject({
      tools: [{ name: "search" }],
      resources: [{ name: "guide", uri: "file://guide" }],
      prompts: [{ name: "brief" }],
      ttlMs: 0,
      cacheScope: "private",
    });
  });

  it("includes modern server/discover policy in the bundled metadata policy", () => {
    const server = definition();
    const connection = {
      status: "connected",
      definition: server,
      client: {
        getProtocolEra: () => "modern",
        getServerCapabilities: () => ({ tools: {} }),
        getDiscoverResult: () => ({ ttlMs: 10_000, cacheScope: "private" }),
      },
      tools: [{ name: "search" }],
      resources: [],
      prompts: [],
      toolListHints: { ttlMs: 10_000, cacheScope: "public" },
    };
    const state = {
      config: { mcpServers: { demo: server } },
      manager: { getConnection: () => connection },
      sessionMetadata: new Map<string, ServerCacheEntry>(),
    };

    updateMetadataCache(state as any, "demo");

    expect(state.sessionMetadata.get("demo")).toMatchObject({
      tools: [{ name: "search" }],
      ttlMs: 0,
      cacheScope: "private",
    });
    expect(loadMetadataCache()?.servers.demo).toBeUndefined();
  });
});
