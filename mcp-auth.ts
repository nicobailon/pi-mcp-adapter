/**
 * MCP Auth Storage Module
 *
 * Handles secure storage of OAuth credentials, tokens, client information,
 * and legacy PKCE state for MCP servers.
 *
 * Persistent OAuth entries are stored in the operating system credential store
 * unless the externally keyed encrypted-file backend is explicitly selected.
 * The default backend imports and removes legacy plaintext entries from
 * $MCP_OAUTH_DIR or <Pi agent dir>/mcp-oauth.
 */

import { spawnSync } from 'child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { createRequire } from 'module';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
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
const OAUTH_FILE_KEY_ENV = 'PI_MCP_ADAPTER_OAUTH_FILE_KEY';
const ENCRYPTED_FILE_AAD_CONTEXT = 'pi-mcp-adapter.oauth.encrypted-file.v1';

export type OAuthAuthority = () => void;

type OAuthLifecycleRecord = {
  generation: object;
  revocations: number;
};

const oauthLifecycleRecords = new Map<string, OAuthLifecycleRecord>();

function getOAuthLifecycleRecord(serverName: string): OAuthLifecycleRecord {
  let record = oauthLifecycleRecords.get(serverName);
  if (!record) {
    record = { generation: {}, revocations: 0 };
    oauthLifecycleRecords.set(serverName, record);
  }
  return record;
}

/** Capture immutable process-local authority for one server's OAuth lifecycle. */
export function captureOAuthAuthority(serverName: string, assertNow = true): OAuthAuthority {
  const record = getOAuthLifecycleRecord(serverName);
  const generation = record.generation;
  const capturedDuringRevocation = record.revocations > 0;
  const assertAuthority = (): void => {
    if (capturedDuringRevocation || record.generation !== generation || record.revocations > 0) {
      throw new Error('OAuth flow is no longer active');
    }
  };
  if (assertNow) assertAuthority();
  return assertAuthority;
}

/** Begin an overlap-safe process-local logout interval. */
export function beginOAuthRevocation(serverName: string): () => void {
  const record = getOAuthLifecycleRecord(serverName);
  record.generation = {};
  record.revocations += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    record.revocations -= 1;
  };
}

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
  credentialStore?: 'encrypted-file';
}

export class OAuthCredentialStoreError extends Error {
  readonly code = 'OAUTH_CREDENTIAL_STORE_UNAVAILABLE';

  constructor(
    message: string,
    readonly operation: 'read' | 'write' | 'remove',
    cause: unknown,
    readonly backend?: 'encrypted-file',
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
  if (error.backend === 'encrypted-file') {
    if (causeChainContains(error, /PI_MCP_ADAPTER_OAUTH_FILE_KEY/)) {
      return 'Encrypted OAuth credential file store unavailable. Set PI_MCP_ADAPTER_OAUTH_FILE_KEY to canonical base64 for exactly 32 random bytes and retry.';
    }
    return 'Encrypted OAuth credential file store unavailable. Check the encrypted credential file and key, then reauthenticate.';
  }
  if (process.platform === 'linux' && causeChainContains(error, /key\s*(?:has been\s*)?revoked|keyrevoked/i)) {
    return 'OAuth credential store unavailable: the Linux session keyring may be revoked. Start Pi from a fresh login/keyring session and retry.';
  }
  if (causeChainContains(error, /ERROR_NO_SUCH_LOGON_SESSION|\b1312\b/i)) {
    return 'OAuth credential store unavailable: Windows Credential Manager is unavailable from this network logon. To opt in to encrypted file storage for OpenSSH/headless use, set settings.oauthCredentialStore to "encrypted-file" and provide PI_MCP_ADAPTER_OAUTH_FILE_KEY.';
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
  readonly kind?: 'encrypted-file';
  read(account: string): string | undefined;
  write(account: string, payload: string): void;
  remove(account: string): void;
}

function authSecretStoreLabel(store: AuthSecretStore): string {
  return store.kind === 'encrypted-file' ? 'encrypted OAuth credential file store' : 'OS secure credential store';
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

const writeFailingAuthSecretStore: AuthSecretStore = {
  ...memoryAuthSecretStore,
  write() {
    throw new Error('simulated secure credential store write failure');
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

export function setTestAuthSecretStoreEntry(account: string, payload: string): void {
  memoryAuthEntries.set(account, payload);
}

function decodeCanonicalBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('value is not canonical base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new Error(expectedBytes === undefined ? 'value is not canonical base64' : `value must decode to exactly ${expectedBytes} bytes`);
  }
  return decoded;
}

function getEncryptedFileKey(): Buffer {
  const encoded = process.env[OAUTH_FILE_KEY_ENV];
  if (!encoded) throw new Error(`${OAUTH_FILE_KEY_ENV} is required for the encrypted OAuth credential file store`);
  try {
    return decodeCanonicalBase64(encoded, 32);
  } catch (error) {
    throw new Error(`${OAUTH_FILE_KEY_ENV} must be canonical base64 for exactly 32 random bytes`, { cause: error });
  }
}

function encryptedEntryPath(root: string, account: string): string {
  return join(root, account, 'credentials.json');
}

function validatePrivateRegularFile(path: string): boolean {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular OAuth credential file at ${path}`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`OAuth credential file has group or other permissions at ${path}`);
  }
  return true;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing non-directory OAuth credential path at ${path}`);
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function createEncryptedFileAuthSecretStore(): AuthSecretStore {
  const root = getAgentPath('mcp-oauth-encrypted');
  return {
    kind: 'encrypted-file',
    read(account) {
      const key = getEncryptedFileKey();
      const path = encryptedEntryPath(root, account);
      if (!validatePrivateRegularFile(path)) return undefined;
      const envelope = parseJsonPayload(account, readFileSync(path, 'utf8'), path) as Record<string, unknown>;
      if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
        throw new Error(`Unsupported encrypted OAuth credential envelope at ${path}`);
      }
      const iv = decodeCanonicalBase64(envelope.iv, 12);
      const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
      const tag = decodeCanonicalBase64(envelope.tag, 16);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(`${ENCRYPTED_FILE_AAD_CONTEXT}\0${account}`, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
    write(account, payload) {
      const key = getEncryptedFileKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${ENCRYPTED_FILE_AAD_CONTEXT}\0${account}`, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
      const envelope = JSON.stringify({
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      });
      const dir = join(root, account);
      ensurePrivateDirectory(root);
      ensurePrivateDirectory(dir);
      const destination = encryptedEntryPath(root, account);
      validatePrivateRegularFile(destination);
      const temporary = join(dir, `.credentials-${randomBytes(12).toString('hex')}.tmp`);
      let fd: number | undefined;
      try {
        fd = openSync(temporary, 'wx', 0o600);
        writeFileSync(fd, envelope, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temporary, destination);
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch {}
        }
        try { rmSync(temporary, { force: true }); } catch {}
        throw error;
      }
    },
    remove(account) {
      getEncryptedFileKey();
      const path = encryptedEntryPath(root, account);
      if (!validatePrivateRegularFile(path)) return;
      rmSync(path);
      try { rmSync(dirname(path)); } catch {}
    },
  };
}

function getAuthSecretStore(options: AuthStorageOptions = {}): AuthSecretStore {
  if (options.credentialStore === 'encrypted-file') return createEncryptedFileAuthSecretStore();
  if (process.env[TEST_AUTH_STORE_ENV] === 'memory') return memoryAuthSecretStore;
  if (process.env[TEST_AUTH_STORE_ENV] === 'sizelimited') return sizeLimitedAuthSecretStore;
  if (process.env[TEST_AUTH_STORE_ENV] === 'writefailing') return writeFailingAuthSecretStore;
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

export function getAuthStorageOptions(oauthDir: unknown, cwd = process.cwd(), oauthCredentialStore?: unknown): AuthStorageOptions {
  if (oauthCredentialStore !== undefined && oauthCredentialStore !== 'encrypted-file') {
    throw new Error('settings.oauthCredentialStore must be "encrypted-file" when set');
  }
  if (oauthCredentialStore === 'encrypted-file') return { credentialStore: 'encrypted-file' };
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
    return payload === undefined ? undefined : readChunkManifestFromPayload(serverName, payload, authSecretStoreLabel(store));
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

function shouldChunkAuthPayload(store: AuthSecretStore, payload: string): boolean {
  return store.kind !== 'encrypted-file' && payload.length > AUTH_SECRET_CHUNK_SIZE
    && (process.platform === 'win32' || process.env[TEST_AUTH_STORE_ENV] === 'sizelimited');
}

function getAuthEntryChunkDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16);
}

function splitAuthPayload(payload: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < payload.length;) {
    let end = Math.min(start + AUTH_SECRET_CHUNK_SIZE, payload.length);
    const lastCodeUnit = payload.charCodeAt(end - 1);
    if (end < payload.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
    chunks.push(payload.slice(start, end));
    start = end;
  }
  return chunks;
}

function createChunkManifest(payload: string, chunkCount: number): AuthEntryChunkManifest {
  return {
    [AUTH_CHUNK_MANIFEST_KEY]: 1,
    chunkCount,
    chunkDigest: getAuthEntryChunkDigest(payload),
  };
}

function readChunkedAuthEntry(store: AuthSecretStore, serverName: string, account: string, manifest: AuthEntryChunkManifest): AuthEntry {
  let payload: string;
  try {
    payload = getAuthEntryChunkAccounts(account, manifest).map((chunkAccount) => {
      const chunk = store.read(chunkAccount);
      if (chunk === undefined) {
        throw new Error(`Missing OAuth credential chunk ${chunkAccount} for ${serverName}`);
      }
      return chunk;
    }).join('');
    if (getAuthEntryChunkDigest(payload) !== manifest.chunkDigest) {
      throw new Error('OAuth credential chunk integrity check failed');
    }
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to read OAuth credentials for ${serverName} from the ${authSecretStoreLabel(store)}`,
      'read',
      error,
    );
  }
  return parseAuthEntryPayload(serverName, payload, `${authSecretStoreLabel(store)} chunks`);
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
  const chunks = shouldChunkAuthPayload(store, payload) ? splitAuthPayload(payload) : undefined;
  const manifest = chunks ? createChunkManifest(payload, chunks.length) : undefined;

  try {
    if (manifest && chunks) {
      for (const [index, chunk] of chunks.entries()) {
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
      `Failed to write OAuth credentials for ${serverName} to the ${authSecretStoreLabel(store)}`,
      'write',
      error,
      store.kind,
    );
  }
}

function authEntryCacheKey(
  serverName: string,
  options: AuthStorageOptions = {},
  operation: 'read' | 'write' | 'remove' = 'read',
): string {
  if (options.credentialStore !== 'encrypted-file') return `os\0${serverName}`;
  try {
    const generation = createHash('sha256').update(getEncryptedFileKey()).digest('hex');
    return `encrypted-file:${generation}\0${serverName}`;
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to ${operation} OAuth credentials for ${serverName} with the encrypted OAuth credential file store`,
      operation,
      error,
      'encrypted-file',
    );
  }
}

function publishAuthEntryToCache(serverName: string, payload: string, options?: AuthStorageOptions): void {
  if (!isAuthEntryCacheEnabled()) return;
  const cacheKey = authEntryCacheKey(serverName, options, 'write');
  // Cache the same normalized shape a fresh persistent-store read returns.
  const normalized = toAuthEntry(JSON.parse(payload) as unknown);
  if (!normalized) {
    authEntryCache.delete(cacheKey);
    return;
  }
  authEntryCache.set(cacheKey, cloneAuthEntry(normalized));
}

function writeSecureAuthEntry(serverName: string, entry: AuthEntry, options?: AuthStorageOptions): void {
  try {
    writeSecureAuthEntryToStore(getAuthSecretStore(options), serverName, entry);
  } catch (error) {
    if (options?.credentialStore === 'encrypted-file' || !shouldAttemptLinuxKeyringRecovery(error)) throw error;
    writeSecureAuthEntryToStore(linuxKeyringRecoveryAuthSecretStore, serverName, entry);
  }
  publishAuthEntryToCache(serverName, JSON.stringify(entry), options);
}

/**
 * Read from the selected store. The OS backend imports and deletes a legacy
 * plaintext entry when present.
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
      `Failed to read OAuth credentials for ${serverName} from the ${authSecretStoreLabel(store)}`,
      'read',
      error,
      store.kind,
    );
  }

  if (payload !== undefined) {
    const manifest = store.kind === 'encrypted-file'
      ? undefined
      : readChunkManifestFromPayload(serverName, payload, authSecretStoreLabel(store));
    const entry = manifest
      ? readChunkedAuthEntry(store, serverName, account, manifest)
      : parseAuthEntryPayload(serverName, payload, authSecretStoreLabel(store));
    if (store.kind !== 'encrypted-file') removeLegacyAuthEntry(serverName, options);
    if (manifest && behavior.migrateLegacy !== false && !shouldChunkAuthPayload(store, JSON.stringify(entry))) {
      writeSecureAuthEntryToStore(store, serverName, entry);
    }
    return entry;
  }

  if (store.kind === 'encrypted-file') return undefined;
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
  const cacheKey = authEntryCacheKey(serverName, options);
  if (cacheable && authEntryCache.has(cacheKey)) {
    return cloneAuthEntry(authEntryCache.get(cacheKey));
  }

  let entry: AuthEntry | undefined;
  try {
    entry = readAuthEntryFromStore(getAuthSecretStore(options), serverName, options, behavior);
  } catch (error) {
    if (options?.credentialStore === 'encrypted-file' || !shouldAttemptLinuxKeyringRecovery(error)) throw error;
    entry = readAuthEntryFromStore(linuxKeyringRecoveryAuthSecretStore, serverName, options, behavior);
  }

  if (cacheable) authEntryCache.set(cacheKey, cloneAuthEntry(entry));
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
  writeSecureAuthEntry(serverName, entry, options);
  if (options?.credentialStore !== 'encrypted-file') removeLegacyAuthEntry(serverName, options);
}

/**
 * Remove auth entry for a server.
 */
function removeAuthEntryFromStore(store: AuthSecretStore, serverName: string): void {
  const account = getAuthEntryAccount(serverName);
  try {
    if (store.kind === 'encrypted-file') {
      store.remove(account);
      return;
    }
    const payload = store.read(account);
    const manifest = payload === undefined ? undefined : readChunkManifestFromPayload(serverName, payload, authSecretStoreLabel(store));
    if (manifest) removeChunkPayloads(store, account, manifest);
    store.remove(account);
  } catch (error) {
    throw new OAuthCredentialStoreError(
      `Failed to remove OAuth credentials for ${serverName} from the ${authSecretStoreLabel(store)}`,
      'remove',
      error,
      store.kind,
    );
  }
}

export function removeAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  try {
    removeAuthEntryFromStore(getAuthSecretStore(options), serverName);
  } catch (error) {
    if (options?.credentialStore === 'encrypted-file' || !shouldAttemptLinuxKeyringRecovery(error)) throw error;
    removeAuthEntryFromStore(linuxKeyringRecoveryAuthSecretStore, serverName);
  }
  evictAuthEntryCache(serverName, options);
  if (options?.credentialStore !== 'encrypted-file') removeLegacyAuthEntry(serverName, options);
}

function evictAuthEntryCache(serverName: string, options: AuthStorageOptions = {}): void {
  if (options.credentialStore !== 'encrypted-file') {
    authEntryCache.delete(authEntryCacheKey(serverName, options, 'remove'));
    return;
  }
  for (const key of authEntryCache.keys()) {
    const separator = key.indexOf('\0');
    if (key.startsWith('encrypted-file:') && separator !== -1 && key.slice(separator + 1) === serverName) authEntryCache.delete(key);
  }
}

/**
 * Forget a cached entry so the next ordinary read reloads secure storage.
 */
export function invalidateAuthEntryCache(serverName: string): void {
  evictAuthEntryCache(serverName);
  evictAuthEntryCache(serverName, { credentialStore: 'encrypted-file' });
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
