import type { Client } from "@modelcontextprotocol/client";

type ToolCallParams = Parameters<Client["callTool"]>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Executor `call` that runs one app tool: always the object form of `calls`, never an array,
 * so the pause and account handling for a single call applies (`findAccountGap`).
 */
export function executorCallParams(spec: { executorPath?: string }, args: Record<string, unknown>): ToolCallParams {
  if (spec.executorPath === undefined) throw new Error("Not an Executor app tool");
  return { name: "call", arguments: { calls: { path: spec.executorPath, input: args } } };
}

function malformed(path: string): never {
  throw new Error(`Executor returned a malformed result for ${path}`);
}

/**
 * The app tool's own result from a final Executor `call` result, Executor's `CallOutcome`
 * (contracts/execute.ts). A result without structuredContent passes through: Pi's own text, such
 * as a redacted `unavailable` or `busy` outcome, or an error Executor reports as text.
 * Any other shape throws.
 */
export function unwrapExecutorCallResult<T extends object>(path: string, result: T): T {
  const { structuredContent, isError } = result as { structuredContent?: unknown; isError?: unknown };
  if (structuredContent === undefined || isError === true) return result;
  if (!isRecord(structuredContent) || structuredContent.status !== "completed" || !isRecord(structuredContent.execution)) {
    const status = isRecord(structuredContent) && typeof structuredContent.status === "string" ? ` (${structuredContent.status})` : "";
    throw new Error(`Executor did not complete the call to ${path}${status}`);
  }
  const execution = structuredContent.execution;
  if (execution.ok !== true) {
    const message = isRecord(execution.error) && typeof execution.error.message === "string" ? `: ${execution.error.message}` : "";
    throw new Error(`Executor could not run ${path}${message}`);
  }
  const outcome = execution.value;
  if (!isRecord(outcome) || typeof outcome.path !== "string") malformed(path);
  if (outcome.ok === true && "value" in outcome) {
    const value = outcome.value;
    if (isRecord(value)) return { content: [], structuredContent: value } as unknown as T;
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
    return { content: [{ type: "text", text }] } as unknown as T;
  }
  const error = outcome.error;
  if (outcome.ok !== false || !isRecord(error) || typeof error.message !== "string") malformed(path);
  return {
    content: [{ type: "text", text: error.message }],
    ...(isRecord(error.response) ? { structuredContent: error.response } : {}),
    isError: true,
  } as unknown as T;
}
