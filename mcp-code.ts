import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { formatWithOptions } from "node:util";
import { Worker } from "node:worker_threads";
import { throwIfAborted } from "./abort.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { evaluateJev, validateJevSettings } from "./jev-client.ts";
import type { JevErrorCode, JevEvaluateInput, JevEvaluationEnvelope } from "./jev-contracts.ts";
import { executeCall } from "./proxy-modes.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { paginate, rankSuggestions, rankToolMatches } from "./search-ranking.ts";
import { semanticSearch, type SemanticSearchEvaluator } from "./semantic-search.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";
import type { McpExtensionState } from "./state.ts";
import { findToolByName, formatSchema, hasSchemaDescriptions } from "./tool-metadata.ts";
import { renderTsShape } from "./ts-shape.ts";
import type { ContentBlock } from "./types.ts";

export const DEFAULT_MCP_SCRIPT_TIMEOUT_MS = 30_000;
const MCP_SCRIPT_INTERMEDIATE_MAX_BYTES = 16 * 1024 * 1024;

class McpScriptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`mcpScript timed out after ${timeoutMs}ms`);
    this.name = "McpScriptTimeoutError";
  }
}

type SearchInput = { query?: unknown; server?: unknown; limit?: unknown; offset?: unknown; searchMode?: unknown; regex?: unknown };
type DescribeInput = { path?: unknown };
type WorkerMessage =
  | { type: "emit"; block: unknown }
  | { type: "call"; id: number; path: string; args?: unknown }
  | { type: "evaluate"; id: number; input: unknown }
  | { type: "search"; id: number; input?: unknown }
  | { type: "describe"; id: number; input?: unknown }
  | { type: "done"; returnBlock?: unknown }
  | { type: "error"; message: string };

type WorkerResultPayload = { envelope: unknown } | { dataJson: string };
type WorkerResultMessage = { type: "result"; id: number } & WorkerResultPayload;

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
  if (message.type === "evaluate" && typeof message.id === "number" && "input" in message) {
    return { type: "evaluate", id: message.id, input: message.input };
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

export type McpScriptJevEvaluator = (
  state: McpExtensionState,
  input: JevEvaluateInput,
  options: { purpose: "script"; signal?: AbortSignal; observedSources?: readonly string[] },
) => Promise<JevEvaluationEnvelope>;

export async function runMcpScript(
  state: McpExtensionState,
  code: string,
  timeoutMs = DEFAULT_MCP_SCRIPT_TIMEOUT_MS,
  getPiTools?: () => ToolInfo[],
  signal?: AbortSignal,
  jevEvaluator: McpScriptJevEvaluator = evaluateJev,
  semanticEvaluator?: SemanticSearchEvaluator,
) {
  const resolvedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_MCP_SCRIPT_TIMEOUT_MS;
  const output: ContentBlock[] = [];
  const externalSignal = combineAbortSignals(state.owner?.signal, signal);
  const timeoutController = new AbortController();
  const callSignal = combineAbortSignals(externalSignal, timeoutController.signal);
  const observedSources = new Set<string>();

  type ScriptOperation =
    | { operation: "call"; path: string; ok: true; durationMs: number }
    | { operation: "call"; path: string; ok: false; error: string; durationMs: number }
    | { operation: "search"; query: string; ok: true; durationMs: number }
    | { operation: "search"; query: string; ok: false; error: string; durationMs: number }
    | { operation: "describe"; path: string; ok: true; durationMs: number }
    | { operation: "describe"; path: string; ok: false; error: string; durationMs: number }
    | { operation: "evaluate"; ok: true; model: string; inputTokens: number; outputTokens: number; durationMs: number }
    | { operation: "evaluate"; ok: false; error: JevErrorCode | "incomplete"; durationMs: number };
  type TrackedScriptOperation = ScriptOperation & { startedAt: number };
  const calls: TrackedScriptOperation[] = [];
  const snapshotCalls = (): ScriptOperation[] => calls.map(({ startedAt, ...operation }) => ({
    ...operation,
    durationMs: "error" in operation && operation.error === "incomplete"
      ? Math.max(0, Date.now() - startedAt)
      : operation.durationMs,
  }));
  let callsSnapshot: ScriptOperation[] | undefined;
  let intermediateBytes = 0;
  const reserveIntermediateBytes = (dataJson: string): boolean => {
    const bytes = Buffer.byteLength(dataJson, "utf8");
    if (bytes > MCP_SCRIPT_INTERMEDIATE_MAX_BYTES - intermediateBytes) return false;
    intermediateBytes += bytes;
    return true;
  };
  const callTool = async (path: string, args?: Record<string, unknown>): Promise<WorkerResultPayload> => {
    // Record before dispatch so calls still in flight at timeout/abort appear in the trace.
    const startedAt = Date.now();
    const index = calls.push({ operation: "call", path, ok: false, error: "incomplete", durationMs: 0, startedAt }) - 1;
    let dataJson: string | undefined;
    const result = await executeCall(state, path, args, undefined, getPiTools, callSignal, "script", {
      onSuccess(data) {
        // Serialize once for both byte accounting and worker transfer, never for display.
        dataJson = JSON.stringify(data);
      },
    });
    const details = result.details;
    if (typeof details.server === "string") observedSources.add(details.server);
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
        envelope: { ok: false, error: { code: errorCode, message } },
      };
    }
    throwIfAborted(callSignal);
    if (dataJson === undefined) throw new Error("MCP intermediate result was not JSON serializable");
    if (!reserveIntermediateBytes(dataJson)) {
      const code = "intermediate_result_too_large";
      calls[index] = { operation: "call", path, ok: false, error: code, durationMs: Date.now() - startedAt, startedAt };
      return {
        envelope: {
          ok: false,
          error: { code, message: "MCP result exceeds the remaining mcpScript intermediate transfer budget (16 MiB per script). Request less data or use a new script." },
        },
      };
    }
    // Rejected responses do not consume budget. This bounds transfer, not upstream allocation.
    calls[index] = { operation: "call", path, ok: true, durationMs: Date.now() - startedAt, startedAt };
    return { dataJson };
  };

  const jevSettings = validateJevSettings(state.config.settings?.jev);
  let evaluationAttempts = 0;
  let evaluationBytes = 0;
  let evaluationTokensRemaining = jevSettings.maxEvaluationTokensPerScript;
  const tokenBudgetExhausted = (): JevEvaluationEnvelope => ({ ok: false, error: { code: "budget_exhausted", message: "TypeSafe evaluation token budget exhausted." } });
  const chargeEvaluationTokens = (envelope: JevEvaluationEnvelope): JevEvaluationEnvelope => {
    if (!envelope.ok) return envelope;
    const used = envelope.data.usage.inputTokens + envelope.data.usage.outputTokens;
    if (!Number.isSafeInteger(used) || used < 0 || used > evaluationTokensRemaining) {
      evaluationTokensRemaining = 0;
      return tokenBudgetExhausted();
    }
    evaluationTokensRemaining -= used;
    return envelope;
  };
  const admitEvaluation = (input: unknown): JevEvaluationEnvelope | undefined => {
    if (++evaluationAttempts > jevSettings.maxEvaluationsPerScript) {
      return { ok: false, error: { code: "budget_exhausted", message: "TypeSafe evaluation count budget exhausted." } };
    }
    if (evaluationTokensRemaining === 0) return tokenBudgetExhausted();
    let serialized: string | undefined;
    try { serialized = JSON.stringify(input); }
    catch { return { ok: false, error: { code: "invalid_request", message: "Invalid TypeSafe evaluation request." } }; }
    if (serialized === undefined) return { ok: false, error: { code: "invalid_request", message: "Invalid TypeSafe evaluation request." } };
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > jevSettings.maxEvaluationBytesPerScript - evaluationBytes) {
      return { ok: false, error: { code: "budget_exhausted", message: "TypeSafe evaluation byte budget exhausted." } };
    }
    evaluationBytes += bytes;
    return undefined;
  };
  const evaluate = async (input: unknown): Promise<WorkerResultPayload> => {
    const startedAt = Date.now();
    const index = calls.push({ operation: "evaluate", ok: false, error: "incomplete", durationMs: 0, startedAt }) - 1;
    let envelope: JevEvaluationEnvelope;
    const rejected = admitEvaluation(input);
    if (rejected) {
      envelope = rejected;
    } else {
      envelope = await jevEvaluator(state, input as JevEvaluateInput, {
        purpose: "script",
        ...(callSignal ? { signal: callSignal } : {}),
        ...(observedSources.size > 0 ? { observedSources: [...observedSources] } : {}),
      });
    }
    envelope = chargeEvaluationTokens(envelope);
    throwIfAborted(callSignal);
    if (!reserveIntermediateBytes(JSON.stringify(envelope))) {
      envelope = { ok: false, error: { code: "budget_exhausted", message: "TypeSafe evaluation exceeds the remaining mcpScript intermediate transfer budget (16 MiB per script)." } };
    }
    calls[index] = envelope.ok
      ? {
          operation: "evaluate", ok: true, model: envelope.data.model,
          inputTokens: envelope.data.usage.inputTokens, outputTokens: envelope.data.usage.outputTokens,
          durationMs: Date.now() - startedAt, startedAt,
        }
      : { operation: "evaluate", ok: false, error: envelope.error.code, durationMs: Date.now() - startedAt, startedAt };
    return { envelope };
  };

  const searchTools = async (input?: SearchInput) => {
    const startedAt = Date.now();
    const query = typeof input?.query === "string" ? input.query : "";
    const index = calls.push({ operation: "search", query, ok: false, error: "incomplete", durationMs: 0, startedAt }) - 1;
    let error: unknown;
    try {
      if (input?.searchMode !== undefined && input.searchMode !== "lexical" && input.searchMode !== "semantic") {
        error = "invalid_search_mode";
        return { items: [], total: 0, hasMore: false, nextOffset: null, error: { code: "invalid_search_mode", message: "Search mode must be lexical or semantic." } };
      }
      if (query.trim() === "" && input?.searchMode !== "semantic") {
        return { items: [], total: 0, hasMore: false, nextOffset: null };
      }
      const server = typeof input?.server === "string" ? input.server : undefined;
      const limit = typeof input?.limit === "number" ? input.limit : 12;
      const offset = typeof input?.offset === "number" ? input.offset : 0;
      const searchMode = input?.searchMode === "semantic" ? "semantic" : "lexical";
      if (searchMode === "semantic" && input?.regex === true) {
        error = "invalid_search_mode";
        return { items: [], total: 0, hasMore: false, nextOffset: null, error: { code: "invalid_search_mode", message: "Semantic search cannot be combined with regex search." } };
      }
      const semantic = searchMode === "semantic"
        ? await semanticSearch(state, query, server, callSignal, async (semanticState, semanticInput, options) => {
            const rejected = admitEvaluation(semanticInput);
            if (rejected) return rejected;
            const envelope = await (semanticEvaluator ?? evaluateJev)(semanticState, semanticInput, options);
            return chargeEvaluationTokens(envelope);
          }, [...observedSources])
        : undefined;
      if (semantic && !semantic.ok) {
        error = semantic.error.code;
        return { items: [], total: 0, hasMore: false, nextOffset: null, error: semantic.error };
      }
      const page = paginate(semantic?.matches ?? rankToolMatches(state, query, server), offset, limit);
      return {
        ...page,
        items: page.items.map(({ server: matchServer, tool, score }) => ({
          path: tool.name,
          name: tool.originalName,
          server: matchServer,
          ...(tool.description ? { description: tool.description } : {}),
          score,
        })),
        ...(semantic ? { backend: semantic.backend } : {}),
      };
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      calls[index] = error === undefined
        ? { operation: "search", query, ok: true, durationMs: Date.now() - startedAt, startedAt }
        : { operation: "search", query, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, startedAt };
    }
  };

  const describeTool = (input?: DescribeInput) => {
    const startedAt = Date.now();
    const path = typeof input?.path === "string" ? input.path : "";
    let error: unknown;
    try {
      for (const [server, metadata] of state.toolMetadata) {
        if (isServerInActiveFailureBackoff(state, server)) continue;
        const tool = findToolByName(metadata, path);
        if (!tool) continue;
        const inputShape = tool.inputSchema ? renderTsShape(tool.inputSchema) : null;
        const inputTypeScript = inputShape ?? (tool.inputSchema ? formatSchema(tool.inputSchema) : null);
        return {
          path: tool.name,
          name: tool.originalName,
          server,
          ...(tool.description ? { description: tool.description } : {}),
          ...(inputTypeScript ? { inputTypeScript } : {}),
          ...(inputShape && hasSchemaDescriptions(tool.inputSchema)
            ? { inputGuidance: formatSchema(tool.inputSchema) } : {}),
          ...(tool.outputSchema !== undefined ? {
            outputSchemaTarget: "data.structuredContent",
            outputSchema: tool.outputSchema,
          } : {}),
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
      // The sandbox cannot open files, and the host always terminates this worker.
      // Disable Node's unmanaged FD bookkeeping, which emits false warnings when
      // short-lived workers are terminated on Node 24.
      trackUnmanagedFds: false,
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
          let payload: WorkerResultPayload;
          if (message.type === "call") {
            payload = await callTool(message.path, message.args as Record<string, unknown> | undefined);
          } else if (message.type === "evaluate") {
            payload = await evaluate(message.input);
          } else if (message.type === "search") {
            payload = { envelope: await searchTools(message.input as SearchInput | undefined) };
          } else {
            payload = { envelope: describeTool(message.input as DescribeInput | undefined) };
          }
          if (completed || callSignal?.aborted) return;
          const response: WorkerResultMessage = { type: "result", id: message.id, ...payload };
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
