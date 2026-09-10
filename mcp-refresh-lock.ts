import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);

// Keychain accounts are shared across agent/import directories for this OS user.
export function sharedRefreshLockRoot(): string {
  return join(userInfo().homedir, ".pi-mcp-adapter");
}

interface RefreshLock {
  release(): void;
}

export async function acquireRefreshLock(
  serverName: string,
  baseDir: string,
  signal?: AbortSignal,
): Promise<RefreshLock> {
  signal?.throwIfAborted();
  const { tryLock } = require("fs-native-extensions") as { tryLock(fd: number): boolean };
  const root = join(baseDir, "refresh-locks-v2");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(serverName, "utf8").digest("hex");
  // Never unlink this inode: another process may already have it open.
  const fd = openSync(join(root, key), "a+", 0o600);
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };
  try {
    while (!tryLock(fd)) {
      await delay(50 + Math.floor(Math.random() * 50), undefined, { signal });
    }
    signal?.throwIfAborted();
    return { release };
  } catch (error) {
    release();
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
}

export async function withRefreshLock<T>(
  serverName: string,
  baseDir: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lock = await acquireRefreshLock(serverName, baseDir, signal);
  try {
    return await operation();
  } finally {
    lock.release();
  }
}
