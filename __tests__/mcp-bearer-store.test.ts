import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BearerCredentialStoreError,
  getBearerTokenForUrl,
  getTestBearerTokenStoreEntries,
  inspectBearerTokenForUrl,
  removeBearerToken,
  removeTestBearerTokenStoreEntry,
  resetTestBearerTokenStore,
  saveBearerTokenForUrl,
  setTestBearerTokenStoreEntry,
} from "../mcp-bearer-store.ts";
import { getTestAuthSecretStoreEntries, resetTestAuthSecretStore, saveAuthEntry } from "../mcp-auth.ts";

const AUTH_SECRET_VALUE_LIMIT = 1280;

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while ((typeof current === "object" && current !== null) || typeof current === "function") {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.name === "string") parts.push(candidate.name);
    if (typeof candidate.message === "string") parts.push(candidate.message);
    current = candidate.cause;
  }
  return parts.join("\n");
}

describe("bearer token credential store", () => {
  const originalStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;

  beforeEach(() => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    resetTestBearerTokenStore();
    resetTestAuthSecretStore();
  });

  afterEach(() => {
    if (originalStore === undefined) delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    else process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = originalStore;
  });

  it("keeps bearer records isolated by trusted server name and separate from OAuth records", () => {
    saveBearerTokenForUrl("remote", "bearer-token", "https://example.test/mcp");
    saveAuthEntry("remote", { tokens: { accessToken: "oauth-token" } }, "https://example.test/mcp");

    expect(getBearerTokenForUrl("remote", "https://example.test/mcp")).toBe("bearer-token");
    expect(getBearerTokenForUrl("other", "https://example.test/mcp")).toBeUndefined();
    expect(getTestBearerTokenStoreEntries()).toHaveLength(1);
    expect(getTestAuthSecretStoreEntries()).toHaveLength(1);
    expect(getTestBearerTokenStoreEntries()[0][1]).toContain("bearer-token");
    expect(getTestAuthSecretStoreEntries()[0][1]).toContain("oauth-token");
  });

  it("does not return a token when the stored URL differs", () => {
    saveBearerTokenForUrl("remote", "bearer-token", "https://example.test/mcp");

    expect(getBearerTokenForUrl("remote", "https://other.test/mcp")).toBeUndefined();
    expect(inspectBearerTokenForUrl("remote", "https://other.test/mcp")).toEqual({ status: "url-mismatch" });
  });

  it("fails closed when the secure store is unavailable", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";

    expect(() => getBearerTokenForUrl("remote", "https://example.test/mcp")).toThrow(BearerCredentialStoreError);
    expect(inspectBearerTokenForUrl("remote", "https://example.test/mcp")).toMatchObject({ status: "unavailable" });
  });

  it("says the macOS keychain refuses a read because the running Node binary was removed", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const execPath = process.execPath;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    process.execPath = join(tmpdir(), "pi-mcp-removed-node", "bin", "node");
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    try {
      expect(() => getBearerTokenForUrl("remote", "https://example.test/mcp")).toThrow(/^Failed to read bearer token for remote from the OS secure credential store\. .*Homebrew upgrade.*restart Pi\.$/);
      const status = inspectBearerTokenForUrl("remote", "https://example.test/mcp");
      expect(status.status === "unavailable" && status.message).toMatch(/Homebrew upgrade.*credentials are intact: restart Pi\.$/);
    } finally {
      Object.defineProperty(process, "platform", platform);
      process.execPath = execPath;
    }
  });

  it("chunks large records and reads them back from a size-limited store", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    const token = "x".repeat(5000);

    saveBearerTokenForUrl("large", token, "https://example.test/mcp");

    expect(getBearerTokenForUrl("large", "https://example.test/mcp")).toBe(token);
    const entries = getTestBearerTokenStoreEntries();
    const manifest = entries.find(([account]) => !account.includes(".chunk."));
    const chunks = entries.filter(([account]) => account.includes(".chunk."));
    expect(manifest).toBeDefined();
    expect(JSON.parse(manifest![1]).__piMcpAdapterBearerChunked).toBe(1);
    expect(chunks.length).toBeGreaterThan(0);
    expect(entries.every(([, payload]) => payload.length <= AUTH_SECRET_VALUE_LIMIT)).toBe(true);
  });

  it("rejects malformed records and incomplete chunks", () => {
    saveBearerTokenForUrl("malformed", "token", "https://example.test/mcp");
    const malformedAccount = getTestBearerTokenStoreEntries()[0][0];
    setTestBearerTokenStoreEntry(malformedAccount, JSON.stringify({ token: 123, serverUrl: "https://example.test/mcp" }));

    expect(() => getBearerTokenForUrl("malformed", "https://example.test/mcp")).toThrow(BearerCredentialStoreError);

    resetTestBearerTokenStore();
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    saveBearerTokenForUrl("chunked", "x".repeat(5000), "https://example.test/mcp");
    const chunkAccount = getTestBearerTokenStoreEntries().find(([account]) => account.includes(".chunk."))?.[0];
    expect(chunkAccount).toBeDefined();
    removeTestBearerTokenStoreEntry(chunkAccount!);

    expect(() => getBearerTokenForUrl("chunked", "https://example.test/mcp")).toThrow(BearerCredentialStoreError);
  });

  it("does not expose raw token payloads in malformed-record error cause chains", () => {
    saveBearerTokenForUrl("raw-payload", "placeholder", "https://example.test/mcp");
    const account = getTestBearerTokenStoreEntries()[0][0];
    setTestBearerTokenStoreEntry(account, "secret-token-value");

    let thrown: unknown;
    try {
      getBearerTokenForUrl("raw-payload", "https://example.test/mcp");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BearerCredentialStoreError);
    const chain = errorChainText(thrown);
    expect(chain).toContain("Failed to read bearer token for raw-payload from the OS secure credential store");
    expect(chain).toContain("Failed to parse stored bearer token record for raw-payload");
    expect(chain).not.toContain("secret-token-value");
  });

  it("does not reuse an in-process token when the store later becomes unavailable", () => {
    saveBearerTokenForUrl("remote", "bearer-token", "https://example.test/mcp");
    expect(getBearerTokenForUrl("remote", "https://example.test/mcp")).toBe("bearer-token");

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";

    expect(() => getBearerTokenForUrl("remote", "https://example.test/mcp")).toThrow(BearerCredentialStoreError);
  });

  it("removes bearer records without exposing the token", () => {
    saveBearerTokenForUrl("remote", "bearer-token", "https://example.test/mcp");

    removeBearerToken("remote");

    expect(getBearerTokenForUrl("remote", "https://example.test/mcp")).toBeUndefined();
    expect(getTestBearerTokenStoreEntries()).toEqual([]);
  });
});
