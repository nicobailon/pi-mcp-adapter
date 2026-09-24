import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAuthEntry, inspectAuthForUrl, OAuthCredentialStoreError, removeAuthEntry,
  resetTestAuthSecretStore, saveAuthEntry, setTestKeyringEntryClass,
} from "../mcp-auth.ts";

const url = "https://example.com/mcp";
const payload = (token: string) => JSON.stringify({ tokens: { accessToken: token }, serverUrl: url });

describe("OAuth native keyring Entry reuse", () => {
  const backing = new Map<string, string>();
  const constructed: FakeEntry[] = [];
  let freshReadError: Error | undefined;
  let freshFailureAfter = Infinity;
  let dir: string;
  const original = {
    store: process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE,
    cache: process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE,
    agentDir: process.env.PI_CODING_AGENT_DIR,
  };

  class FakeEntry {
    failRead = false;
    constructor(readonly service: string, readonly account: string) {
      constructed.push(this);
    }
    getPassword(): string | null {
      if (freshReadError && constructed.indexOf(this) >= freshFailureAfter) throw freshReadError;
      if (this.failRead) throw new Error("stale entry");
      return backing.get(this.account) ?? null;
    }
    setPassword(value: string): void { backing.set(this.account, value); }
    deleteCredential(): boolean { return backing.delete(this.account); }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-entry-"));
    delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE = "1";
    process.env.PI_CODING_AGENT_DIR = dir;
    backing.clear();
    constructed.length = 0;
    freshReadError = undefined;
    freshFailureAfter = Infinity;
    resetTestAuthSecretStore();
    setTestKeyringEntryClass(FakeEntry);
  });

  afterEach(() => {
    setTestKeyringEntryClass(undefined);
    resetTestAuthSecretStore();
    if (original.store === undefined) delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    else process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = original.store;
    if (original.cache === undefined) delete process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE;
    else process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE = original.cache;
    if (original.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original.agentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses a healthy Entry while re-reading externally changed backing values, including status reads", () => {
    saveAuthEntry("one", { tokens: { accessToken: "first" } }, url);
    const entry = constructed.at(-1)!;
    expect(entry.service).toBe("pi-mcp-adapter.oauth");
    const count = constructed.length;
    expect(getAuthEntry("one")?.tokens?.accessToken).toBe("first");
    backing.set(entry.account, payload("external"));
    expect(getAuthEntry("one")?.tokens?.accessToken).toBe("external");
    expect(inspectAuthForUrl("one", url)).toMatchObject({ status: "present", entry: { tokens: { accessToken: "external" } } });
    expect(constructed).toHaveLength(count);
  });

  it("retries one stale cached read with a fresh Entry", () => {
    saveAuthEntry("one", { tokens: { accessToken: "first" } }, url);
    const stale = constructed.at(-1)!;
    backing.set(stale.account, payload("new"));
    stale.failRead = true;
    const count = constructed.length;
    expect(getAuthEntry("one")?.tokens?.accessToken).toBe("new");
    expect(constructed).toHaveLength(count + 1);
    expect(getAuthEntry("one")?.tokens?.accessToken).toBe("new");
    expect(constructed).toHaveLength(count + 1);
  });

  it("reports a fresh retry failure with the original auth error cause", () => {
    saveAuthEntry("one", { tokens: { accessToken: "first" } }, url);
    freshFailureAfter = constructed.length;
    freshReadError = new Error("fresh failure");
    // The stale instance must throw a different error from its replacement.
    const stale = constructed.at(-1)!;
    stale.failRead = true;
    let error: unknown;
    try { getAuthEntry("one"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(OAuthCredentialStoreError);
    expect((error as OAuthCredentialStoreError).cause).toBe(freshReadError);
    expect(constructed).toHaveLength(freshFailureAfter + 1);
    expect(inspectAuthForUrl("one", url).status).toBe("unavailable");
  });

  it("reuses a healthy missing Entry and observes a later external write", () => {
    expect(getAuthEntry("missing")).toBeUndefined();
    expect(constructed).toHaveLength(1);
    expect(getAuthEntry("missing")).toBeUndefined();
    expect(constructed).toHaveLength(1);
    const account = constructed.at(-1)!.account;
    backing.set(account, payload("external"));
    expect(getAuthEntry("missing")?.tokens?.accessToken).toBe("external");
    expect(constructed).toHaveLength(1);
  });

  it("invalidates on writes and removes, without retaining the remove Entry", () => {
    saveAuthEntry("one", { tokens: { accessToken: "first" } }, url);
    const first = constructed.at(-1)!;
    saveAuthEntry("one", { tokens: { accessToken: "second" } }, url);
    const second = constructed.at(-1)!;
    expect(second).not.toBe(first);
    const beforeRemove = constructed.length;
    removeAuthEntry("one");
    expect(constructed.length).toBeGreaterThan(beforeRemove);
    const afterRemove = constructed.length;
    expect(getAuthEntry("one")).toBeUndefined();
    expect(constructed.length).toBe(afterRemove + 1);
  });

  it("separates accounts and clears native Entries on test reset", () => {
    saveAuthEntry("one", { tokens: { accessToken: "one" } }, url);
    saveAuthEntry("two", { tokens: { accessToken: "two" } }, url);
    expect(constructed[0]!.account).not.toBe(constructed.at(-1)!.account);
    const count = constructed.length;
    getAuthEntry("one");
    getAuthEntry("two");
    expect(constructed).toHaveLength(count);
    resetTestAuthSecretStore();
    getAuthEntry("one");
    expect(constructed).toHaveLength(count + 1);
  });
});
