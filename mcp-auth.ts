/**
 * MCP Auth Storage Module
 *
 * Handles secure storage of OAuth credentials, tokens, client information,
 * and legacy PKCE state for MCP servers.
 *
 * Persistent OAuth entries are stored in the operating system credential store.
 * Legacy plaintext entries are imported from $MCP_OAUTH_DIR/sha256-<server-hash>/tokens.json
 * when set, otherwise <Pi agent dir>/mcp-oauth/sha256-<server-hash>/tokens.json,
 * then the plaintext file is removed.
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { readFileSync, existsSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getAgentPath } from './agent-dir.ts';
import { resolveConfiguredOAuthDir } from './config.ts';

const require = createRequire(import.meta.url);
const AUTH_SECRET_SERVICE = 'pi-mcp-adapter.oauth';
const TEST_AUTH_STORE_ENV = 'PI_MCP_ADAPTER_TEST_AUTH_STORE';
/**
 * Windows Credential Manager caps one value at CRED_MAX_CREDENTIAL_BLOB_SIZE
 * (2560 bytes) and stores it as UTF-16, so the real ceiling is
 * AUTH_SECRET_VALUE_LIMIT characters. Chunks must stay below that, and so must
 * the threshold that decides whether to chunk at all, or oversized records still
 * fail to persist on Windows.
 */
const AUTH_SECRET_CHUNK_SIZE = 1000;
/** Largest single value the strictest supported credential store accepts. */
const AUTH_SECRET_VALUE_LIMIT = 1280;
const KEYRING_RECOVERY_DISABLED_ENV = 'PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY';
const KEYRING_RECOVERY_KEYCTL_ENV = 'PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL';
const KEYRING_RECOVERY_NODE_ENV = 'PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE';
const KEYRING_RECOVERY_HELPER_ENV = 'PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER';
const TEST_LINUX_KEYRING_RECOVERY_ENV = 'PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY';
const AUTH_CACHE_DISABLED_ENV = 'PI_MCP_ADAPTER_DISABLE_AUTH_CACHE';
const KEYRING_RECOVERY_TIMEOUT_MS = 10_000;
const AUTH_CHUNK_MANIFEST_KEY = '__piMcpAdapterOAuthChunked';

/** OAuth token storage format */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp in seconds
  scope?: string;
  /** SEP-2352 authorization-server issuer binding */
  issuer?: string;
}

/** OAuth client information from dynamic or static registration */
export interface StoredClientInfo {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
  redirectUris?: string[];
  /** SEP-2352 authorization-server issuer binding */
  issuer?: string;
  /**
   * True when this entry is a secretless SEP-2352 issuer stub persisted for a
   * config-pre-registered client (written by the config-clientId path of
   * saveClientInformation). Such a stub is only usable when paired with the
   * config that supplies the client secret; it must never be served as
   * standalone client information.
   */
  configPreRegistered?: boolean;
}

/** Complete auth entry for a server */
export interface AuthEntry {
  tokens?: StoredTokens;
  clientInfo?: StoredClientInfo;
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string; // Track the URL these credentials are for
}

export interface AuthStorageOptions {
  /** Legacy plaintext import directory. Persistent secrets no longer use this as their store. */
  baseDir?: string;
}

export class OAuthCredentialStoreError extends Error {
  readonly code = 'OAUTH_CREDENTIAL_STORE_UNAVAILABLE';

  constructor(
    message: string,
    readonly operation: 'read' | 'write' | 'remove',
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'OAuthCredentialStoreError';
  }
}

export type OAuthCredentialStatus =
  | { status: 'present'; entry: AuthEntry }
  | { status: 'absent' }
  | { status: 'unavailable'; message: string };

function causeChainContains(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while ((typeof current === 'object' && current !== null) || typeof current === 'function') {
    if (seen.has(current)) break;
    seen.add(current);
    const candidate = current as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    if ([candidate.name, candidate.message, candidate.code].some(value => typeof value === 'string' && pattern.test(value))) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function formatOAuthCredentialStoreUnavailable(error: OAuthCredentialStoreError): string {
  if (process.platform === 'linux' && causeChainContains(error, /key\s*(?:has been\s*)?revoked|keyrevoked/i)) {
    return 'OAuth credential store unavailable: the Linux session keyring may be revoked. Start Pi from a fresh login/keyring session and retry.';
  }
  return 'OAuth credential store unavailable. Configure or unlock the OS credential store and retry.';
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
}

type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntry;
type KeyringModule = { Entry: KeyringEntryConstructor };
type KeyringRequire = ((id: string) => unknown) & { resolve(id: string): string };

interface AuthSecretStore {
  read(account: string): string | undefined;
  write(account: string, payload: string): void;
  remove(account: string): void;
}

interface AuthEntryChunkManifest {
  [AUTH_CHUNK_MANIFEST_KEY]: 1;
  chunkCount: number;
  chunkDigest: string;
}

let KeyringEntryClass: KeyringEntryConstructor | undefined;
const memoryAuthEntries = new Map<string, string>();

let testAuthSecretStoreReadCount = 0;
const authEntryCache = new Map<string, AuthEntry | undefined>();

function isAuthEntryCacheEnabled(): boolean {
  return process.env[AUTH_CACHE_DISABLED_ENV] !== '1';
}

function cloneAuthEntry(entry: AuthEntry | undefined): AuthEntry | undefined {
  return entry === undefined ? undefined : structuredClone(entry);
}

const memoryAuthSecretStore: AuthSecretStore = {
  read(account) {
    testAuthSecretStoreReadCount++;
    return memoryAuthEntries.get(account);
  },
  write(account, payload) {
    memoryAuthEntries.set(account, payload);
  },
  remove(account) {
    memoryAuthEntries.delete(account);
  },
};

const keyringAuthSecretStore: AuthSecretStore = {
  read(account) {
    return getKeyringEntry(account).getPassword() ?? undefined;
  },
  write(account, payload) {
    getKeyringEntry(account).setPassword(payload);
  },
  remove(account) {
    getKeyringEntry(account).deleteCredential();
  },
};

/** Mimics the Windows Credential Manager per-value ceiling for tests. */
const sizeLimitedAuthSecretStore: AuthSecretStore = {
  read(account) {
    testAuthSecretStoreReadCount++;
    return memoryAuthEntries.get(account);
  },
  write(account, payload) {
    if (payload.length > AUTH_SECRET_VALUE_LIMIT) {
      throw new Error(`Value of 'password encoded as UTF-16' is longer than the platform limit of ${AUTH_SECRET_VALUE_LIMIT * 2} chars`);
    }
    memoryAuthEntries.set(account, payload);
  },
  remove(account) {
    memoryAuthEntries.delete(account);
  },
};

const unavailableAuthSecretStore: AuthSecretStore = {
  read() {
    testAuthSecretStoreReadCount++;
    throw new Error('simulated secure credential store unavailable');
  },
  write() {
    throw new Error('simulated secure credential store unavailable');
  },
  remove() {
    throw new Error('simulated secure credential store unavailable');
  },
};

function createKeyRevokedTestError(): Error {
  return new Error("Couldn't access platform storage: KeyRevoked", { cause: new Error('KeyRevoked') });
}

const keyRevokedAuthSecretStore: AuthSecretStore = {
  read() {
    testAuthSecretStoreReadCount++;
    throw createKeyRevokedTestError();
  },
  write() {
    throw createKeyRevokedTestError();
  },
  remove() {
    throw createKeyRevokedTestError();
  },
};

export function resetTestAuthSecretStore(): void {
  memoryAuthEntries.clear();
  authEntryCache.clear();
  testAuthSecretStoreReadCount = 0;
}

export function resetAuthEntryCache(): void {
  authEntryCache.clear();
}

export function getTestAuthSecretStoreReadCount(): number {
  return testAuthSecretStoreReadCount;
}

export function getTestAuthSecretStoreEntries(): [string, string][] {
  return [...memoryAuthEntries.entries()];
}

export function removeTestAuthSecretStoreEntry(account: string): void {
  memoryAuthEntries.delete(account);
}

function getAuthSecretStore(): AuthSecretStore {
  if (process.env[TEST_AUTH_STORE_ENV] === 'memory') return memoryAuthSecretStore;
  if (process.env[TEST_AUTH_STORE_ENV] === 'sizelimited') return sizeLimitedAuthSecretStore;
  if (process.env[TEST_AUTH_STORE_ENV] === 'unavailable') return unavailableAuthSecretStore;
  if (process.env[TEST_AUTH_STORE_ENV] === 'keyrevoked') return keyRevokedAuthSecretStore;
  return keyringAuthSecretStore;
}

function getKeyringEntry(account: string): KeyringEntry {
  try {
    KeyringEntryClass ??= loadKeyringEntryClass();
    return new KeyringEntryClass(AUTH_SECRET_SERVICE, account);
  } catch (error) {
    throw new Error('OAuth secure credential storage is unavailable. Configure the OS credential store and retry authentication.', { cause: error });
  }
}

function loadKeyringEntryClass(keyringRequire: KeyringRequire = require, platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): KeyringEntryConstructor {
  try {
    return (keyringRequire('@napi-rs/keyring') as KeyringModule).Entry;
  } catch (loaderError) {
    try {
      return loadKeyringNativeBindingFallback(keyringRequire, platform, arch).Entry;
    } catch (fallbackError) {
      throw new Error(`Failed to load @napi-rs/keyring; absolute-path native binding fallback also failed: ${formatErrorMessage(fallbackError)}`, {
        cause: loaderError,
      });
    }
  }
}

function loadKeyringNativeBindingFallback(keyringRequire: KeyringRequire, platform: NodeJS.Platform, arch: NodeJS.Architecture): KeyringModule {
  const targets = getKeyringNativeBindingTargets(platform, arch);
  if (targets.length === 0) {
    throw new Error(`Unsupported @napi-rs/keyring native binding target: ${platform}-${arch}`);
  }

  let lastError: unknown;
  for (const target of targets) {
    try {
      const packageJsonPath = keyringRequire.resolve(`${target.packageName}/package.json`);
      return keyringRequire(join(dirname(packageJsonPath), target.bindingFile)) as KeyringModule;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getKeyringNativeBindingTargets(platform: NodeJS.Platform, arch: NodeJS.Architecture): { packageName: string; bindingFile: string }[] {
  return getKeyringNativeBindingSuffixes(platform, arch).map(suffix => ({
    packageName: `@napi-rs/keyring-${suffix}`,
    bindingFile: `keyring.${suffix}.node`,
  }));
}

function getKeyringNativeBindingSuffixes(platform: NodeJS.Platform, arch: NodeJS.Architecture): string[] {
  if (platform === 'darwin') {
    if (arch === 'arm64') return ['darwin-arm64'];
    if (arch === 'x64') return ['darwin-x64'];
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return ['win32-arm64-msvc'];
    if (arch === 'x64') return ['win32-x64-msvc'];
    if (arch === 'ia32') return ['win32-ia32-msvc'];
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return ['linux-arm64-gnu', 'linux-arm64-musl'];
    if (arch === 'arm') return ['linux-arm-gnueabihf'];
    if (arch === 'riscv64') return ['linux-riscv64-gnu'];
    if (arch === 'x64') return ['linux-x64-gnu', 'linux-x64-musl'];
  }
  if (platform === 'freebsd' && arch === 'x64') return ['freebsd-x64'];
  return [];
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type KeyringRecoveryOperation = 'read' | 'write' | 'remove';

type KeyringRecoveryResponse =
  | { ok: true; found?: boolean; value?: string }
  | { ok: false; error?: string };

function isLinuxKeyringRecoveryEnabled(): boolean {
  if (process.env[KEYRING_RECOVERY_DISABLED_ENV] === '1') return false;
  return process.platform === 'linux' || process.env[TEST_LINUX_KEYRING_RECOVERY_ENV] === '1';
}

function shouldAttemptLinuxKeyringRecovery(error: unknown): boolean {
  return isLinuxKeyringRecoveryEnabled()
    && causeChainContains(error, /key\s*(?:has been\s*)?revoked|keyrevoked/i);
}

function runLinuxKeyringRecoveryOperation(operation: KeyringRecoveryOperation, account: string, payload?: string): KeyringRecoveryResponse {
  const keyctl = process.env[KEYRING_RECOVERY_KEYCTL_ENV]?.trim() || 'keyctl';
  const node = process.env[KEYRING_RECOVERY_NODE_ENV]?.trim() || 'node';
  const helper = process.env[KEYRING_RECOVERY_HELPER_ENV]?.trim()
    || fileURLToPath(new URL('./mcp-keyring-helper.cjs', import.meta.url));
  const request = JSON.stringify({ operation, service: AUTH_SECRET_SERVICE, account, payload });
  const result = spawnSync(keyctl, ['session', '-', node, helper], {
    input: `${request}\n`,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: KEYRING_RECOVERY_TIMEOUT_MS,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Linux keyring recovery helper could not start: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`Linux keyring recovery helper failed with exit code ${result.status ?? 'unknown'}`);
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout.trim()) as unknown;
  } catch (error) {
    throw new Error('Linux keyring recovery helper returned invalid JSON', { cause: error });
  }
  if (typeof response !== 'object' || response === null || typeof (response as { ok?: unknown }).ok !== 'boolean') {
    throw new Error('Linux keyring recovery helper returned an invalid response');
  }
  const typedResponse = response as KeyringRecoveryResponse;
  if (typedResponse.ok === false) {
    throw new Error(typedResponse.error || 'Linux keyring recovery helper failed');
  }
  if (operation === 'read' && typedResponse.found === true && typeof typedResponse.value !== 'string') {
    throw new Error('Linux keyring recovery helper returned an invalid read response');
  }
  return typedResponse;
}

const linuxKeyringRecoveryAuthSecretStore: AuthSecretStore = {
  read(account) {
    const response = runLinuxKeyringRecoveryOperation('read', account);
    return response.ok && response.found === true ? response.value : undefined;
  },
  write(account, payload) {
    runLinuxKeyringRecoveryOperation('write', account, payload);
  },
  remove(account) {
    runLinuxKeyringRecoveryOperation('remove', account);
  },
};

export function loadTestKeyringEntryClass(keyringRequire: KeyringRequire, platform: NodeJS.Platform, arch: NodeJS.Architecture): KeyringEntryConstructor {
  return loadKeyringEntryClass(keyringRequire, platform, arch);
}

export function getAuthStorageOptions(oauthDir: unknown, cwd = process.cwd()): AuthStorageOptions {
  const baseDir = resolveConfiguredOAuthDir(oauthDir, cwd);
  return baseDir ? { baseDir } : {};
}

export function getAuthBaseDir(options: AuthStorageOptions = {}): string {
  const override = process.env.MCP_OAUTH_DIR?.trim();
  if (override) return override;
  return options.baseDir ?? getAgentPath('mcp-oauth');
}

/**
 * Get the legacy server-specific directory path.
 */
function getServerDir(serverName: string, options?: AuthStorageOptions): string {
  if (typeof serverName !== 'string') {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  const storageKey = getAuthEntryAccount(serverName);
  return join(getAuthBaseDir(options), storageKey);
}

function getAuthEntryAccount(serverName: string): string {
  if (typeof serverName !== 'string') {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  return `sha256-${createHash('sha256').update(serverName, 'utf8').digest('hex')}`;
}

/**
 * Get the legacy plaintext tokens file path for a server.
 */
export function getAuthEntryFilePath(serverName: string, options?: AuthStorageOptions): string {
  return join(getServerDir(serverName, options), 'tokens.json');
}

function parseJsonPayload(serverName: string, payload: string, source: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse OAuth credentials for ${serverName} from ${source}`, { cause: error });
  }
}

function parseAuthEntryPayload(serverName: string, payload: string, source: string): AuthEntry {
  const parsed = parseJsonPayload(serverName, payload, source);
  const entry = toAuthEntry(parsed);
  if (!entry) {
    throw new Error(`Failed to parse OAuth credentials for ${serverName} from ${source}: invalid credential shape`);
  }
  return entry;
}

function toAuthEntry(value: unknown): AuthEntry | undefined {
  const entry = toRecord(value);
  if (!entry) return undefined;

  const codeVerifier = optionalString(entry.codeVerifier);
  const oauthState = optionalString(entry.oauthState);
  const serverUrl = optionalString(entry.serverUrl);
  if (codeVerifier === null || oauthState === null || serverUrl === null) return undefined;

  const tokens = entry.tokens === undefined ? undefined : toStoredTokens(entry.tokens);
  const clientInfo = entry.clientInfo === undefined ? undefined : toStoredClientInfo(entry.clientInfo);
  if ((entry.tokens !== undefined && !tokens) || (entry.clientInfo !== undefined && !clientInfo)) return undefined;

  const authEntry: AuthEntry = {};
  if (tokens) authEntry.tokens = tokens;
  if (clientInfo) authEntry.clientInfo = clientInfo;
  if (codeVerifier !== undefined) authEntry.codeVerifier = codeVerifier;
  if (oauthState !== undefined) authEntry.oauthState = oauthState;
  if (serverUrl !== undefined) authEntry.serverUrl = serverUrl;
  return authEntry;
}

function toStoredTokens(value: unknown): StoredTokens | undefined {
  const tokens = toRecord(value);
  if (!tokens || typeof tokens.accessToken !== 'string') return undefined;

  const refreshToken = optionalString(tokens.refreshToken);
  const scope = optionalString(tokens.scope);
  const issuer = optionalString(tokens.issuer);
  const expiresAt = optionalNumber(tokens.expiresAt);
  if (refreshToken === null || scope === null || issuer === null || expiresAt === null) return undefined;

  const storedTokens: StoredTokens = { accessToken: tokens.accessToken };
  if (refreshToken !== undefined) storedTokens.refreshToken = refreshToken;
  if (expiresAt !== undefined) storedTokens.expiresAt = expiresAt;
  if (scope !== undefined) storedTokens.scope = scope;
  if (issuer !== undefined) storedTokens.issuer = issuer;
  return storedTokens;
}

function toStoredClientInfo(value: unknown): StoredClientInfo | undefined {
  const clientInfo = toRecord(value);
  if (!clientInfo || typeof clientInfo.clientId !== 'string') return undefined;

  const clientSecret = optionalString(clientInfo.clientSecret);
  const issuer = optionalString(clientInfo.issuer);
  const clientIdIssuedAt = optionalNumber(clientInfo.clientIdIssuedAt);
  const clientSecretExpiresAt = optionalNumber(clientInfo.clientSecretExpiresAt);
  const configPreRegistered = optionalBoolean(clientInfo.configPreRegistered);
  if (clientSecret === null || issuer === null || clientIdIssuedAt === null || clientSecretExpiresAt === null || configPreRegistered === null) return undefined;

  const storedClient: StoredClientInfo = { clientId: clientInfo.clientId };
  const redirectUris = stringArray(clientInfo.redirectUris);
  if (clientSecret !== undefined) storedClient.clientSecret = clientSecret;
  if (clientIdIssuedAt !== undefined) storedClient.clientIdIssuedAt = clientIdIssuedAt;
  if (clientSecretExpiresAt !== undefined) storedClient.clientSecretExpiresAt = clientSecretExpiresAt;
  if (redirectUris !== undefined) storedClient.redirectUris = redirectUris;
  if (issuer !== undefined) storedClient.issuer = issuer;
  if (configPreRegistered !== undefined) storedClient.configPreRegistered = configPreRegistered;
  return storedClient;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? value : null;
}

function optionalBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? value : null;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(uri => typeof uri === 'string') ? value : undefined;
}

function isAuthEntryChunkManifest(value: unknown): value is AuthEntryChunkManifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Partial<AuthEntryChunkManifest>;
  return manifest[AUTH_CHUNK_MANIFEST_KEY] === 1
    && typeof manifest.chunkCount === 'number'
    && Number.isInteger(manifest.chunkCount)
    && manifest.chunkCount > 0
    && typeof manifest.chunkDigest === 'string'
    && /^[a-f0-9]{16}$/.test(manifest.chunkDigest);
}

function getAuthEntryChunkAccount(account: string, manifest: AuthEntryChunkManifest, index: number): string {
  return `${account}.chunk.${manifest.chunkDigest}.${index}`;
}

function getAuthEntryChunkAccounts(account: string, manifest: AuthEntryChunkManifest): string[] {
  return Array.from({ length: manifest.chunkCount }, (_, index) => getAuthEntryChunkAccount(account, manifest, index));
}

function readChunkManifestFromPayload(serverName: string, payload: string, source: string): AuthEntryChunkManifest | undefined {
  const parsed = parseJsonPayload(serverName, payload, source);
  return isAuthEntryChunkManifest(parsed) ? parsed : undefined;
}

function readExistingChunkManifest(store: AuthSecretStore, serverName: string, account: string): AuthEntryChunkManifest | undefined {
  try {
    const payload = store.read(account);
    return payload === undefined ? undefined : readChunkManifestFromPayload(serverName, payload, 'OS secure credential store');
  } catch {
    return undefined;
  }
}

function removeChunkPayloads(store: AuthSecretStore, account: string, manifest: AuthEntryChunkManifest): void {
  for (const chunkAccount of getAuthEntryChunkAccounts(account, manifest)) {
    store.remove(chunkAccount);
  }
}

function tryRemoveChunkPayloads(store: AuthSecretStore, account: string, manifest: AuthEntryChunkManifest | undefined): void {
  if (!manifest) return;
  try {
    removeChunkPayloads(store, account, manifest);
  } catch {
    // Stale chunk cleanup must not hide a successful credential write.
  }
}

function createChunkManifest(payload: string): AuthEntryChunkManifest {
  return {
    [AUTH_CHUNK_MANIFEST_KEY]: 1,
    chunkCount: Math.ceil(payload.length / AUTH_SECRET_CHUNK_SIZE),
    chunkDigest: createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16),
  };
}

function readChunkedAuthEntry(store: AuthSecretStore, serverName: string, account: string, manifest: AuthEntryChunkManifest): AuthEntry {
  const chunks = getAuthEntryChunkAccounts(account, manifest).map((chunkAccount) => {
    try {
      const chunk = store.read(chunkAccount);
      if (chunk === undefined) {
        throw new Error(`Missing OAuth credential chunk ${chunkAccount} for ${serverName}`);
      }
      return chunk;
    } catch (error) {
      throw new OAuthCredentialStoreError(
        `Failed to read OAuth credentials for ${serverName} from the OS secure credential store`,
        'read',
        error,
      );
    }
  });
  return parseAuthEntryPayload(serverName, chunks.join(''), 'OS secure credential store chunks');
}

function readLegacyAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
  const filePath = getAuthEntryFilePath(serverName, options);
  if (!existsSync(filePath)) return undefined;
  const data = readFileSync(filePath, 'utf-8');
  return parseAuthEntryPayload(serverName, data, filePath);
}

function removeLegacyAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  const filePath = getAuthEntryFilePath(serverName, options);
  if (!existsSync(filePath)) return;
  try {
    rmSync(filePath, { force: true });
  } catch (error) {
    throw new Error(`Failed to remove legacy plaintext OAuth credentials for ${serverName} at ${filePath}`, { cause: error });
  }

  const dir = getServerDir(serverName, options);
  try {
    rmSync(dir, { recursive: true });
  } catch {
    // Directory may contain future non-secret metadata; the plaintext file was already removed.
  }
}

function writeSecureAuthEntryToStore(store: AuthSecretStore, serverName: string, entry: AuthEntry): void {
  const account = getAuthEntryAccount(serverName);
  const payload = JSON.stringify(entry);
  const previousManifest = readExistingChunkManifest(store, serverName, account);
  const manifest = payload.length > AUTH_SECRET_CHUNK_SIZE ? createChunkManifest(payload) : undefined;

  try {
    if (manifest) {
      for (let index = 0; index < manifest.chunkCount; index++) {
        const chunk = payload.slice(index * AUTH_SECRET_CHUNK_SIZE, (index + 1) * AUTH_SECRET_CHUNK_SIZE);
        store.write(getAuthEntryChunkAccount(account, manifest, index), chunk);
      }
      store.write(account, JSON.stringify(manifest));
    } else {
      // Compact: multiline secrets corrupt gnome-keyring plaintext (GKeyFile) collections.
      store.write(account, payload);
    }
    if (previousManifest?.chunkDigest !== manifest?.chunkDigest) {
      tryRemoveChunkPayloads(store, account, previousManifest);
    }
  } catch (error) {
    tryRemoveChunkPayloads(store, account, manifest);
    throw new OAuthCredentialStoreError(
      `Failed to write OAuth credentials for ${serverName} to the OS secure credential store`,
      'write',
      error,
    );
  }

  publishAuthEntryToCache(serverName, payload);
}

function publishAuthEntryToCache(serverName: string, payload: string): void {
  if (!isAuthEntryCacheEnabled()) return;
  // Cache the same normalized shape a fresh persistent-store read returns.
  const normalized = toAuthEntry(JSON.parse(payload) as unknown);
  if (!normalized) {
    authEntryCache.delete(serverName);
    return;
  }
  authEntryCache.set(serverName, cloneAuthEntry(normalized));
}

function writeSecureAuthEntry(serverName: string, entry: AuthEntry): void {
  try {
    writeSecureAuthEntryToStore(getAuthSecretStore(), serverName, entry);
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) throw error;
    writeSecureAuthEntryToStore(linuxKeyringRecoveryAuthSecretStore, serverName, entry);
  }
}

/**
 * Read the auth entry for a server from the OS secure store, importing and
 * deleting a legacy plaintext entry when present.
 */
function readAuthEntryFromStore(
  store: AuthSecretStore,
  serverName: string,
  options?: AuthStorageOptions,
  behavior: { migrateLegacy?: boolean } = {},
): AuthEntry | undefined {
  const account = getAuthEntryAccount(serverName);
  let payload: string | undefined;
  try {
    payload = store.read(account);
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to read OAuth credentials for ${serverName} from the OS secure credential store`,
      'read',
      error,
    );
  }

  if (payload !== undefined) {
    const manifest = readChunkManifestFromPayload(serverName, payload, 'OS secure credential store');
    const entry = manifest
      ? readChunkedAuthEntry(store, serverName, account, manifest)
      : parseAuthEntryPayload(serverName, payload, 'OS secure credential store');
    removeLegacyAuthEntry(serverName, options);
    return entry;
  }

  const legacyEntry = readLegacyAuthEntry(serverName, options);
  if (!legacyEntry) return undefined;
  if (behavior.migrateLegacy === false) return legacyEntry;
  writeSecureAuthEntryToStore(store, serverName, legacyEntry);
  removeLegacyAuthEntry(serverName, options);
  return legacyEntry;
}

function readAuthEntry(
  serverName: string,
  options?: AuthStorageOptions,
  behavior: { migrateLegacy?: boolean } = {},
): AuthEntry | undefined {
  // Status-only reads deliberately bypass the cache because they do not
  // migrate legacy entries.
  const cacheable = behavior.migrateLegacy !== false && isAuthEntryCacheEnabled();
  if (cacheable && authEntryCache.has(serverName)) {
    return cloneAuthEntry(authEntryCache.get(serverName));
  }

  let entry: AuthEntry | undefined;
  try {
    entry = readAuthEntryFromStore(getAuthSecretStore(), serverName, options, behavior);
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) throw error;
    entry = readAuthEntryFromStore(linuxKeyringRecoveryAuthSecretStore, serverName, options, behavior);
  }

  if (cacheable) authEntryCache.set(serverName, cloneAuthEntry(entry));
  return entry;
}

/**
 * Get auth entry for a server.
 */
export function getAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
  return readAuthEntry(serverName, options);
}

/**
 * Get auth entry and validate it's for the correct URL.
 * Returns undefined if URL has changed (credentials are invalid).
 */
export function getAuthForUrl(serverName: string, serverUrl: string, options?: AuthStorageOptions): AuthEntry | undefined {
  const entry = getAuthEntry(serverName, options);
  if (!entry) return undefined;

  // If no serverUrl is stored, this is from an old version - consider it invalid
  if (!entry.serverUrl) return undefined;

  // If URL has changed, credentials are invalid
  if (entry.serverUrl !== serverUrl) return undefined;

  return entry;
}

/**
 * Inspect credentials for status-only UI paths without treating an unavailable
 * secure store as missing credentials. Authentication operations continue to
 * use getAuthForUrl() directly and therefore remain fail-closed.
 */
export function inspectAuthForUrl(
  serverName: string,
  serverUrl: string,
  options?: AuthStorageOptions,
): OAuthCredentialStatus {
  try {
    const entry = readAuthEntry(serverName, options, { migrateLegacy: false });
    if (!entry?.serverUrl || entry.serverUrl !== serverUrl) return { status: 'absent' };
    return { status: 'present', entry };
  } catch (error) {
    if (!(error instanceof OAuthCredentialStoreError)) throw error;
    return { status: 'unavailable', message: formatOAuthCredentialStoreUnavailable(error) };
  }
}

/**
 * Save auth entry for a server.
 */
export function saveAuthEntry(serverName: string, entry: AuthEntry, serverUrl?: string, options?: AuthStorageOptions): void {
  // Always update serverUrl if provided
  if (serverUrl) {
    entry.serverUrl = serverUrl;
  }
  writeSecureAuthEntry(serverName, entry);
  removeLegacyAuthEntry(serverName, options);
}

/**
 * Remove auth entry for a server.
 */
function removeAuthEntryFromStore(store: AuthSecretStore, serverName: string): void {
  const account = getAuthEntryAccount(serverName);
  try {
    const payload = store.read(account);
    const manifest = payload === undefined ? undefined : readChunkManifestFromPayload(serverName, payload, 'OS secure credential store');
    if (manifest) removeChunkPayloads(store, account, manifest);
    store.remove(account);
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to remove OAuth credentials for ${serverName} from the OS secure credential store`,
      'remove',
      error,
    );
  }
}

export function removeAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  try {
    removeAuthEntryFromStore(getAuthSecretStore(), serverName);
  } catch (error) {
    if (!shouldAttemptLinuxKeyringRecovery(error)) throw error;
    removeAuthEntryFromStore(linuxKeyringRecoveryAuthSecretStore, serverName);
  }
  authEntryCache.delete(serverName);
  removeLegacyAuthEntry(serverName, options);
}

/**
 * Forget a cached entry so the next ordinary read reloads secure storage.
 */
export function invalidateAuthEntryCache(serverName: string): void {
  authEntryCache.delete(serverName);
}

/**
 * Update tokens for a server.
 */
export function updateTokens(
  serverName: string,
  tokens: StoredTokens,
  serverUrl?: string,
  options?: AuthStorageOptions
): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.clientInfo;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.tokens = tokens;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Update client info for a server.
 */
export function updateClientInfo(
  serverName: string,
  clientInfo: StoredClientInfo,
  serverUrl?: string,
  options?: AuthStorageOptions
): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.clientInfo = clientInfo;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Update code verifier for a server.
 */
export function updateCodeVerifier(serverName: string, codeVerifier: string, serverUrl?: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.oauthState;
  }
  entry.codeVerifier = codeVerifier;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Clear code verifier for a server.
 */
export function clearCodeVerifier(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.codeVerifier;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}

/**
 * Update OAuth state for a server.
 */
export function updateOAuthState(serverName: string, state: string, serverUrl?: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.codeVerifier;
  }
  entry.oauthState = state;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Get OAuth state for a server.
 */
export function getOAuthState(serverName: string, options?: AuthStorageOptions): string | undefined {
  const entry = getAuthEntry(serverName, options);
  return entry?.oauthState;
}

/**
 * Clear OAuth state for a server.
 */
export function clearOAuthState(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.oauthState;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}

/**
 * Check if stored tokens are expired.
 * Returns null if no tokens exist, false if no expiry or not expired, true if expired.
 */
export function isTokenExpired(serverName: string, options?: AuthStorageOptions): boolean | null {
  const entry = getAuthEntry(serverName, options);
  if (!entry?.tokens) return null;
  if (!entry.tokens.expiresAt) return false;
  return entry.tokens.expiresAt < Date.now() / 1000;
}

/**
 * Check if a server has stored tokens.
 */
export function hasStoredTokens(serverName: string, options?: AuthStorageOptions): boolean {
  const entry = getAuthEntry(serverName, options);
  return !!entry?.tokens;
}

/**
 * Clear all credentials for a server.
 */
export function clearAllCredentials(serverName: string, options?: AuthStorageOptions): void {
  removeAuthEntry(serverName, options);
}

/**
 * Clear only client info for a server.
 */
export function clearClientInfo(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.clientInfo;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}

/**
 * Clear only tokens for a server.
 */
export function clearTokens(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.tokens;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}
