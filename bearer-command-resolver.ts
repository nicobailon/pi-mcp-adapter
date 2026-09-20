import { spawn } from "node:child_process";

const DEFAULT_TTL_MS = 5 * 60_000;
const ENV_TTL_MS = "PI_MCP_ADAPTER_BEARER_COMMAND_TTL_MS";
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
const USE_PROCESS_GROUP = process.platform !== "win32";

function resolveDefaultTtlMs(): number {
  const raw = process.env[ENV_TTL_MS];
  if (raw === undefined || raw === "") return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return parsed;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function runCommand(command: string, context: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    let settled = false;
    const child = spawn(command.slice(1), {
      shell: true,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      detached: USE_PROCESS_GROUP,
    });

    const kill = () => {
      if (child.pid === undefined) return;
      try {
        if (USE_PROCESS_GROUP) process.kill(-child.pid, "SIGKILL");
        else {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.unref();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const finish = (error: unknown, token?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(token!);
    };
    const onAbort = () => {
      kill();
      finish(abortReason(signal));
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error(`Failed to resolve ${context}: command timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    child.on("error", () => finish(new Error(`Failed to resolve ${context}: command failed to start`)));
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      output = Buffer.concat([output, Buffer.from(chunk)]);
      if (output.byteLength > COMMAND_MAX_OUTPUT_BYTES) {
        kill();
        finish(new Error(`Failed to resolve ${context}: command output exceeded 1 MiB`));
      }
    });
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`Failed to resolve ${context}: command exited with code ${code ?? "unknown"}`));
        return;
      }
      const token = output.toString("utf8").trim();
      if (!token) {
        finish(new Error(`Failed to resolve ${context}: command returned empty output`));
        return;
      }
      finish(undefined, token);
    });
  });
}

type Inflight = {
  controller: AbortController;
  promise: Promise<string>;
  waiters: number;
  done: boolean;
};

/** Resolve and periodically refresh one command-backed bearer token. */
export class BearerCommandResolver {
  readonly #command: string;
  readonly #context: string;
  readonly #ttlMs: number;
  #cached: { token: string; fetchedAt: number } | undefined;
  #failure: { error: unknown; retryAt: number } | undefined;
  #inflight: Inflight | undefined;

  constructor(command: string, context: string, ttlMs: number = resolveDefaultTtlMs()) {
    this.#command = command;
    this.#context = context;
    this.#ttlMs = ttlMs;
  }

  resolve(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const now = Date.now();
    if (this.#cached !== undefined && now - this.#cached.fetchedAt < this.#ttlMs) {
      return Promise.resolve(this.#cached.token);
    }
    if (this.#failure !== undefined && now < this.#failure.retryAt) {
      return this.#cached !== undefined
        ? Promise.resolve(this.#cached.token)
        : Promise.reject(this.#failure.error);
    }

    let inflight = this.#inflight;
    if (inflight === undefined) {
      const controller = new AbortController();
      inflight = { controller, promise: Promise.resolve(""), waiters: 0, done: false };
      const current = inflight;
      current.promise = runCommand(this.#command, this.#context, controller.signal)
        .then(token => {
          this.#cached = { token, fetchedAt: Date.now() };
          this.#failure = undefined;
          return token;
        })
        .catch(error => {
          this.#failure = { error, retryAt: Date.now() + this.#ttlMs };
          if (this.#cached !== undefined) return this.#cached.token;
          throw error;
        })
        .finally(() => {
          current.done = true;
          if (this.#inflight === current) this.#inflight = undefined;
        });
      this.#inflight = current;
    }
    return this.#wait(inflight, signal);
  }

  #wait(inflight: Inflight, signal?: AbortSignal): Promise<string> {
    inflight.waiters++;
    let onAbort: (() => void) | undefined;
    const result = signal === undefined
      ? inflight.promise
      : Promise.race([
          inflight.promise,
          new Promise<string>((_resolve, reject) => {
            onAbort = () => reject(abortReason(signal));
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
    return result.finally(() => {
      if (onAbort) signal!.removeEventListener("abort", onAbort);
      inflight.waiters--;
      if (!inflight.done && inflight.waiters === 0) inflight.controller.abort(signal?.reason);
    });
  }

  /** Invalidate both the cached token and any failed-refresh retry deadline. */
  invalidate(): void {
    this.#cached = undefined;
    this.#failure = undefined;
  }
}
