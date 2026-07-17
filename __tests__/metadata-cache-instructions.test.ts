import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMetadataCache, saveMetadataCache, type ServerCacheEntry } from "../metadata-cache.ts";

describe("metadata cache instructions", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-cache-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips server instructions through the cache file", () => {
    const entry: ServerCacheEntry = {
      configHash: "hash",
      tools: [],
      resources: [],
      instructions: "The available skills are listed in this server's instructions.",
      cachedAt: Date.now(),
    };

    saveMetadataCache({ version: 1, servers: { demo: entry } });

    expect(loadMetadataCache()?.servers.demo.instructions).toBe(
      "The available skills are listed in this server's instructions.",
    );
  });

  it("omits instructions from the cache file when a server provides none", () => {
    const entry: ServerCacheEntry = {
      configHash: "hash",
      tools: [],
      resources: [],
      instructions: undefined,
      cachedAt: Date.now(),
    };

    saveMetadataCache({ version: 1, servers: { demo: entry } });

    expect("instructions" in (loadMetadataCache()?.servers.demo ?? {})).toBe(false);
  });
});
