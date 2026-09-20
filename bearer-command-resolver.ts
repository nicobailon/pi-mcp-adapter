import { resolveCommandSecret } from "./utils.ts";

const DEFAULT_TTL_MS = 5 * 60_000;
const ENV_TTL_MS = "PI_MCP_ADAPTER_BEARER_COMMAND_TTL_MS";

function resolveDefaultTtlMs(): number {
  const raw = process.env[ENV_TTL_MS];
  if (raw === undefined || raw === "") return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return parsed;
}

/**
 * Resolve a bearer-token `!command` shellout lazily, on every HTTP request, so
 * a Cloudflare-Access-style 24h JWT does not go stale and lock the keep-alive
 * connection into a permanent 401 until pi is restarted.
 *
 * The resolver caches the resolved token for a TTL window; commands run at most
 * once per window per server. A failed run returns the cached token if any so a
 * transient shell error does not auth-fail every subsequent request; a failure
 * with no prior cache surfaces the error to the caller.
 *
 * One resolver is bound to one connection. The cache dies with the transport.
 */
export class BearerCommandResolver {
  readonly #command: string;
  readonly #context: string;
  readonly #ttlMs: number;
  #cached: { token: string; fetchedAt: number } | undefined;
  // A Promise that resolves to the token for an in-flight execution. Concurrent
  // callers all await the same reference; cleared once the run finishes.
  #inflight: Promise<string> | undefined;

  constructor(command: string, context: string, ttlMs: number = resolveDefaultTtlMs()) {
    this.#command = command;
    this.#context = context;
    this.#ttlMs = ttlMs;
  }

  /**
   * Return the current bearer token, re-running the command when the cached
   * value is older than the TTL. Concurrent callers share one in-flight
   * execution so a single MCP request burst does not fan out N shellouts.
   *
   * If the command throws and a previous successful value is cached, the
   * cached value is returned so a transient shell error does not 401 every
   * subsequent MCP request. The next call after TTL expiry will retry.
   */
  resolve(): Promise<string> {
    const now = Date.now();
    if (this.#cached !== undefined && now - this.#cached.fetchedAt < this.#ttlMs) {
      return Promise.resolve(this.#cached.token);
    }
    if (this.#inflight !== undefined) return this.#inflight;
    // Wrap the work in a Promise we control, so #inflight is cleared before
    // the awaited result becomes available. Awaiting `work` would resolve
    // before the finally block cleared #inflight (sync body, microtask
    // ordering), letting a sequential caller observe a stale reference.
    const work = (async (): Promise<string> => {
      try {
        const token = resolveCommandSecret(this.#command, this.#context);
        this.#cached = { token, fetchedAt: Date.now() };
        return token;
      } catch (error) {
        if (this.#cached !== undefined) return this.#cached.token;
        throw error;
      }
    })();
    const tracked = work.finally(() => {
      if (this.#inflight === tracked) this.#inflight = undefined;
    });
    this.#inflight = tracked;
    return tracked;
  }

  /** Invalidate the cached token so the next call re-runs the command. */
  invalidate(): void {
    this.#cached = undefined;
  }
}
