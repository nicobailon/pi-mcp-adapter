import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type AuthEntry,
  getAuthEntry,
  getTestAuthSecretStoreReadCount,
  inspectAuthForUrl,
  invalidateAuthEntryCache,
  removeAuthEntry,
  resetAuthEntryCache,
  resetTestAuthSecretStore,
  saveAuthEntry,
  updateTokens,
} from "../mcp-auth.ts";

const STORE_ENV = "PI_MCP_ADAPTER_TEST_AUTH_STORE";
const DISABLE_ENV = "PI_MCP_ADAPTER_DISABLE_AUTH_CACHE";
const RECOVERY_OVERRIDE_ENV = "PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY";
const DISABLE_KEYRING_RECOVERY_ENV = "PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY";
const SERVER_URL = "https://example.com/mcp";

function enableAuthEntryCache(): void {
  delete process.env[DISABLE_ENV];
}

function useAuthCacheHarness(): void {
  const originalEnv: Record<string, string | undefined> = {
    MCP_OAUTH_DIR: process.env.MCP_OAUTH_DIR,
    [STORE_ENV]: process.env[STORE_ENV],
    [DISABLE_ENV]: process.env[DISABLE_ENV],
    [DISABLE_KEYRING_RECOVERY_ENV]: process.env[DISABLE_KEYRING_RECOVERY_ENV],
  };
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-auth-cache-"));
    process.env.MCP_OAUTH_DIR = authDir;
    resetTestAuthSecretStore();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(authDir, { recursive: true, force: true });
  });
}

describe("OAuth credential-entry cache — foundation", () => {
  useAuthCacheHarness();

  it("disables the cache suite-wide by default", () => {
    expect(process.env[DISABLE_ENV]).toBe("1");
  });

  it("counts reads and resets independently for memory and size-limited stores", () => {
    for (const store of ["memory", "sizelimited"]) {
      process.env[STORE_ENV] = store;
      resetTestAuthSecretStore();

      expect(getAuthEntry("counted")).toBeUndefined();
      expect(getAuthEntry("counted")).toBeUndefined();
      expect(getTestAuthSecretStoreReadCount()).toBe(2);

      resetAuthEntryCache();
      expect(getTestAuthSecretStoreReadCount()).toBe(2);

      resetTestAuthSecretStore();
      expect(getTestAuthSecretStoreReadCount()).toBe(0);
    }
    process.env[STORE_ENV] = "memory";
  });

  it("counts throwing reads for unavailable and key-revoked stores", () => {
    const recoveryBefore = process.env[DISABLE_KEYRING_RECOVERY_ENV];
    process.env[DISABLE_KEYRING_RECOVERY_ENV] = "1";
    for (const store of ["unavailable", "keyrevoked"]) {
      process.env[STORE_ENV] = store;
      resetTestAuthSecretStore();

      expect(() => getAuthEntry("counted")).toThrow();
      expect(getTestAuthSecretStoreReadCount()).toBe(1);
    }
    if (recoveryBefore === undefined) delete process.env[DISABLE_KEYRING_RECOVERY_ENV];
    else process.env[DISABLE_KEYRING_RECOVERY_ENV] = recoveryBefore;
    process.env[STORE_ENV] = "memory";
  });

  it("opts in independently of Linux keyring recovery", () => {
    const recoveryBefore = process.env[RECOVERY_OVERRIDE_ENV];
    enableAuthEntryCache();
    expect(process.env[DISABLE_ENV]).toBeUndefined();
    expect(process.env[RECOVERY_OVERRIDE_ENV]).toBe(recoveryBefore);
  });


  it("restores the suite-wide disable after an opt-in test", () => {
    expect(process.env[DISABLE_ENV]).toBe("1");
  });
});

describe("OAuth credential-entry cache — coherence", () => {
  useAuthCacheHarness();

  it("caches present and absent reads", () => {
    saveAuthEntry("present", { tokens: { accessToken: "a" } }, SERVER_URL);
    enableAuthEntryCache();
    resetAuthEntryCache();
    const before = getTestAuthSecretStoreReadCount();
    expect(getAuthEntry("present")?.tokens?.accessToken).toBe("a");
    expect(getAuthEntry("present")?.tokens?.accessToken).toBe("a");
    expect(getTestAuthSecretStoreReadCount() - before).toBe(1);

    const absentBefore = getTestAuthSecretStoreReadCount();
    expect(getAuthEntry("absent")).toBeUndefined();
    expect(getAuthEntry("absent")).toBeUndefined();
    expect(getTestAuthSecretStoreReadCount() - absentBefore).toBe(1);
  });

  it("publishes writes, updates, and evicts removals", () => {
    enableAuthEntryCache();
    saveAuthEntry("entry", { tokens: { accessToken: "old" } }, SERVER_URL);
    const before = getTestAuthSecretStoreReadCount();
    expect(getAuthEntry("entry")?.tokens?.accessToken).toBe("old");
    expect(getTestAuthSecretStoreReadCount() - before).toBe(0);
    updateTokens("entry", { accessToken: "new" }, SERVER_URL);
    expect(getAuthEntry("entry")?.tokens?.accessToken).toBe("new");
    removeAuthEntry("entry");
    const beforeAbsentRead = getTestAuthSecretStoreReadCount();
    expect(getAuthEntry("entry")).toBeUndefined();
    expect(getTestAuthSecretStoreReadCount() - beforeAbsentRead).toBeGreaterThan(0);
  });

  it("isolates nested mutations and bypasses status inspection", () => {
    saveAuthEntry("aliased", {
      tokens: { accessToken: "a" },
      clientInfo: { clientId: "c", redirectUris: ["https://a.example"] },
    }, SERVER_URL);
    enableAuthEntryCache();
    resetAuthEntryCache();
    const entry = getAuthEntry("aliased")!;
    entry.tokens!.issuer = "https://evil.example";
    entry.clientInfo!.redirectUris!.push("https://evil.example");
    const onHit = getAuthEntry("aliased")!;
    expect(onHit.tokens?.issuer).toBeUndefined();
    expect(onHit.clientInfo?.redirectUris).toEqual(["https://a.example"]);
    onHit.tokens!.issuer = "https://also-evil.example";
    expect(getAuthEntry("aliased")?.tokens?.issuer).toBeUndefined();

    resetAuthEntryCache();
    const before = getTestAuthSecretStoreReadCount();
    inspectAuthForUrl("aliased", SERVER_URL);
    inspectAuthForUrl("aliased", SERVER_URL);
    expect(getTestAuthSecretStoreReadCount() - before).toBe(2);

    const beforeOrdinaryRead = getTestAuthSecretStoreReadCount();
    expect(getAuthEntry("aliased")).toBeDefined();
    expect(getTestAuthSecretStoreReadCount() - beforeOrdinaryRead).toBe(1);
  });


  it("keeps inspection uncached after an ordinary read warms the cache", () => {
    saveAuthEntry("inspected", { tokens: { accessToken: "a" } }, SERVER_URL);
    enableAuthEntryCache();
    resetAuthEntryCache();

    expect(getAuthEntry("inspected")).toBeDefined();
    const before = getTestAuthSecretStoreReadCount();

    expect(inspectAuthForUrl("inspected", SERVER_URL).status).toBe("present");
    expect(getTestAuthSecretStoreReadCount() - before).toBe(1);
  });

  it("does not cache store failures and reconstructs chunked entries once", () => {
    enableAuthEntryCache();
    process.env[STORE_ENV] = "unavailable";
    expect(() => getAuthEntry("failing")).toThrow(/OS secure credential store/);
    expect(() => getAuthEntry("failing")).toThrow(/OS secure credential store/);
    process.env[STORE_ENV] = "memory";
    expect(getAuthEntry("failing")).toBeUndefined();

    saveAuthEntry("chunked", { tokens: { accessToken: "x".repeat(5000) } }, SERVER_URL);
    resetAuthEntryCache();
    getAuthEntry("chunked");
    const afterFirst = getTestAuthSecretStoreReadCount();
    expect(getAuthEntry("chunked")?.tokens?.accessToken).toHaveLength(5000);
    expect(getTestAuthSecretStoreReadCount()).toBe(afterFirst);
  });


  it("leaves every read going to the store when the gate is off", () => {
    saveAuthEntry("gated", { tokens: { accessToken: "a" } }, SERVER_URL);
    const before = getTestAuthSecretStoreReadCount();

    expect(getAuthEntry("gated")).toBeDefined();
    expect(getAuthEntry("gated")).toBeDefined();

    expect(getTestAuthSecretStoreReadCount() - before).toBe(2);
  });

  it("normalizes publication exactly as a later store reload does", () => {
    enableAuthEntryCache();
    saveAuthEntry("normalized", {
      tokens: { accessToken: "a", unexpected: "discard" },
      unexpected: true,
    } as unknown as AuthEntry, SERVER_URL);

    const onHit = getAuthEntry("normalized");
    resetAuthEntryCache();
    const onMiss = getAuthEntry("normalized");

    expect(onHit).toEqual({ tokens: { accessToken: "a" }, serverUrl: SERVER_URL });
    expect(onMiss).toEqual(onHit);
  });
});

describe("OAuth credential-entry cache — invalidation", () => {
  useAuthCacheHarness();

  function writeBehindTheCache(serverName: string, accessToken: string): void {
    process.env[DISABLE_ENV] = "1";
    saveAuthEntry(serverName, { tokens: { accessToken } }, SERVER_URL);
    delete process.env[DISABLE_ENV];
  }

  it("reloads externally changed, absent, and chunked credentials", () => {
    enableAuthEntryCache();
    saveAuthEntry("rotated", { tokens: { accessToken: "old" } }, SERVER_URL);
    writeBehindTheCache("rotated", "new");
    expect(getAuthEntry("rotated")?.tokens?.accessToken).toBe("old");
    invalidateAuthEntryCache("rotated");
    expect(getAuthEntry("rotated")?.tokens?.accessToken).toBe("new");

    expect(getAuthEntry("appearing")).toBeUndefined();
    writeBehindTheCache("appearing", "created");
    expect(getAuthEntry("appearing")).toBeUndefined();
    invalidateAuthEntryCache("appearing");
    expect(getAuthEntry("appearing")?.tokens?.accessToken).toBe("created");

    const token = "x".repeat(5000);
    saveAuthEntry("chunked", { tokens: { accessToken: token } }, SERVER_URL);
    invalidateAuthEntryCache("chunked");
    const before = getTestAuthSecretStoreReadCount();
    expect(getAuthEntry("chunked")?.tokens?.accessToken).toBe(token);
    expect(getTestAuthSecretStoreReadCount() - before).toBeGreaterThan(1);
  });

  it("only evicts its target and is harmless while disabled", () => {
    enableAuthEntryCache();
    saveAuthEntry("keep", { tokens: { accessToken: "k" } }, SERVER_URL);
    saveAuthEntry("drop", { tokens: { accessToken: "d" } }, SERVER_URL);
    invalidateAuthEntryCache("drop");
    const before = getTestAuthSecretStoreReadCount();
    expect(getAuthEntry("keep")?.tokens?.accessToken).toBe("k");
    expect(getTestAuthSecretStoreReadCount() - before).toBe(0);

    process.env[DISABLE_ENV] = "1";
    expect(() => invalidateAuthEntryCache("keep")).not.toThrow();
    const beforeDisabledRead = getTestAuthSecretStoreReadCount();
    expect(getAuthEntry("keep")?.tokens?.accessToken).toBe("k");
    expect(getTestAuthSecretStoreReadCount() - beforeDisabledRead).toBe(1);
  });


  it("evicts a removed credential even when the gate is turned off", () => {
    enableAuthEntryCache();
    saveAuthEntry("toggled", { tokens: { accessToken: "t" } }, SERVER_URL);
    expect(getAuthEntry("toggled")).toBeDefined();

    process.env[DISABLE_ENV] = "1";
    removeAuthEntry("toggled");
    delete process.env[DISABLE_ENV];

    expect(getAuthEntry("toggled")).toBeUndefined();
  });
});
