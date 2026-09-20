import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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
  return {
    read: account => entry(account).getPassword() ?? undefined,
    write: (account, payload) => entry(account).setPassword(payload),
    remove: account => { entry(account).deleteCredential(); },
  };
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
