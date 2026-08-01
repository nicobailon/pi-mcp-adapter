import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  clearAllCredentials,
  formatOAuthCredentialStoreUnavailable,
  getAuthEntry,
  getAuthEntryFilePath,
  getAuthStorageOptions,
  getTestAuthSecretStoreEntries,
  inspectAuthForUrl,
  OAuthCredentialStoreError,
  removeTestAuthSecretStoreEntry,
  resetTestAuthSecretStore,
  saveAuthEntry,
} from "../mcp-auth.ts";

describe("OAuth credential-store diagnostics", () => {
  it("recognizes a revoked Linux keyring through the error cause chain", () => {
    const nativeError = new Error("Couldn't access platform storage: KeyRevoked", {
      cause: new Error("KeyRevoked"),
    });
    const error = new OAuthCredentialStoreError("read failed", "read", nativeError);

    const message = formatOAuthCredentialStoreUnavailable(error);
    if (process.platform === "linux") {
      expect(message).toContain("Linux session keyring may be revoked");
      expect(message).toContain("fresh login/keyring session");
    } else {
      expect(message).toContain("OAuth credential store unavailable");
    }
  });
});

describe("mcp-auth storage paths", () => {
  const originalEnv = {
    MCP_OAUTH_DIR: process.env.MCP_OAUTH_DIR,
    PI_MCP_ADAPTER_TEST_AUTH_STORE: process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE,
    PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY: process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY,
    PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL: process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL,
    PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE: process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE,
    PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER: process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER,
    PI_MCP_ADAPTER_FAKE_KEYRING_STORE: process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE,
  };
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-auth-storage-"));
    process.env.MCP_OAUTH_DIR = authDir;
    resetTestAuthSecretStore();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(authDir, { recursive: true, force: true });
  });

  it("keeps arbitrary configured server names under safe hashed legacy import paths", () => {
    const names = ["Cloudflare Workers", "сервер", "../escape", "@scope/name", ""];

    for (const [index, name] of names.entries()) {
      const token = `token-${index}`;
      saveAuthEntry(name, { tokens: { accessToken: token } }, "https://example.com/mcp");

      expect(getAuthEntry(name)?.tokens?.accessToken).toBe(token);
      const filePath = getAuthEntryFilePath(name);
      const rel = relative(authDir, filePath);
      expect(rel.startsWith("..")).toBe(false);
      expect(isAbsolute(rel)).toBe(false);
      expect(rel).toMatch(/^sha256-[a-f0-9]{64}\/tokens\.json$/);
      expect(existsSync(filePath)).toBe(false);
    }

    expect(existsSync(join(authDir, "..", "escape", "tokens.json"))).toBe(false);
  });

  it("rejects non-string names at the storage boundary", () => {
    expect(() => getAuthEntryFilePath(undefined as unknown as string)).toThrow(/Invalid MCP server name/);
  });

  it("uses configured oauthDir as the legacy import source", () => {
    delete process.env.MCP_OAUTH_DIR;
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-"));
    const options = getAuthStorageOptions(".pi/oauth", project);
    const filePath = getAuthEntryFilePath("configured", options);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ tokens: { accessToken: "legacy-token" }, serverUrl: "https://example.com/mcp" }), "utf-8");

    expect(getAuthEntry("configured", options)?.tokens?.accessToken).toBe("legacy-token");
    expect(filePath.startsWith(join(project, ".pi", "oauth"))).toBe(true);
    expect(existsSync(filePath)).toBe(false);
    expect(getAuthEntry("configured", options)?.tokens?.accessToken).toBe("legacy-token");
    rmSync(project, { recursive: true, force: true });
  });

  it("does not migrate legacy credentials during status-only inspection", () => {
    const filePath = getAuthEntryFilePath("status-only");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      tokens: { accessToken: "legacy-token" },
      serverUrl: "https://example.com/mcp",
    }), "utf-8");

    expect(inspectAuthForUrl("status-only", "https://example.com/mcp").status).toBe("present");
    expect(existsSync(filePath)).toBe(true);

    expect(getAuthEntry("status-only")?.tokens?.accessToken).toBe("legacy-token");
    expect(existsSync(filePath)).toBe(false);
  });

  it("does not use configured oauthDir values as secure-store namespaces", () => {
    delete process.env.MCP_OAUTH_DIR;
    const projectA = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-b-"));
    const optionsA = getAuthStorageOptions(".pi/oauth", projectA);
    const optionsB = getAuthStorageOptions(".pi/oauth", projectB);

    saveAuthEntry("same-server", { tokens: { accessToken: "token-a" } }, "https://example.com/mcp", optionsA);
    saveAuthEntry("same-server", { tokens: { accessToken: "token-b" } }, "https://example.com/mcp", optionsB);

    expect(getAuthEntry("same-server", optionsA)?.tokens?.accessToken).toBe("token-b");
    expect(getAuthEntry("same-server", optionsB)?.tokens?.accessToken).toBe("token-b");
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("keeps MCP_OAUTH_DIR as the explicit override over settings.oauthDir", () => {
    const project = mkdtempSync(join(tmpdir(), "pi-mcp-auth-project-"));
    const options = getAuthStorageOptions(".pi/oauth", project);

    saveAuthEntry("env-override", { tokens: { accessToken: "token" } }, "https://example.com/mcp", options);

    const filePath = getAuthEntryFilePath("env-override", options);
    expect(filePath.startsWith(authDir)).toBe(true);
    expect(filePath.startsWith(join(project, ".pi", "oauth"))).toBe(false);
    rmSync(project, { recursive: true, force: true });
  });

  it("chunks large secure-store entries and reads them back", () => {
    const accessToken = "x".repeat(5000);
    saveAuthEntry("large-entry", { tokens: { accessToken } }, "https://example.com/mcp");

    expect(getAuthEntry("large-entry")?.tokens?.accessToken).toBe(accessToken);
    const entries = getTestAuthSecretStoreEntries();
    const manifestEntry = entries.find(([account]) => !account.includes(".chunk."));
    const chunkEntries = entries.filter(([account]) => account.includes(".chunk."));

    expect(manifestEntry).toBeDefined();
    const manifest = JSON.parse(manifestEntry![1]) as { __piMcpAdapterOAuthChunked?: number; chunkCount?: number };
    expect(manifest.__piMcpAdapterOAuthChunked).toBe(1);
    expect(chunkEntries).toHaveLength(manifest.chunkCount);
    expect(chunkEntries.every(([, payload]) => payload.length <= 1800)).toBe(true);
  });

  it("returns unavailable status when a stored chunk cannot be read", () => {
    saveAuthEntry("large-status", { tokens: { accessToken: "x".repeat(5000) } }, "https://example.com/mcp");
    const chunkAccount = getTestAuthSecretStoreEntries().find(([account]) => account.includes(".chunk."))?.[0];
    expect(chunkAccount).toBeDefined();
    removeTestAuthSecretStoreEntry(chunkAccount!);

    expect(inspectAuthForUrl("large-status", "https://example.com/mcp").status).toBe("unavailable");
  });

  it("removes chunk payloads when credentials are cleared", () => {
    saveAuthEntry("large-remove", { tokens: { accessToken: "x".repeat(5000) } }, "https://example.com/mcp");
    const storedAccounts = getTestAuthSecretStoreEntries().map(([account]) => account);
    expect(storedAccounts.some(account => account.includes(".chunk."))).toBe(true);

    clearAllCredentials("large-remove");

    const remainingAccounts = new Set(getTestAuthSecretStoreEntries().map(([account]) => account));
    expect(storedAccounts.every(account => !remainingAccounts.has(account))).toBe(true);
  });

  it("cleans stale chunks when a large entry is replaced by a small one", () => {
    saveAuthEntry("large-to-small", { tokens: { accessToken: "x".repeat(5000) } }, "https://example.com/mcp");
    expect(getTestAuthSecretStoreEntries().some(([account]) => account.includes(".chunk."))).toBe(true);

    saveAuthEntry("large-to-small", { tokens: { accessToken: "small" } }, "https://example.com/mcp");

    expect(getAuthEntry("large-to-small")?.tokens?.accessToken).toBe("small");
    const entries = getTestAuthSecretStoreEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).not.toContain(".chunk.");
  });

  it("routes revoked Linux keyring operations through the recovery helper", () => {
    const harnessDir = mkdtempSync(join(tmpdir(), "pi-mcp-keyring-recovery-"));
    const keyctlPath = join(harnessDir, "keyctl");
    const helperPath = join(harnessDir, "helper.cjs");
    const storePath = join(harnessDir, "store.json");

    writeFileSync(keyctlPath, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" != "session" ] || [ "$2" != "-" ]; then exit 64; fi
shift 2
exec "$@"
`, { mode: 0o755 });
    writeFileSync(helperPath, `const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const input = JSON.parse(readFileSync(0, 'utf8'));
const path = process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE;
const store = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
if (input.operation === 'read') {
  const value = store[input.account];
  process.stdout.write(JSON.stringify(value === undefined ? { ok: true, found: false } : { ok: true, found: true, value }) + '\\n');
} else if (input.operation === 'write') {
  store[input.account] = input.payload;
  writeFileSync(path, JSON.stringify(store));
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
} else if (input.operation === 'remove') {
  delete store[input.account];
  writeFileSync(path, JSON.stringify(store));
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: false, error: 'bad op' }) + '\\n');
  process.exitCode = 1;
}
`);

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "keyrevoked";
    process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY = "1";
    process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL = keyctlPath;
    process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE = process.execPath;
    process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER = helperPath;
    process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE = storePath;

    const accessToken = "x".repeat(5000);
    saveAuthEntry("recovered", { tokens: { accessToken } }, "https://example.com/mcp");

    expect(getAuthEntry("recovered")?.tokens?.accessToken).toBe(accessToken);

    clearAllCredentials("recovered");

    expect(getAuthEntry("recovered")).toBeUndefined();
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual({});
    rmSync(harnessDir, { recursive: true, force: true });
  });

  it("does not use the recovery helper for generic secure-store failures", () => {
    const harnessDir = mkdtempSync(join(tmpdir(), "pi-mcp-keyring-no-recovery-"));
    const keyctlPath = join(harnessDir, "keyctl");
    const storePath = join(harnessDir, "store.json");
    writeFileSync(keyctlPath, "#!/usr/bin/env bash\nexit 99\n", { mode: 0o755 });

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    process.env.PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY = "1";
    process.env.PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL = keyctlPath;
    process.env.PI_MCP_ADAPTER_FAKE_KEYRING_STORE = storePath;

    expect(() => getAuthEntry("generic-unavailable")).toThrow(/OS secure credential store/);
    expect(existsSync(storePath)).toBe(false);
    rmSync(harnessDir, { recursive: true, force: true });
  });
});
