import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SecureKeyringStore {
  read(account: string): string | undefined;
  write(account: string, payload: string): void;
  remove(account: string): void;
}

type KeyringEntry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
};
type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntry;
type KeyringModule = { Entry: KeyringEntryConstructor };
type KeyringRequire = ((id: string) => unknown) & { resolve(id: string): string };

const require = createRequire(import.meta.url);
const TEST_STORE_ENV = "PI_MCP_ADAPTER_TEST_AUTH_STORE";
const memoryEntries = new Map<string, string>();
let memoryReadCount = 0;
let KeyringEntryClass: KeyringEntryConstructor | undefined;

function key(service: string, account: string): string {
  return `${service}\0${account}`;
}

function nativeStore(service: string): SecureKeyringStore {
  const entry = (account: string): KeyringEntry => {
    try {
      KeyringEntryClass ??= loadKeyringEntryClass();
      return new KeyringEntryClass(service, account);
    } catch (error) {
      throw new Error("OS secure credential storage is unavailable. Configure or unlock the OS credential store and retry.", { cause: error });
    }
  };
  const run = (operation: "read" | "write" | "remove", account: string, payload?: string): string | undefined => {
    try {
      const credential = entry(account);
      if (operation === "read") return credential.getPassword() ?? undefined;
      if (operation === "write") credential.setPassword(payload!);
      else credential.deleteCredential();
      return undefined;
    } catch (error) {
      if (!shouldRecoverKeyring(error)) throw error;
      return recoverKeyring(operation, service, account, payload);
    }
  };
  return {
    read: account => run("read", account),
    write: (account, payload) => { run("write", account, payload); },
    remove: account => { run("remove", account); },
  };
}

function shouldRecoverKeyring(error: unknown): boolean {
  if (process.platform !== "linux" || process.env.PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY === "1") return false;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 16 && error !== undefined && !seen.has(error); depth++) {
    seen.add(error);
    const candidate = typeof error === "object" && error !== null
      ? error as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown }
      : { message: error };
    if ([candidate.name, candidate.message, candidate.code].some(value =>
      typeof value === "string" && /\b(?:KeyRevoked|key\s+(?:has been\s+)?revoked)\b/i.test(value))) return true;
    error = candidate.cause;
  }
  return false;
}

function recoverKeyring(operation: "read" | "write" | "remove", service: string, account: string, payload?: string): string | undefined {
  try {
    const adjacentHelper = new URL("./mcp-keyring-helper.cjs", import.meta.url);
    const helper = existsSync(adjacentHelper) ? adjacentHelper : new URL("../mcp-keyring-helper.cjs", import.meta.url);
    const result = spawnSync("keyctl", ["session", "-", process.execPath, fileURLToPath(helper)], {
      input: `${JSON.stringify({ operation, service, account, payload })}\n`,
      encoding: "utf8",
      stdio: "pipe",
      shell: false,
      timeout: 10_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || result.signal) throw new Error();
    const response: unknown = JSON.parse(result.stdout);
    if (typeof response !== "object" || response === null || Array.isArray(response)) throw new Error();
    const value = response as { ok?: unknown; found?: unknown; value?: unknown };
    if (value.ok !== true) throw new Error();
    const allowedKeys = operation === "read" ? ["ok", "found", "value"] : ["ok"];
    if (Object.keys(response).some(key => !allowedKeys.includes(key))) throw new Error();
    if (operation === "read") {
      if (value.found === true && typeof value.value === "string") return value.value;
      if (value.found === false && value.value === undefined) return undefined;
      throw new Error();
    }
    return undefined;
  } catch {
    throw new Error("Linux keyring recovery failed. Configure or unlock the OS credential store and retry.");
  }
}

export function createSecureKeyringStore(service: string): SecureKeyringStore {
  const mode = process.env[TEST_STORE_ENV];
  if (mode === "memory" || mode === "sizelimited") {
    return {
      read(account) { memoryReadCount++; return memoryEntries.get(key(service, account)); },
      write(account, payload) {
        if (mode === "sizelimited" && payload.length > 1280) throw new Error("secure credential value exceeds platform limit");
        memoryEntries.set(key(service, account), payload);
      },
      remove(account) { memoryEntries.delete(key(service, account)); },
    };
  }
  if (mode === "unavailable") {
    return {
      read() { memoryReadCount++; throw new Error("simulated secure credential store unavailable"); },
      write() { throw new Error("simulated secure credential store unavailable"); },
      remove() { throw new Error("simulated secure credential store unavailable"); },
    };
  }
  return nativeStore(service);
}

function loadKeyringEntryClass(keyringRequire: KeyringRequire = require, platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): KeyringEntryConstructor {
  try {
    return (keyringRequire("@napi-rs/keyring") as KeyringModule).Entry;
  } catch (loaderError) {
    try {
      return loadKeyringNativeBindingFallback(keyringRequire, platform, arch).Entry;
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Failed to load @napi-rs/keyring; absolute-path native binding fallback also failed: ${message}`, { cause: loaderError });
    }
  }
}

function loadKeyringNativeBindingFallback(keyringRequire: KeyringRequire, platform: NodeJS.Platform, arch: NodeJS.Architecture): KeyringModule {
  let lastError: unknown;
  for (const suffix of getKeyringNativeBindingSuffixes(platform, arch)) {
    try {
      const packageName = `@napi-rs/keyring-${suffix}`;
      const packageJsonPath = keyringRequire.resolve(`${packageName}/package.json`);
      return keyringRequire(join(dirname(packageJsonPath), `keyring.${suffix}.node`)) as KeyringModule;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function getKeyringNativeBindingSuffixes(platform: NodeJS.Platform, arch: NodeJS.Architecture): string[] {
  if (platform === "darwin") return arch === "arm64" ? ["darwin-arm64"] : arch === "x64" ? ["darwin-x64"] : [];
  if (platform === "win32") return arch === "arm64" ? ["win32-arm64-msvc"] : arch === "x64" ? ["win32-x64-msvc"] : arch === "ia32" ? ["win32-ia32-msvc"] : [];
  if (platform === "linux") {
    if (arch === "arm64") return ["linux-arm64-gnu", "linux-arm64-musl"];
    if (arch === "arm") return ["linux-arm-gnueabihf"];
    if (arch === "riscv64") return ["linux-riscv64-gnu"];
    if (arch === "x64") return ["linux-x64-gnu", "linux-x64-musl"];
  }
  return platform === "freebsd" && arch === "x64" ? ["freebsd-x64"] : [];
}

export function resetTestSecureKeyring(): void { memoryEntries.clear(); memoryReadCount = 0; }
export function getTestSecureKeyringReadCount(): number { return memoryReadCount; }
export function getTestSecureKeyringEntries(): [string, string][] { return [...memoryEntries.entries()]; }
export function setTestSecureKeyringEntry(service: string, account: string, payload: string): void { memoryEntries.set(key(service, account), payload); }
export function removeTestSecureKeyringEntry(service: string, account: string): void { memoryEntries.delete(key(service, account)); }
