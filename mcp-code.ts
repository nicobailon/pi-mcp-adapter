import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { formatWithOptions } from "node:util";
import { Worker } from "node:worker_threads";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { executeCall } from "./proxy-modes.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { paginate, rankSuggestions, rankToolMatches } from "./search-ranking.ts";
import type { McpExtensionState } from "./state.ts";
import { findToolByName, formatSchema } from "./tool-metadata.ts";
import { renderTsShape } from "./ts-shape.ts";
import type { ContentBlock } from "./types.ts";

export const DEFAULT_MCP_SCRIPT_TIMEOUT_MS = 30_000;

class McpScriptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`mcpScript timed out after ${timeoutMs}ms`);
    this.name = "McpScriptTimeoutError";
  }
}

type SearchInput = { query?: unknown; server?: unknown; limit?: unknown; offset?: unknown };
type DescribeInput = { path?: unknown };
type WorkerMessage =
  | { type: "emit"; block: unknown }
  | { type: "call"; id: number; path: string; args?: unknown }
  | { type: "search"; id: number; input?: unknown }
  | { type: "describe"; id: number; input?: unknown }
  | { type: "done"; returnBlock?: unknown }
  | { type: "error"; message: string };

type WorkerResultMessage = { type: "result"; id: number; envelope: unknown };

function needsInspectableFormatting(value: unknown, stack = new WeakSet<object>()): boolean {
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return true;
  if (typeof value !== "object" || value === null) return false;
  if (stack.has(value)) return true;
  if (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet) return true;
  stack.add(value);
  try {
    return Object.values(value).some((entry) => needsInspectableFormatting(entry, stack));
  } finally {
    stack.delete(value);
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    if (!needsInspectableFormatting(value)) {
      const json = JSON.stringify(value, null, 2);
      if (json !== undefined) return json;
    }
    return formatWithOptions({ colors: false, depth: 6 }, value);
  } catch {
    return "[unserializable value]";
  }
}

function toContentBlock(value: unknown): ContentBlock {
  if (typeof value === "object" && value !== null) {
    const block = value as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
  }
  return { type: "text", text: formatValue(value) };
}

function textFromContent(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function abortReasonError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? "MCP request aborted"));
}

function parseWorkerMessage(value: unknown): WorkerMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "emit" && "block" in message) return { type: "emit", block: message.block };
  if (message.type === "call" && typeof message.id === "number" && typeof message.path === "string") {
    return "args" in message
      ? { type: "call", id: message.id, path: message.path, args: message.args }
      : { type: "call", id: message.id, path: message.path };
  }
  if ((message.type === "search" || message.type === "describe") && typeof message.id === "number") {
    return "input" in message
      ? { type: message.type, id: message.id, input: message.input }
      : { type: message.type, id: message.id };
  }
  if (message.type === "done") {
    return "returnBlock" in message ? { type: "done", returnBlock: message.returnBlock } : { type: "done" };
  }
  if (message.type === "error" && typeof message.message === "string") {
    return { type: "error", message: message.message };
  }
  return null;
}

export async function runMcpScript(
  state: McpExtensionState,
  code: string,
  timeoutMs = DEFAULT_MCP_SCRIPT_TIMEOUT_MS,
  getPiTools?: () => ToolInfo[],
  signal?: AbortSignal,
) {
  const resolvedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_MCP_SCRIPT_TIMEOUT_MS;
  const output: ContentBlock[] = [];
  const externalSignal = combineAbortSignals(state.owner?.signal, signal);
  const timeoutController = new AbortController();
  const callSignal = combineAbortSignals(externalSignal, timeoutController.signal);

  type ScriptOperation =
    | { operation: "call"; path: string; ok: true; durationMs: number }
    | { operation: "call"; path: string; ok: false; error: string; durationMs: number }
    | { operation: "search"; query: string; ok: true; durationMs: number }
    | { operation: "search"; query: string; ok: false; error: string; durationMs: number }
    | { operation: "describe"; path: string; ok: true; durationMs: number }
    | { operation: "describe"; path: string; ok: false; error: string; durationMs: number };
  type TrackedScriptOperation = ScriptOperation & { startedAt: number };
  const calls: TrackedScriptOperation[] = [];
  const snapshotCalls = (): ScriptOperation[] => calls.map(({ startedAt, ...operation }) => ({
    ...operation,
    durationMs: "error" in operation && operation.error === "incomplete"
      ? Math.max(0, Date.now() - startedAt)
      : operation.durationMs,
  }));
  let callsSnapshot: ScriptOperation[] | undefined;
  const callTool = async (path: string, args?: Record<string, unknown>) => {
    // Record before dispatch so calls still in flight at timeout/abort appear in the trace.
    const startedAt = Date.now();
    const index = calls.push({ operation: "call", path, ok: false, error: "incomplete", durationMs: 0, startedAt }) - 1;
    const result = await executeCall(state, path, args, undefined, getPiTools, callSignal, "script");
    const details = result.details;
    if (details.error !== undefined) {
      const errorCode = String(details.error);
      const suggestions = Array.isArray(details.suggestions)
        ? details.suggestions.filter((suggestion): suggestion is string => typeof suggestion === "string")
        : [];
      const message = errorCode === "tool_not_found"
        ? `Tool "${path}" not found. Use await tools.search({ query: "..." }) inside mcpScript.${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : ""}`
        : typeof details.message === "string"
          ? details.message
          : textFromContent(result.content);
      calls[index] = { operation: "call", path, ok: false, error: errorCode, durationMs: Date.now() - startedAt, startedAt };
      return {
        ok: false as const,
        error: { code: errorCode, message },
      };
    }
    calls[index] = { operation: "call", path, ok: true, durationMs: Date.now() - startedAt, startedAt };
    return {
      ok: true as const,
      data: details.mcpResult !== undefined ? details.mcpResult : textFromContent(result.content),
    };
  };

  const searchTools = (input?: SearchInput) => {
    const startedAt = Date.now();
    const query = typeof input?.query === "string" ? input.query : "";
    let error: unknown;
    try {
      if (query.trim() === "") {
        return { items: [], total: 0, hasMore: false, nextOffset: null };
      }
      const server = typeof input?.server === "string" ? input.server : undefined;
      const limit = typeof input?.limit === "number" ? input.limit : 12;
      const offset = typeof input?.offset === "number" ? input.offset : 0;
      const page = paginate(rankToolMatches(state, query, server), offset, limit);
      return {
        ...page,
        items: page.items.map(({ server: matchServer, tool, score }) => ({
          path: tool.name,
          name: tool.originalName,
          server: matchServer,
          ...(tool.description ? { description: tool.description } : {}),
          score,
        })),
      };
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      calls.push(error === undefined
        ? { operation: "search", query, ok: true, durationMs: Date.now() - startedAt, startedAt }
        : { operation: "search", query, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, startedAt });
    }
  };

  const describeTool = (input?: DescribeInput) => {
    const startedAt = Date.now();
    const path = typeof input?.path === "string" ? input.path : "";
    let error: unknown;
    try {
      for (const [server, metadata] of state.toolMetadata) {
        const tool = findToolByName(metadata, path);
        if (!tool) continue;
        const inputTypeScript = tool.inputSchema
          ? renderTsShape(tool.inputSchema) ?? formatSchema(tool.inputSchema)
          : null;
        return {
          path: tool.name,
          name: tool.originalName,
          server,
          ...(tool.description ? { description: tool.description } : {}),
          ...(inputTypeScript ? { inputTypeScript } : {}),
        };
      }
      const suggestions = path ? rankSuggestions(state, path, 5) : [];
      error = "tool_not_found";
      return {
        path,
        error: {
          code: "tool_not_found",
          message: `Tool not found: ${path}`,
          suggestions,
        },
      };
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      calls.push(error === undefined
        ? { operation: "describe", path, ok: true, durationMs: Date.now() - startedAt, startedAt }
        : { operation: "describe", path, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, startedAt });
    }
  };

  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  let errorCode: "timeout" | "aborted" | "script_error" | undefined;
  let errorMessage: string | undefined;

  try {
    if (externalSignal?.aborted) {
      throw abortReasonError(externalSignal.reason);
    }

    worker = new Worker(new URL("./mcp-script-worker.mjs", import.meta.url), {
      workerData: { code },
      env: {},
    });
    const activeWorker = worker;
    const execution = new Promise<void>((resolve, reject) => {
      let completed = false;
      activeWorker.on("message", (value: unknown) => {
        const message = parseWorkerMessage(value);
        if (!message || completed) return;
        if (message.type === "emit") {
          output.push(toContentBlock(message.block));
          return;
        }
        if (message.type === "done") {
          completed = true;
          if ("returnBlock" in message) output.push(toContentBlock(message.returnBlock));
          resolve();
          return;
        }
        if (message.type === "error") {
          completed = true;
          reject(new Error(message.message));
          return;
        }

        void (async () => {
          let envelope: unknown;
          if (message.type === "call") {
            envelope = await callTool(message.path, message.args as Record<string, unknown> | undefined);
          } else if (message.type === "search") {
            envelope = searchTools(message.input as SearchInput | undefined);
          } else {
            envelope = describeTool(message.input as DescribeInput | undefined);
          }
          const response: WorkerResultMessage = { type: "result", id: message.id, envelope };
          activeWorker.postMessage(response);
        })().catch(reject);
      });
      activeWorker.once("error", reject);
      activeWorker.once("exit", (code) => {
        if (!completed && code !== 0) reject(new Error(`mcpScript worker exited with code ${code}`));
      });
    });
    const timeoutError = new McpScriptTimeoutError(resolvedTimeoutMs);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        callsSnapshot = snapshotCalls();
        timeoutController.abort(timeoutError);
        void activeWorker.terminate();
        reject(timeoutError);
      }, resolvedTimeoutMs);
    });
    const aborted = externalSignal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            callsSnapshot = snapshotCalls();
            void activeWorker.terminate();
            reject(abortReasonError(externalSignal.reason));
          };
          externalSignal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => externalSignal.removeEventListener("abort", onAbort);
        })
      : new Promise<never>(() => {});

    await Promise.race([execution, timeout, aborted]);
  } catch (error) {
    if (error instanceof McpScriptTimeoutError) {
      errorCode = "timeout";
      errorMessage = `mcpScript timed out after ${resolvedTimeoutMs}ms`;
    } else if (externalSignal?.aborted) {
      errorCode = "aborted";
      errorMessage = error instanceof Error ? error.message : String(error);
    } else {
      errorCode = "script_error";
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    output.push({ type: "text", text: errorMessage });
  } finally {
    clearTimeout(timer);
    removeAbortListener();
    // "incomplete" means the call had not settled when the script finished
    // (deadline, abort, or early return). Snapshot before aborting stragglers.
    callsSnapshot ??= snapshotCalls();
    // A script may finish without awaiting every call; abort leftovers so
    // parent-side dispatches do not outlive the script.
    timeoutController.abort(new Error("mcpScript finished"));
    await worker?.terminate();
  }

  // Snapshot before the asynchronous output guard; the terminated worker can no longer emit.
  const guarded = await guardMcpOutput(
    output.length > 0 ? [...output] : [{ type: "text", text: "(no output)" }],
    resolveMcpOutputGuardOptions(state.config.settings),
  );
  return {
    content: guarded.content,
    details: {
      mode: "script",
      ...(errorCode ? { error: errorCode, message: errorMessage } : {}),
      timeoutMs: resolvedTimeoutMs,
      ...(callsSnapshot.length > 0 ? { calls: callsSnapshot } : {}),
      ...guardedMcpDetails(guarded),
    },
  };
}
