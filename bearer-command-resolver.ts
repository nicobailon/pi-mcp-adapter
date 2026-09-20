import { spawn } from "node:child_process";

const DEFAULT_TTL_MS = 5 * 60_000;
const ENV_TTL_MS = "PI_MCP_ADAPTER_BEARER_COMMAND_TTL_MS";
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
const USE_PROCESS_GROUP = process.platform !== "win32";

function resolveDefaultTtlMs(): number {
  const parsed = Number(process.env[ENV_TTL_MS] || DEFAULT_TTL_MS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function runCommand(command: string, context: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    let settled = false;
    let terminating = false;
    const child = spawn(command.slice(1), {
      shell: true,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      detached: USE_PROCESS_GROUP,
    });

    const kill = async (): Promise<void> => {
      if (child.pid === undefined) return;
      if (!USE_PROCESS_GROUP) {
        await new Promise<void>((resolveKill, rejectKill) => {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => rejectKill(new Error("Failed to stop bearer token command")));
          killer.on("close", code => {
            if (code === 0 || code === 128) resolveKill();
            else rejectKill(new Error(`Failed to stop bearer token command: taskkill exited with code ${code ?? "unknown"}`));
          });
        });
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
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
    const terminate = async (error: unknown) => {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        await kill();
        finish(error);
      } catch (cleanupError) {
        finish(cleanupError);
      }
    };
    const onAbort = () => {
      void terminate(abortReason(signal));
    };
    const timer = setTimeout(() => {
      void terminate(new Error(`Failed to resolve ${context}: command timed out after ${COMMAND_TIMEOUT_MS}ms`));
    }, COMMAND_TIMEOUT_MS);

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    child.on("error", () => {
      if (!terminating) finish(new Error(`Failed to resolve ${context}: command failed to start`));
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled || terminating) return;
      output = Buffer.concat([output, Buffer.from(chunk)]);
      if (output.byteLength > COMMAND_MAX_OUTPUT_BYTES) {
        void terminate(new Error(`Failed to resolve ${context}: command output exceeded 1 MiB`));
      }
    });
    child.on("close", code => {
      if (settled || terminating) return;
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
};

/** Resolve and periodically refresh one command-backed bearer token. */
export class BearerCommandResolver {
  readonly #command: string;
  readonly #context: string;
  readonly #ttlMs: number;
  #cached: { token: string; expiresAt: number } | undefined;
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
    if (this.#cached !== undefined && now < this.#cached.expiresAt) {
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
      let current: Inflight;
      const promise = runCommand(this.#command, this.#context, controller.signal)
        .then(token => {
          this.#cached = { token, expiresAt: Date.now() + this.#ttlMs };
          this.#failure = undefined;
          return token;
        })
        .catch(error => {
          // Request cancellation is not a helper outage. Do not let one
          // cancelled request suppress refresh attempts for the next caller.
          if (!controller.signal.aborted) {
            this.#failure = { error, retryAt: Date.now() + this.#ttlMs };
          }
          if (this.#cached !== undefined) return this.#cached.token;
          throw error;
        })
        .finally(() => {
          if (this.#inflight === current) this.#inflight = undefined;
        });
      current = { controller, promise, waiters: 0 };
      this.#inflight = current;
      inflight = current;
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
      if (this.#inflight === inflight && inflight.waiters === 0) {
        this.#inflight = undefined;
        inflight.controller.abort(signal?.reason);
      }
    });
  }
}
