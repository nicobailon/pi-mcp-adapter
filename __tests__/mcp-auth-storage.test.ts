import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  clearAllCredentials,
  formatOAuthCredentialStoreUnavailable,
  getAuthEntry,
  getAuthEntryFilePath,
  getAuthForUrl,
  getAuthStorageOptions,
  getTestAuthSecretStoreEntries,
  inspectAuthForUrl,
  OAuthCredentialStoreError,
  removeTestAuthSecretStoreEntry,
  resetAuthEntryCache,
  resetTestAuthSecretStore,
  saveAuthEntry,
  setTestAuthSecretStoreEntry,
} from "../mcp-auth.ts";

/**
 * Windows Credential Manager stores at most CRED_MAX_CREDENTIAL_BLOB_SIZE
 * (2560 bytes) as UTF-16, so a single value cannot exceed 1280 characters.
 */
const AUTH_SECRET_VALUE_LIMIT = 1280;
const AUTH_SECRET_CHUNK_SIZE = 1000;
const SERVER_URL = "https://example.com/mcp";

function accessTokenForSerializedLength(length: number): string {
  const envelopeLength = JSON.stringify({ tokens: { accessToken: "" }, serverUrl: SERVER_URL }).length;
  return "x".repeat(length - envelopeLength);
}

function accessTokenWithAstralCharacterAcrossNominalBoundary(): string {
  const marker = "TOKEN_MARKER";
  const serialized = JSON.stringify({ tokens: { accessToken: marker }, serverUrl: SERVER_URL });
  const tokenStart = serialized.indexOf(marker);
  return `${"x".repeat(AUTH_SECRET_CHUNK_SIZE - tokenStart - 1)}😀${"y".repeat(100)}`;
}

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

  it("explains Windows network-logon error 1312 without falling back", () => {
    const error = new OAuthCredentialStoreError("write failed", "write", new Error("ERROR_NO_SUCH_LOGON_SESSION (1312)"));
    expect(formatOAuthCredentialStoreUnavailable(error)).toContain("Windows Credential Manager is unavailable from this network logon");
    expect(formatOAuthCredentialStoreUnavailable(error)).toContain('oauthCredentialStore to "encrypted-file"');
  });

  it("does not infer the encrypted backend from untrusted OS error text", () => {
    const error = new OAuthCredentialStoreError(
      "Failed for server encrypted OAuth credential file store",
      "read",
      new Error("encrypted OAuth credential file store PI_MCP_ADAPTER_OAUTH_FILE_KEY"),
    );
    const message = formatOAuthCredentialStoreUnavailable(error);
    expect(message).toContain("Configure or unlock the OS credential store");
    expect(message).not.toContain("Encrypted OAuth credential file store unavailable");
  });
});

describe("encrypted OAuth credential file store", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const rotatedKey = Buffer.alloc(32, 8).toString("base64");
  const originalEnv = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_MCP_ADAPTER_OAUTH_FILE_KEY: process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY,
    PI_MCP_ADAPTER_TEST_AUTH_STORE: process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE,
    PI_MCP_ADAPTER_DISABLE_AUTH_CACHE: process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE,
  };
  let agentDir: string;
  let options: ReturnType<typeof getAuthStorageOptions>;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-encrypted-auth-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = key;
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";
    options = getAuthStorageOptions(undefined, process.cwd(), "encrypted-file");
    resetTestAuthSecretStore();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(agentDir, { recursive: true, force: true });
  });

  function credentialPath(serverName: string): string {
    const account = `sha256-${createHash("sha256").update(serverName).digest("hex")}`;
    return join(agentDir, "mcp-oauth-encrypted", account, "credentials.json");
  }

  it("selects only the explicit backend and ignores legacy path configuration", () => {
    expect(getAuthStorageOptions(undefined, process.cwd())).toEqual({});
    expect(getAuthStorageOptions(123, process.cwd(), "encrypted-file")).toEqual({ credentialStore: "encrypted-file" });
    expect(() => getAuthStorageOptions(undefined, process.cwd(), "plaintext")).toThrow(/oauthCredentialStore/);
  });

  it("round-trips and removes credentials without persisting secrets", () => {
    const entry = {
      tokens: { accessToken: "access-secret", refreshToken: "refresh-secret" },
      clientInfo: { clientId: "client", clientSecret: "client-secret" },
      codeVerifier: "verifier-secret",
      oauthState: "state-secret",
    };
    saveAuthEntry("secure-server", entry, SERVER_URL, options);
    const path = credentialPath("secure-server");
    const persisted = readFileSync(path, "utf8");
    for (const secret of ["access-secret", "refresh-secret", "client-secret", "verifier-secret", "state-secret", SERVER_URL]) {
      expect(persisted).not.toContain(secret);
    }
    resetAuthEntryCache();
    expect(getAuthEntry("secure-server", options)).toEqual({ ...entry, serverUrl: SERVER_URL });
    clearAllCredentials("secure-server", options);
    expect(existsSync(path)).toBe(false);
  });

  it("uses fresh ciphertext when credentials are rewritten", () => {
    saveAuthEntry("rewrite", { tokens: { accessToken: "secret" } }, SERVER_URL, options);
    const first = readFileSync(credentialPath("rewrite"), "utf8");
    saveAuthEntry("rewrite", { tokens: { accessToken: "secret" } }, SERVER_URL, options);
    expect(readFileSync(credentialPath("rewrite"), "utf8")).not.toBe(first);
  });

  it("rejects missing and malformed keys", () => {
    for (const badKey of [undefined, "not-base64", Buffer.alloc(31).toString("base64"), `${key}\n`]) {
      if (badKey === undefined) delete process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY;
      else process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = badKey;
      expect(() => getAuthEntry("key-validation", options)).toThrow(OAuthCredentialStoreError);
      const status = inspectAuthForUrl("key-validation", SERVER_URL, options);
      expect(status.status).toBe("unavailable");
      if (badKey === undefined && status.status === "unavailable") {
        expect(status.message).toContain("PI_MCP_ADAPTER_OAUTH_FILE_KEY");
        expect(status.message).not.toContain("OS credential store");
      }
    }
  });

  it("does not serve cached credentials after the key changes or disappears", () => {
    saveAuthEntry("key-rotation", { tokens: { accessToken: "secret" } }, SERVER_URL, options);
    expect(getAuthEntry("key-rotation", options)?.tokens?.accessToken).toBe("secret");
    process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = rotatedKey;
    expect(() => getAuthEntry("key-rotation", options)).toThrow(OAuthCredentialStoreError);
    delete process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY;
    expect(inspectAuthForUrl("key-rotation", SERVER_URL, options).status).toBe("unavailable");
  });

  it("evicts every cached key generation after removal", () => {
    delete process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE;
    saveAuthEntry("remove-generations", { tokens: { accessToken: "secret" } }, SERVER_URL, options);
    expect(getAuthEntry("remove-generations", options)?.tokens?.accessToken).toBe("secret");

    process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = rotatedKey;
    clearAllCredentials("remove-generations", options);
    expect(existsSync(credentialPath("remove-generations"))).toBe(false);

    process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = key;
    expect(getAuthEntry("remove-generations", options)).toBeUndefined();
  });

  it("does not evict a different NUL-containing server name", () => {
    delete process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE;
    const cachedServer = "x\0bar";
    saveAuthEntry(cachedServer, { tokens: { accessToken: "cached-secret" } }, SERVER_URL, options);
    expect(getAuthEntry(cachedServer, options)?.tokens?.accessToken).toBe("cached-secret");
    rmSync(dirname(credentialPath(cachedServer)), { recursive: true });
    expect(existsSync(credentialPath(cachedServer))).toBe(false);

    process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = rotatedKey;
    clearAllCredentials("bar", options);

    process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY = key;
    expect(getAuthEntry(cachedServer, options)?.tokens?.accessToken).toBe("cached-secret");
  });

  it("rejects tampered ciphertext", () => {
    saveAuthEntry("tamper", { tokens: { accessToken: "secret" } }, SERVER_URL, options);
    const path = credentialPath("tamper");
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
    writeFileSync(path, JSON.stringify(envelope), { mode: 0o600 });
    const status = inspectAuthForUrl("tamper", SERVER_URL, options);
    expect(status).toMatchObject({ status: "unavailable" });
    if (status.status === "unavailable") {
      expect(status.message).toContain("encrypted credential file and key");
      expect(status.message).toContain("reauthenticate");
      expect(status.message).not.toContain("OS credential store");
    }
    expect(getTestAuthSecretStoreEntries()).toEqual([]);
  });

  it("binds ciphertext to its server account", () => {
    saveAuthEntry("account-a", { tokens: { accessToken: "secret" } }, SERVER_URL, options);
    const copied = credentialPath("account-b");
    mkdirSync(dirname(copied), { recursive: true, mode: 0o700 });
    copyFileSync(credentialPath("account-a"), copied);
    chmodSync(copied, 0o600);
    expect(inspectAuthForUrl("account-b", SERVER_URL, options).status).toBe("unavailable");
  });

  it("preserves URL binding", () => {
    saveAuthEntry("url-bound", { tokens: { accessToken: "secret" } }, SERVER_URL, options);
    expect(getAuthForUrl("url-bound", SERVER_URL, options)?.tokens?.accessToken).toBe("secret");
    expect(getAuthForUrl("url-bound", "https://other.example/mcp", options)).toBeUndefined();
  });

  it("leaves legacy plaintext untouched", () => {
    const legacyPath = getAuthEntryFilePath("legacy", { baseDir: join(agentDir, "legacy") });
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ tokens: { accessToken: "legacy" }, serverUrl: SERVER_URL }));
    expect(getAuthEntry("legacy", options)).toBeUndefined();
    expect(existsSync(legacyPath)).toBe(true);
  });

  it.runIf(process.platform !== "win32")("creates private files and rejects permissive files", () => {
    saveAuthEntry("permissions", { tokens: { accessToken: "secret" } }, SERVER_URL, options);
    const path = credentialPath("permissions");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    resetAuthEntryCache();
    expect(() => getAuthEntry("permissions", options)).toThrow(OAuthCredentialStoreError);
  });

  it.runIf(process.platform !== "win32")("rejects regular and dangling symlink destinations for every operation", () => {
    const target = join(agentDir, "target.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    const symlinkPath = credentialPath("symlink");
    mkdirSync(dirname(symlinkPath), { recursive: true });
    symlinkSync(target, symlinkPath);
    expect(() => getAuthEntry("symlink", options)).toThrow(OAuthCredentialStoreError);

    for (const operation of ["read", "remove", "write"] as const) {
      const server = `dangling-${operation}`;
      const path = credentialPath(server);
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(join(agentDir, "missing-target"), path);
      if (operation === "read") expect(() => getAuthEntry(server, options)).toThrow(OAuthCredentialStoreError);
      if (operation === "remove") expect(() => clearAllCredentials(server, options)).toThrow(OAuthCredentialStoreError);
      if (operation === "write") expect(() => saveAuthEntry(server, { tokens: { accessToken: "secret" } }, SERVER_URL, options)).toThrow(OAuthCredentialStoreError);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
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

  it("stores an ordinary 9 KiB payload as one native item outside Windows", () => {
    const accessToken = accessTokenForSerializedLength(9 * 1024);
    saveAuthEntry("large-entry", { tokens: { accessToken } }, SERVER_URL);

    expect(getAuthEntry("large-entry")?.tokens?.accessToken).toBe(accessToken);
    const entries = getTestAuthSecretStoreEntries();
    if (process.platform === "win32") {
      const manifestEntry = entries.find(([account]) => !account.includes(".chunk."));
      const chunkEntries = entries.filter(([account]) => account.includes(".chunk."));
      expect(manifestEntry).toBeDefined();
      const manifest = JSON.parse(manifestEntry![1]) as { __piMcpAdapterOAuthChunked?: number; chunkCount?: number };
      expect(manifest.__piMcpAdapterOAuthChunked).toBe(1);
      expect(chunkEntries).toHaveLength(manifest.chunkCount!);
      expect(chunkEntries.every(([, payload]) => payload.length <= AUTH_SECRET_VALUE_LIMIT)).toBe(true);
    } else {
      expect(entries).toHaveLength(1);
      expect(entries[0][0]).not.toContain(".chunk.");
      expect(JSON.parse(entries[0][1]).__piMcpAdapterOAuthChunked).toBeUndefined();
    }
  });

  it("uses the serialized 1000-character boundary for the size-limited store", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";

    for (const [serverName, payloadLength, chunked] of [
      ["size-limited-at-boundary", AUTH_SECRET_CHUNK_SIZE, false],
      ["size-limited-over-boundary", AUTH_SECRET_CHUNK_SIZE + 1, true],
    ] as const) {
      resetTestAuthSecretStore();
      const accessToken = accessTokenForSerializedLength(payloadLength);
      saveAuthEntry(serverName, { tokens: { accessToken } }, SERVER_URL);

      expect(getAuthEntry(serverName)?.tokens?.accessToken).toBe(accessToken);
      const entries = getTestAuthSecretStoreEntries();
      expect(entries.every(([, payload]) => payload.length <= AUTH_SECRET_VALUE_LIMIT)).toBe(true);
      expect(entries.some(([account]) => account.includes(".chunk."))).toBe(chunked);
      const primary = entries.find(([account]) => !account.includes(".chunk."));
      expect(primary).toBeDefined();
      expect(JSON.parse(primary![1]).__piMcpAdapterOAuthChunked === 1).toBe(chunked);
    }
  });

  it("keeps surrogate pairs intact across native-string chunk round trips", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    const accessToken = accessTokenWithAstralCharacterAcrossNominalBoundary();
    const serialized = JSON.stringify({ tokens: { accessToken }, serverUrl: SERVER_URL });
    expect([serialized.charCodeAt(999), serialized.charCodeAt(1000)]).toEqual([0xd83d, 0xde00]);
    saveAuthEntry("unicode-boundary", { tokens: { accessToken } }, SERVER_URL);

    const chunkEntries = getTestAuthSecretStoreEntries().filter(([account]) => account.includes(".chunk."));
    expect(chunkEntries.length).toBeGreaterThan(1);
    expect(chunkEntries.every(([, payload]) => payload.length <= AUTH_SECRET_CHUNK_SIZE)).toBe(true);
    for (const [account, payload] of chunkEntries) {
      const nativeRoundTrip = Buffer.from(payload, "utf8").toString("utf8");
      expect(nativeRoundTrip).not.toContain("�");
      setTestAuthSecretStoreEntry(account, nativeRoundTrip);
    }

    resetAuthEntryCache();
    expect(getAuthEntry("unicode-boundary")?.tokens?.accessToken).toBe(accessToken);
  });

  it("persists records that exceed the strictest per-value store limit", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    const accessToken = "x".repeat(5000);

    saveAuthEntry("size-limited-large", { tokens: { accessToken } }, "https://example.com/mcp");

    expect(getAuthEntry("size-limited-large")?.tokens?.accessToken).toBe(accessToken);
    expect(getTestAuthSecretStoreEntries().every(([, payload]) => payload.length <= AUTH_SECRET_VALUE_LIMIT)).toBe(true);
  });

  it("persists records just above the per-value limit that are too small for a naive chunk threshold", () => {
    // Regression: a threshold above the store limit skipped chunking entirely,
    // so records in this band failed to persist on Windows at any payload size.
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    const accessToken = "x".repeat(AUTH_SECRET_VALUE_LIMIT + 200);

    saveAuthEntry("size-limited-boundary", { tokens: { accessToken } }, "https://example.com/mcp");

    expect(getAuthEntry("size-limited-boundary")?.tokens?.accessToken).toBe(accessToken);
    expect(getTestAuthSecretStoreEntries().every(([, payload]) => payload.length <= AUTH_SECRET_VALUE_LIMIT)).toBe(true);
  });

  it("keeps small records in a single entry on a size-limited store", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";

    saveAuthEntry("size-limited-small", { tokens: { accessToken: "small" } }, "https://example.com/mcp");

    expect(getAuthEntry("size-limited-small")?.tokens?.accessToken).toBe("small");
    const entries = getTestAuthSecretStoreEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).not.toContain(".chunk.");
  });

  it("clears chunked records written to a size-limited store", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    saveAuthEntry("size-limited-remove", { tokens: { accessToken: "x".repeat(5000) } }, "https://example.com/mcp");
    expect(getTestAuthSecretStoreEntries().some(([account]) => account.includes(".chunk."))).toBe(true);

    clearAllCredentials("size-limited-remove");

    expect(getTestAuthSecretStoreEntries()).toHaveLength(0);
  });

  it("returns unavailable status when a stored chunk cannot be read", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    saveAuthEntry("large-status", { tokens: { accessToken: "x".repeat(5000) } }, "https://example.com/mcp");
    const chunkAccount = getTestAuthSecretStoreEntries().find(([account]) => account.includes(".chunk."))?.[0];
    expect(chunkAccount).toBeDefined();
    removeTestAuthSecretStoreEntry(chunkAccount!);

    expect(inspectAuthForUrl("large-status", "https://example.com/mcp").status).toBe("unavailable");
  });

  it("rejects schema-valid chunk corruption without compacting or deleting it", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    saveAuthEntry("corrupt-chunk", { tokens: { accessToken: "x".repeat(5000) } }, SERVER_URL);
    const [chunkAccount, chunkPayload] = getTestAuthSecretStoreEntries()
      .find(([account, payload]) => account.includes(".chunk.") && payload.includes("x"))!;
    setTestAuthSecretStoreEntry(chunkAccount, chunkPayload.replace("x", "y"));
    const corruptedEntries = getTestAuthSecretStoreEntries();

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    resetAuthEntryCache();
    expect(inspectAuthForUrl("corrupt-chunk", SERVER_URL).status).toBe("unavailable");
    expect(getTestAuthSecretStoreEntries()).toEqual(corruptedEntries);
    expect(() => getAuthEntry("corrupt-chunk")).toThrow(/read OAuth credentials/);
    expect(getTestAuthSecretStoreEntries()).toEqual(corruptedEntries);
  });

  it("removes chunk payloads when credentials are cleared", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    saveAuthEntry("large-remove", { tokens: { accessToken: "x".repeat(5000) } }, "https://example.com/mcp");
    const storedAccounts = getTestAuthSecretStoreEntries().map(([account]) => account);
    expect(storedAccounts.some(account => account.includes(".chunk."))).toBe(true);

    clearAllCredentials("large-remove");

    const remainingAccounts = new Set(getTestAuthSecretStoreEntries().map(([account]) => account));
    expect(storedAccounts.every(account => !remainingAccounts.has(account))).toBe(true);
  });

  it("cleans stale chunks when a large entry is replaced by a small one", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    saveAuthEntry("large-to-small", { tokens: { accessToken: "x".repeat(5000) } }, "https://example.com/mcp");
    expect(getTestAuthSecretStoreEntries().some(([account]) => account.includes(".chunk."))).toBe(true);

    saveAuthEntry("large-to-small", { tokens: { accessToken: "small" } }, "https://example.com/mcp");

    expect(getAuthEntry("large-to-small")?.tokens?.accessToken).toBe("small");
    const entries = getTestAuthSecretStoreEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).not.toContain(".chunk.");
  });

  it("does not compact chunked records during status-only inspection", () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    const accessToken = "x".repeat(5000);
    saveAuthEntry("status-chunks", { tokens: { accessToken } }, "https://example.com/mcp");
    const before = getTestAuthSecretStoreEntries().length;
    expect(before).toBeGreaterThan(1);

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    resetAuthEntryCache();
    expect(inspectAuthForUrl("status-chunks", "https://example.com/mcp").status).toBe("present");
    expect(getTestAuthSecretStoreEntries().some(([account]) => account.includes(".chunk."))).toBe(true);
    expect(getTestAuthSecretStoreEntries()).toHaveLength(before);

    expect(getAuthEntry("status-chunks")?.tokens?.accessToken).toBe(accessToken);
    const compacted = getTestAuthSecretStoreEntries();
    expect(compacted).toHaveLength(1);
    expect(compacted[0][0]).not.toContain(".chunk.");
  });

  it("preserves readable chunks and reports a failed primary compaction write", () => {
    if (process.platform === "win32") return;
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "sizelimited";
    const accessToken = "x".repeat(5000);
    saveAuthEntry("failed-compaction", { tokens: { accessToken } }, SERVER_URL);
    const before = getTestAuthSecretStoreEntries();

    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "writefailing";
    resetAuthEntryCache();
    expect(() => getAuthEntry("failed-compaction")).toThrow(/write OAuth credentials/);
    expect(getTestAuthSecretStoreEntries()).toEqual(before);
    expect(inspectAuthForUrl("failed-compaction", SERVER_URL).status).toBe("present");
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
