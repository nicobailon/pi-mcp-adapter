import { createHash } from "node:crypto";
import { createSecureKeyringStore, getTestSecureKeyringEntries, getTestSecureKeyringReadCount, removeTestSecureKeyringEntry, resetTestSecureKeyring, setTestSecureKeyringEntry } from "./secure-keyring.ts";

type BearerSecretStore = {
  read(account: string): string | undefined;
  write(account: string, payload: string): void;
  remove(account: string): void;
};

interface StoredBearerTokenRecord {
  token: string;
  serverUrl: string;
}

interface BearerChunkManifest {
  __piMcpAdapterBearerChunked: 1;
  chunkCount: number;
  chunkDigest: string;
}

const BEARER_SECRET_SERVICE = "pi-mcp-adapter.bearer";
const BEARER_SECRET_CHUNK_SIZE = 1000;

export class BearerCredentialStoreError extends Error {
  readonly code = "BEARER_CREDENTIAL_STORE_UNAVAILABLE";
  readonly operation: "read" | "write" | "remove";

  constructor(message: string, operation: "read" | "write" | "remove", cause: unknown) {
    super(message, { cause });
    this.name = "BearerCredentialStoreError";
    this.operation = operation;
  }
}

export type BearerCredentialStatus =
  | { status: "present" }
  | { status: "missing" }
  | { status: "url-mismatch" }
  | { status: "unavailable"; message: string };

function getBearerSecretStore(): BearerSecretStore {
  return createSecureKeyringStore(BEARER_SECRET_SERVICE);
}

function getBearerAccount(serverName: string): string {
  if (typeof serverName !== "string") {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`;
}

function parseBearerPayload(serverName: string, payload: string): StoredBearerTokenRecord {
  const parsed = parseStoredBearerJson(serverName, payload);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Stored bearer token record for ${serverName} has invalid shape`);
  }
  const record = parsed as Partial<StoredBearerTokenRecord>;
  if (typeof record.token !== "string" || typeof record.serverUrl !== "string") {
    throw new Error(`Stored bearer token record for ${serverName} has invalid shape`);
  }
  return { token: record.token, serverUrl: record.serverUrl };
}

function parseStoredBearerJson(serverName: string, payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new Error(`Failed to parse stored bearer token record for ${serverName}`);
  }
}

function isBearerChunkManifest(value: unknown): value is BearerChunkManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<BearerChunkManifest>;
  return manifest.__piMcpAdapterBearerChunked === 1
    && typeof manifest.chunkCount === "number"
    && Number.isInteger(manifest.chunkCount)
    && manifest.chunkCount > 0
    && typeof manifest.chunkDigest === "string"
    && /^[a-f0-9]{16}$/.test(manifest.chunkDigest);
}

function readManifest(serverName: string, payload: string): BearerChunkManifest | undefined {
  const parsed = parseStoredBearerJson(serverName, payload);
  return isBearerChunkManifest(parsed) ? parsed : undefined;
}

function chunkAccount(account: string, manifest: BearerChunkManifest, index: number): string {
  return `${account}.chunk.${manifest.chunkDigest}.${index}`;
}

function chunkAccounts(account: string, manifest: BearerChunkManifest): string[] {
  return Array.from({ length: manifest.chunkCount }, (_, index) => chunkAccount(account, manifest, index));
}

function createManifest(payload: string): BearerChunkManifest {
  return {
    __piMcpAdapterBearerChunked: 1,
    chunkCount: Math.ceil(payload.length / BEARER_SECRET_CHUNK_SIZE),
    chunkDigest: createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16),
  };
}

function readExistingManifest(store: BearerSecretStore, serverName: string, account: string): BearerChunkManifest | undefined {
  try {
    const payload = store.read(account);
    return payload === undefined ? undefined : readManifest(serverName, payload);
  } catch {
    return undefined;
  }
}

function removeChunks(store: BearerSecretStore, account: string, manifest: BearerChunkManifest | undefined): void {
  if (!manifest) return;
  for (const accountName of chunkAccounts(account, manifest)) store.remove(accountName);
}

function tryRemoveChunks(store: BearerSecretStore, account: string, manifest: BearerChunkManifest | undefined): void {
  try {
    removeChunks(store, account, manifest);
  } catch {
    // Stale chunk cleanup must not hide a successful credential write.
  }
}

function readBearerRecordFromStore(store: BearerSecretStore, serverName: string): StoredBearerTokenRecord | undefined {
  const account = getBearerAccount(serverName);
  let payload: string | undefined;
  try {
    payload = store.read(account);
  } catch (error) {
    throw new BearerCredentialStoreError(
      `Failed to read bearer token for ${serverName} from the OS secure credential store`,
      "read",
      error,
    );
  }
  if (payload === undefined) return undefined;
  try {
    const manifest = readManifest(serverName, payload);
    const recordPayload = manifest
      ? chunkAccounts(account, manifest).map((chunkName) => {
        const chunk = store.read(chunkName);
        if (chunk === undefined) throw new Error(`Missing bearer token chunk for ${serverName}`);
        return chunk;
      }).join("")
      : payload;
    return parseBearerPayload(serverName, recordPayload);
  } catch (error) {
    throw new BearerCredentialStoreError(
      `Failed to read bearer token for ${serverName} from the OS secure credential store`,
      "read",
      error,
    );
  }
}

function writeBearerRecordToStore(store: BearerSecretStore, serverName: string, record: StoredBearerTokenRecord): void {
  const account = getBearerAccount(serverName);
  const payload = JSON.stringify(record);
  const previousManifest = readExistingManifest(store, serverName, account);
  const manifest = payload.length > BEARER_SECRET_CHUNK_SIZE ? createManifest(payload) : undefined;
  try {
    if (manifest) {
      for (let index = 0; index < manifest.chunkCount; index++) {
        store.write(chunkAccount(account, manifest, index), payload.slice(index * BEARER_SECRET_CHUNK_SIZE, (index + 1) * BEARER_SECRET_CHUNK_SIZE));
      }
      store.write(account, JSON.stringify(manifest));
    } else {
      store.write(account, payload);
    }
    if (previousManifest?.chunkDigest !== manifest?.chunkDigest) {
      tryRemoveChunks(store, account, previousManifest);
    }
  } catch (error) {
    // An identical payload reuses the previous manifest's digest-keyed chunk
    // accounts. Removing them on a failed rewrite would destroy the still
    // installed previous credential, so clean up only digest-distinct chunks.
    if (previousManifest?.chunkDigest !== manifest?.chunkDigest) {
      tryRemoveChunks(store, account, manifest);
    }
    throw new BearerCredentialStoreError(
      `Failed to write bearer token for ${serverName} to the OS secure credential store`,
      "write",
      error,
    );
  }
}

function removeBearerRecordFromStore(store: BearerSecretStore, serverName: string): void {
  const account = getBearerAccount(serverName);
  try {
    const payload = store.read(account);
    const manifest = payload === undefined ? undefined : readManifest(serverName, payload);
    removeChunks(store, account, manifest);
    store.remove(account);
  } catch (error) {
    throw new BearerCredentialStoreError(
      `Failed to remove bearer token for ${serverName} from the OS secure credential store`,
      "remove",
      error,
    );
  }
}

export function getBearerTokenForUrl(serverName: string, serverUrl: string): string | undefined {
  const record = readBearerRecordFromStore(getBearerSecretStore(), serverName);
  if (!record) return undefined;
  return record.serverUrl === serverUrl ? record.token : undefined;
}

export function saveBearerTokenForUrl(serverName: string, token: string, serverUrl: string): void {
  writeBearerRecordToStore(getBearerSecretStore(), serverName, { token, serverUrl });
}

export function removeBearerToken(serverName: string): void {
  removeBearerRecordFromStore(getBearerSecretStore(), serverName);
}

export function inspectBearerTokenForUrl(serverName: string, serverUrl: string): BearerCredentialStatus {
  try {
    const record = readBearerRecordFromStore(getBearerSecretStore(), serverName);
    if (!record) return { status: "missing" };
    if (record.serverUrl !== serverUrl) return { status: "url-mismatch" };
    return { status: "present" };
  } catch (error) {
    if (!(error instanceof BearerCredentialStoreError)) throw error;
    return { status: "unavailable", message: "Bearer token secure credential store unavailable. Configure or unlock the OS credential store and retry." };
  }
}

export function resetTestBearerTokenStore(): void {
  resetTestSecureKeyring();
}

export function getTestBearerTokenStoreEntries(): [string, string][] {
  return getTestSecureKeyringEntries().filter(([key]) => key.startsWith(`${BEARER_SECRET_SERVICE}\0`)).map(([key, value]) => [key.slice(BEARER_SECRET_SERVICE.length + 1), value]);
}

export function removeTestBearerTokenStoreEntry(account: string): void {
  removeTestSecureKeyringEntry(BEARER_SECRET_SERVICE, account);
}

export function setTestBearerTokenStoreEntry(account: string, payload: string): void {
  setTestSecureKeyringEntry(BEARER_SECRET_SERVICE, account, payload);
}

export function getTestBearerTokenStoreReadCount(): number {
  return getTestSecureKeyringReadCount();
}
