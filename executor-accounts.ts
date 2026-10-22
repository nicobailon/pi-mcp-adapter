import type { Client } from "@modelcontextprotocol/client";

type ToolCallParams = Parameters<Client["callTool"]>[0];

/** A final Executor `call` result that failed because the caller has no account linked to an app. */
export interface AccountGap {
  code: "AppAccountRequired" | "AccountRequired";
  /** The app's slug, read from the caller's own request path rather than Executor's echo of it. */
  slug: string;
  /** Re-running the original call repeats no tool call that already ran or may have run. */
  retrySafe: boolean;
}

const TOOL_CALL_OUTCOMES = new Set(["success", "failure", "interrupted", "awaiting-approval"]);
// Executor's AppSlug pattern (packages/sdk/src/contracts/app-slug.ts).
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// One `.name` or `["name"]` member of a tool expression, as Executor parses it.
const EXPRESSION_MEMBER = /^(?:\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\])/;

/** How one call in the batch ended: it succeeded, it lacked an account, or it failed otherwise. */
type Outcome = "success" | AccountGap["code"] | "other-failure";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): never {
  throw new Error("Executor returned a malformed call result");
}

function isDiagnostic(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.kind === "string" && typeof value.message === "string";
}

function parseOutcome(value: unknown): Outcome {
  if (!isRecord(value) || typeof value.path !== "string") malformed();
  if (value.ok === true && "value" in value) return "success";
  if (value.ok !== false || !isDiagnostic(value.error)) malformed();
  const response = value.error.response;
  if (response === undefined) return "other-failure";
  if (!isRecord(response) || typeof response.code !== "string") malformed();
  return response.code === "AppAccountRequired" || response.code === "AccountRequired" ? response.code : "other-failure";
}

/** Request paths in batch order; a single call is the object form of `calls`, a batch the array form. */
function requestPaths(params: ToolCallParams): { single: boolean; paths: string[] } {
  const calls = isRecord(params.arguments) ? params.arguments.calls : undefined;
  if (isRecord(calls) && typeof calls.path === "string") return { single: true, paths: [calls.path] };
  if (Array.isArray(calls) && calls.length > 0 && calls.every(call => isRecord(call) && typeof call.path === "string")) {
    return { single: false, paths: calls.map(call => call.path as string) };
  }
  throw new Error("Executor reported a missing account for a call request without paths");
}

/** The app a path names, canonicalised as Executor does: `tools["my-app"].read` and `my-app.read` both name `my-app`. */
function appSlug(path: string): string {
  const slug = canonicalPath(path).split(".")[0]!;
  if (!APP_SLUG.test(slug)) throw new Error(`Executor reported a missing account for "${path}", which names no app`);
  return slug;
}

function canonicalPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed !== "tools" && !trimmed.startsWith("tools.") && !trimmed.startsWith("tools[")) return trimmed;
  const segments: string[] = [];
  for (let rest = trimmed.slice("tools".length); rest !== "";) {
    const member = EXPRESSION_MEMBER.exec(rest);
    if (!member) return trimmed;
    const [matched, identifier, quoted] = member;
    segments.push(identifier ?? String(JSON.parse(quoted!)));
    rest = rest.slice(matched.length);
  }
  return segments.join(".");
}

/**
 * Finds a missing-account failure in a final Executor `call` result. Executor reports it inside a
 * successful batch (`execution.ok` is true), as the failed outcome of the call that needed the account.
 * `execute` results name no app, so they return undefined and reach the model unchanged.
 */
export function findAccountGap(params: ToolCallParams, result: object): AccountGap | undefined {
  if (params.name !== "call") return undefined;
  const content = (result as { structuredContent?: unknown }).structuredContent;
  if (!isRecord(content) || content.status !== "completed") return undefined;
  const execution = content.execution;
  if (!isRecord(execution) || !Array.isArray(execution.toolCalls)) malformed();
  const toolCalls = execution.toolCalls.map(call => {
    if (!isRecord(call) || typeof call.name !== "string" || typeof call.outcome !== "string" || !TOOL_CALL_OUTCOMES.has(call.outcome)) {
      malformed();
    }
    return call.outcome;
  });
  if (execution.ok === false) {
    if (!isDiagnostic(execution.error)) malformed();
    return undefined;
  }
  if (execution.ok !== true || !("value" in execution)) malformed();
  const batch = Array.isArray(execution.value);
  const outcomes = (batch ? execution.value as unknown[] : [execution.value]).map(parseOutcome);
  if (outcomes.length === 0) malformed();
  // Connecting the account cannot help a batch whose other calls already succeeded.
  if (outcomes.includes("success")) return undefined;
  const code = outcomes.find((outcome): outcome is AccountGap["code"] => outcome !== "success" && outcome !== "other-failure");
  if (!code) return undefined;
  const { single, paths } = requestPaths(params);
  if (single === batch || paths.length !== outcomes.length) malformed();
  // AccountRequired is raised while binding credentials, before any upstream request, so its one
  // `failure` entry ran nothing. A batch is never safe: re-running it re-runs every call in it.
  const retrySafe = single
    && toolCalls.every(outcome => outcome === "failure")
    && toolCalls.length <= 1;
  return { code, slug: appSlug(paths[outcomes.indexOf(code)]!), retrySafe };
}
