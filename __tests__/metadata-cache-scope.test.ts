// Verifies that persistent metadata honors MCP 2026 cache scope and expiry.
import { describe, expect, it } from "vitest";
import { computeServerHash, isServerCacheValid } from "../metadata-cache.ts";
import type { ServerCacheEntry, ServerEntry } from "../types.ts";

const definition: ServerEntry = { command: "node", args: ["server.js"] };

function entry(overrides: Partial<ServerCacheEntry> = {}): ServerCacheEntry {
  return {
    configHash: computeServerHash(definition),
    tools: [],
    resources: [],
    cachedAt: Date.now(),
    ...overrides,
  };
}

describe("modern metadata cache policy", () => {
  it("invalidates metadata when protocol mode changes", () => {
    expect(computeServerHash({ ...definition, protocolMode: "legacy" })).not.toBe(
      computeServerHash({ ...definition, protocolMode: "2026-07-28" }),
    );
  });

  it("never reuses private modern metadata", () => {
    expect(isServerCacheValid(entry({
      protocolEra: "modern",
      cacheScope: "private",
    }), definition)).toBe(false);
  });

  it("reuses public modern metadata only before its server expiry", () => {
    expect(isServerCacheValid(entry({
      protocolEra: "modern",
      cacheScope: "public",
      expiresAt: Date.now() + 60_000,
    }), definition)).toBe(true);
    expect(isServerCacheValid(entry({
      protocolEra: "modern",
      cacheScope: "public",
      expiresAt: Date.now() - 1,
    }), definition)).toBe(false);
  });
});
