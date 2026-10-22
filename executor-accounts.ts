import type { Client } from "@modelcontextprotocol/client";
import { throwIfAborted } from "./abort.ts";
import type { McpServerManager } from "./server-manager.ts";

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
  return isAccountCode(response.code) ? response.code : "other-failure";
}

function isAccountCode(code: unknown): code is AccountGap["code"] {
  return code === "AppAccountRequired" || code === "AccountRequired";
}

function namesMissingAccount(value: unknown): boolean {
  return (Array.isArray(value) ? value : [value]).some(outcome =>
    isRecord(outcome) && isRecord(outcome.error) && isRecord(outcome.error.response)
    && isAccountCode(outcome.error.response.code));
}

/** The path of a single call, the object form of `calls`. */
function requestPath(calls: unknown): string {
  if (isRecord(calls) && typeof calls.path === "string") return calls.path;
  throw new Error("Executor reported a missing account for a call request without paths");
}

/** The app a path names, canonicalised as Executor does: `tools["my-app"].read` and `my-app.read` both name `my-app`. */
function appSlug(path: string): string {
  const slug = canonicalPath(path).split(".")[0]!;
  if (!APP_SLUG.test(slug)) throw new Error(`Executor reported a missing account for "${path}", which names no app`);
  return slug;
}

export function canonicalPath(path: string): string {
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
 * `execute` results name no app, and re-running a batch would re-run every call in it, so both
 * return undefined and reach the model unchanged.
 * Only a result whose outcome carries an account code is parsed strictly; any other shape passes
 * through, so an Executor shape change cannot break unrelated calls.
 */
export function findAccountGap(params: ToolCallParams, result: object): AccountGap | undefined {
  if (params.name !== "call") return undefined;
  const calls = isRecord(params.arguments) ? params.arguments.calls : undefined;
  if (Array.isArray(calls)) return undefined;
  const content = (result as { structuredContent?: unknown }).structuredContent;
  if (!isRecord(content) || content.status !== "completed" || !isRecord(content.execution)) return undefined;
  const execution = content.execution;
  if (!namesMissingAccount(execution.value)) return undefined;
  if (execution.ok !== true || !Array.isArray(execution.toolCalls)) malformed();
  const toolCalls = execution.toolCalls.map(call => {
    if (!isRecord(call) || typeof call.name !== "string" || typeof call.outcome !== "string" || !TOOL_CALL_OUTCOMES.has(call.outcome)) {
      malformed();
    }
    return call.outcome;
  });
  if (Array.isArray(execution.value)) malformed();
  const code = parseOutcome(execution.value);
  if (code === "success") return undefined;
  if (!isAccountCode(code)) malformed();
  const path = requestPath(calls);
  // AccountRequired is raised while binding credentials, before any upstream request, so its one
  // `failure` entry ran nothing.
  const retrySafe = toolCalls.every(outcome => outcome === "failure") && toolCalls.length <= 1;
  return { code, slug: appSlug(path), retrySafe };
}

// Adapter-authored programs: fixed templates with only JSON.stringify-injected values. CodeMode
// reports every `tools.x.y` reference as a function, so the Executor app's groups are read with
// Object.keys: hosted has `context`, local has `accountConnections`.
export function connectProgram(slug: string): string {
  return `const slug = ${JSON.stringify(slug)};
const executor = tools.executor;
const groups = Object.keys(executor);
const hosted = groups.includes("context");
if (!hosted && !groups.includes("accountConnections")) return null;
const organization = hosted ? (await executor.context.get({})).organization : null;
const at = (path) => ({ path: hosted ? { organization, ...path } : path });
const apps = await executor.appManagement.list(hosted ? { path: { organization } } : {});
const app = apps.find((candidate) => candidate.slug === slug);
if (!app) return null;
const linked = (await executor.appAccounts.userList(at({ app: app.id }))).map((entry) => entry.requirement);
const missing = Object.entries(app.requirements.accounts)
  .filter(([name, requirement]) => requirement.scope === "user" && requirement.cardinality === "one" && !linked.includes(name))
  .map(([name]) => name);
if (missing.length !== 1) return null;
const link = await executor.appAccounts.userConnect({ ...at({ app: app.id, requirement: missing[0] }), body: {} });
return { hosted, requirement: missing[0], link };`;
}

function readProgram(hosted: boolean, connection: string): string {
  return hosted
    ? `const { organization } = await tools.executor.context.get({});
return (await tools.executor.accounts.connection({ path: { organization, connection: ${JSON.stringify(connection)} } })).state;`
    : `return (await tools.executor.accountConnections.get({ path: { connection: ${JSON.stringify(connection)} } })).state;`;
}

/** The program's value, or undefined when Executor reports a failure or a pause, which ends the flow. */
async function runProgram(call: (params: ToolCallParams) => Promise<object>, code: string): Promise<{ value: unknown } | undefined> {
  const result = await call({ name: "execute", arguments: { code } });
  const content = (result as { structuredContent?: unknown }).structuredContent;
  if (!isRecord(content)) {
    if ((result as { isError?: unknown }).isError === true) return undefined;
    throw new Error("Executor returned no structured result for Pi's account program");
  }
  if (content.status !== "completed") return undefined;
  const execution = content.execution;
  if (isRecord(execution) && execution.ok === false) return undefined;
  if (!isRecord(execution) || execution.ok !== true || !("value" in execution)) {
    throw new Error("Executor returned a malformed execution for Pi's account program");
  }
  return { value: execution.value };
}

/** The link fields this flow uses; hosted names the connection `id`, local names it `connection`. */
function parseLink(value: unknown): { hosted: boolean; requirement: string; connection: string; url: string } | undefined {
  if (value === null) return undefined;
  if (!isRecord(value) || typeof value.hosted !== "boolean" || typeof value.requirement !== "string" || value.requirement === "") {
    throw new Error("Executor returned a malformed account requirement");
  }
  const link = value.link;
  const connection = isRecord(link) ? (value.hosted ? link.id : link.connection) : undefined;
  if (typeof connection !== "string" || connection === "") throw new Error("Executor returned an account link without a connection id");
  if (!isRecord(link) || !isHttpUrl(link.url)) {
    throw new Error("Executor returned an account link without an HTTP URL");
  }
  return { hosted: value.hosted, requirement: value.requirement, connection, url: link.url };
}

function isHttpUrl(value: unknown): value is string {
  try {
    return typeof value === "string" && ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

const CONTINUE_FORM = {
  mode: "form" as const,
  message: "Finish connecting the account in your browser, then choose Continue.",
  requestedSchema: { type: "object" as const, properties: {} },
};

/**
 * Connects the account a gap needs: Executor issues a connection link, Pi opens it behind the
 * URL consent dialog, waits for Continue and reads the connection once. Returns "connected" when
 * the account is linked, "pending" when the operator continued before finishing, and "unchanged"
 * when nothing was connected and the original result stands. The link's URL and connection id
 * carry a bearer token on local Executor, so they go only to the consent dialog and the browser.
 */
export async function connectAccount({ gap, serverName, manager, signal, call }: {
  gap: AccountGap;
  serverName: string;
  manager: Pick<McpServerManager, "promptFormElicitation" | "urlElicitationPrompt">;
  signal?: AbortSignal | undefined;
  call: (params: ToolCallParams) => Promise<object>;
}): Promise<"connected" | "pending" | "unchanged"> {
  const promptUrl = manager.urlElicitationPrompt(serverName);
  if (!promptUrl) return "unchanged";
  throwIfAborted(signal);
  const issued = await runProgram(call, connectProgram(gap.slug));
  throwIfAborted(signal);
  const link = issued && parseLink(issued.value);
  if (!link) return "unchanged";
  const consent = await promptUrl({
    mode: "url",
    elicitationId: `executor-account-${gap.slug}`,
    url: link.url,
    message: `${gap.slug} needs your ${link.requirement} account before this call can run. Connect it in Executor, then come back to Pi.`,
  }, signal);
  throwIfAborted(signal);
  if (consent.action !== "accept") return "unchanged";
  const finished = await manager.promptFormElicitation(serverName, CONTINUE_FORM, signal);
  throwIfAborted(signal);
  if (finished?.action !== "accept") return "unchanged";
  const read = await runProgram(call, readProgram(link.hosted, link.connection));
  throwIfAborted(signal);
  if (!read) return "unchanged";
  if (!isRecord(read.value) || typeof read.value.status !== "string") {
    throw new Error("Executor returned a malformed account connection state");
  }
  if (read.value.status === "completed") return "connected";
  return read.value.status === "pending" ? "pending" : "unchanged";
}
