import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { FetchLike } from "@modelcontextprotocol/client";
import type { HttpRequestHeadersCommand } from "./types.ts";
import { interpolateEnvVars } from "./utils.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const USE_PROCESS_GROUP = process.platform !== "win32";
const CLEANUP_TOKEN_ENV = "PI_MCP_REQUEST_HEADERS_CLEANUP_TOKEN";
// Busy hosts can exceed spawnSync's 1 MiB default when `ps axeww` dumps each
// process environment. Keep discovery below a bounded cap instead of letting
// `ps` get SIGTERM'd and reporting a false cleanup failure.
const PS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH";
}

function runPosixPs(args: string[]): { status: number | null; signal: NodeJS.Signals | null; stdout: string } {
  if (process.env.PI_MCP_ADAPTER_TEST_FAIL_PS === "1") return { status: 1, signal: null, stdout: "" };
  const result = spawnSync("ps", args, { encoding: "utf8", maxBuffer: PS_MAX_BUFFER_BYTES });
  return { status: result.status, signal: result.signal, stdout: result.stdout };
}

function psFailureReason(result: { status: number | null; signal: NodeJS.Signals | null }): string {
  return result.status === null
    ? `ps was killed by signal ${result.signal ?? "unknown"}`
    : `ps exited with code ${result.status}`;
}

function collectPosixProcessPids(rootPid: number, cleanupToken?: string): number[] {
  const result = runPosixPs(["axeww", "-o", "pid=,ppid=,command="]);
  if (result.status !== 0) {
    throw new Error(`HTTP request headers command cleanup failed: ${psFailureReason(result)}`);
  }

  const childrenByParent = new Map<number, number[]>();
  const processPids = new Set<number>();
  const needle = cleanupToken ? `${CLEANUP_TOKEN_ENV}=${cleanupToken}` : undefined;
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const children = childrenByParent.get(ppid);
    if (children) children.push(pid);
    else childrenByParent.set(ppid, [pid]);
    if (needle && pid !== process.pid && match[3]?.includes(needle)) processPids.add(pid);
  }

  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    processPids.add(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return [...processPids];
}

function assertPosixProcessDiscoveryAvailable(): void {
  const result = runPosixPs(["axeww", "-o", "pid=,ppid=,command="]);
  if (result.status !== 0) {
    throw new Error(`HTTP request headers command cleanup failed: ${psFailureReason(result)}`);
  }
}

function isTaskkillNoSuchProcess(result: ReturnType<typeof spawnSync>): boolean {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase().includes("not found");
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNoSuchProcessError(error)) throw error;
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isNoSuchProcessError(error)) throw error;
  }
}

function killRequestHeadersCommand(child: ChildProcess, trackedPosixDescendantPids = new Set<number>(), cleanupToken?: string): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0 || isTaskkillNoSuchProcess(result)) return;
    throw new Error(`HTTP request headers command cleanup failed: taskkill exited with code ${result.status ?? "unknown"}`);
  }

  if (USE_PROCESS_GROUP && child.pid !== undefined) {
    const frozenPids = new Set<number>();
    let cleanupError: Error | undefined;
    try {
      signalProcessGroup(child.pid, "SIGSTOP");
      for (const pid of trackedPosixDescendantPids) {
        signalPid(pid, "SIGSTOP");
        frozenPids.add(pid);
      }
      let stablePasses = 0;
      for (let pass = 0; pass < 16; pass++) {
        const candidates = collectPosixProcessPids(child.pid, cleanupToken);
        const newPids = candidates.filter(pid => !frozenPids.has(pid));
        if (newPids.length === 0) {
          stablePasses++;
          if (stablePasses >= 2) return;
          continue;
        }
        stablePasses = 0;
        for (const pid of newPids) {
          signalPid(pid, "SIGSTOP");
          frozenPids.add(pid);
        }
      }
      cleanupError = new Error("HTTP request headers command cleanup failed: descendant process tree did not stabilize");
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    } finally {
      signalProcessGroup(child.pid, "SIGKILL");
      for (const pid of frozenPids) signalPid(pid, "SIGKILL");
    }
    if (cleanupError) throw cleanupError;
    return;
  }

  child.kill("SIGKILL");
}

export interface HttpRequestCommandEnvelope {
  version: 1;
  method: string;
  url: string;
  bodyBase64: string;
}

type CommandResult =
  | { status: "error"; error: Error }
  | { status: "success"; headers: Headers };

function resolvedCommand(config: HttpRequestHeadersCommand): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
} {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("HTTP request headers command must be an object");
  }
  if (typeof config.command !== "string" || config.command.trim() === "") {
    throw new Error("HTTP request headers command requires a non-empty command");
  }
  if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string"))) {
    throw new Error("HTTP request headers command args must be strings");
  }
  if (config.env !== undefined && (
    typeof config.env !== "object"
    || Array.isArray(config.env)
    || Object.values(config.env).some(value => typeof value !== "string")
  )) {
    throw new Error("HTTP request headers command env values must be strings");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("HTTP request headers command timeoutMs must be an integer between 1 and 60000");
  }
  return {
    command: interpolateEnvVars(config.command),
    args: (config.args ?? []).map(interpolateEnvVars),
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(config.env ?? {}).map(([key, value]) => [key, interpolateEnvVars(value)]),
      ),
    },
    timeoutMs,
  };
}

async function invokeRequestHeadersCommand(
  config: HttpRequestHeadersCommand,
  envelope: HttpRequestCommandEnvelope,
  signal: AbortSignal,
): Promise<Headers> {
  const resolved = resolvedCommand(config);
  if (USE_PROCESS_GROUP) assertPosixProcessDiscoveryAvailable();
  return new Promise<Headers>((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let settled = false;
    const cleanupToken = randomUUID();
    const child = spawn(resolved.command, resolved.args, {
      env: { ...resolved.env, [CLEANUP_TOKEN_ENV]: cleanupToken },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      detached: USE_PROCESS_GROUP,
    });

    const trackedPosixDescendantPids = new Set<number>();
    let trackingError: Error | undefined;
    const trackPosixDescendants = () => {
      if (!USE_PROCESS_GROUP || child.pid === undefined || settled || trackingError) return;
      try {
        for (const pid of collectPosixProcessPids(child.pid, cleanupToken)) trackedPosixDescendantPids.add(pid);
      } catch (error) {
        trackingError = error instanceof Error ? error : new Error(String(error));
      }
    };
    const descendantTracker = USE_PROCESS_GROUP ? setInterval(trackPosixDescendants, 50) : undefined;
    descendantTracker?.unref();

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (descendantTracker) clearInterval(descendantTracker);
      signal.removeEventListener("abort", abort);
      if (result.status === "error") reject(result.error);
      else resolve(result.headers);
    };
    const finishAfterKill = (result: CommandResult) => {
      try {
        killRequestHeadersCommand(child, trackedPosixDescendantPids, cleanupToken);
        finish(result);
      } catch (cleanupError) {
        finish({ status: "error", error: cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)) });
      }
    };
    const failAfterKill = (message: string) => {
      finishAfterKill({ status: "error", error: trackingError ?? new Error(message) });
    };
    const abort = () => {
      failAfterKill("HTTP request headers command aborted");
    };
    const timer = setTimeout(() => {
      failAfterKill(`HTTP request headers command timed out after ${resolved.timeoutMs}ms`);
    }, resolved.timeoutMs);

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }

    child.on("error", () => finish({ status: "error", error: new Error("HTTP request headers command failed to start") }));
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
      if (stdout.byteLength > MAX_OUTPUT_BYTES) {
        failAfterKill("HTTP request headers command output exceeded 64 KiB");
      }
    });
    child.on("close", code => {
      if (settled) return;
      if (trackingError) {
        failAfterKill(trackingError.message);
        return;
      }
      if (code !== 0) {
        failAfterKill(`HTTP request headers command exited with code ${code ?? "unknown"}`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.toString("utf8"));
      } catch {
        finishAfterKill({ status: "error", error: new Error("HTTP request headers command returned invalid JSON") });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        finishAfterKill({ status: "error", error: new Error("HTTP request headers command must return a JSON object") });
        return;
      }
      const entries = Object.entries(parsed);
      if (entries.some(([, value]) => typeof value !== "string")) {
        finishAfterKill({ status: "error", error: new Error("HTTP request headers command values must be strings") });
        return;
      }
      try {
        finishAfterKill({ status: "success", headers: new Headers(entries as Array<[string, string]>) });
      } catch {
        finishAfterKill({ status: "error", error: new Error("HTTP request headers command returned an invalid header") });
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(envelope));
  });
}

/** Wrap fetch so a trusted command can derive headers from the exact request. */
export function createRequestHeadersCommandFetch(
  config: HttpRequestHeadersCommand,
  delegate: FetchLike = globalThis.fetch,
): FetchLike {
  // Validate static configuration before the first request.
  resolvedCommand(config);
  return async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body = Buffer.from(await request.clone().arrayBuffer());
    const derived = await invokeRequestHeadersCommand(config, {
      version: 1,
      method: request.method.toUpperCase(),
      url: request.url,
      bodyBase64: body.toString("base64"),
    }, request.signal);
    const headers = new Headers(request.headers);
    derived.forEach((value, name) => headers.set(name, value));
    return delegate(new URL(request.url), {
      method: request.method,
      headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }),
      signal: request.signal,
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
    });
  };
}
