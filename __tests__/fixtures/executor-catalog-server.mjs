import { appendFileSync, existsSync } from "node:fs";
import readline from "node:readline";

// Follows Executor's app catalog contract (executor@2.0.0-beta.25, contracts/execute.ts): `search`
// lists every tool in app and name order for an empty query, each page ends at `limit` or at the
// 25,000-byte page budget, whichever comes first, and `next` is the input for the following page.
// Payloads are shaped after a recorded local Executor run. Unlike Executor, `search` declares no
// outputSchema, so a malformed page reaches the adapter's own check instead of the SDK's.
//
// EXECUTOR_LOG_FILE: receipt log, one JSON line per request (and per search page served).
// EXECUTOR_SERVER_NAME: another serverInfo name, which makes this a non-Executor server.
// EXECUTOR_CATALOG_APPS / EXECUTOR_CATALOG_TOOLS: apps and tools per app (default 3 × 400).
// EXECUTOR_CATALOG_PRIVATE=1: a 2026-07-28 tools/list declares ttlMs 0 and cacheScope private
// instead of a one-hour public listing.
// EXECUTOR_CATALOG_UNAVAILABLE: comma-separated app names `search` reports as unavailable.
// EXECUTOR_CATALOG_MALFORMED=no-path|items|remaining: every page after the first is malformed that way.
// EXECUTOR_SEARCH_GATE: a path; `search` answers only once that file exists.
// EXECUTOR_CATALOG_OWN=<n>: the catalog starts with n of Executor's own `tools.executor.*` tools, as a real one does.
const lines = readline.createInterface({ input: process.stdin });
const logFile = process.env.EXECUTOR_LOG_FILE;
const serverInfo = { name: process.env.EXECUTOR_SERVER_NAME ?? "Executor", version: "0.1.0" };
const PAGE_BYTES = 25_000;
let modern = false;

function record(event) {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(event)}\n`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function toolResult(structuredContent) {
  const body = { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  return modern ? { resultType: "complete", ...body } : body;
}

const appNames = ["alpha", "beta", "gamma", "delta", "epsilon"].slice(0, Number(process.env.EXECUTOR_CATALOG_APPS ?? 3));
const toolsPerApp = Number(process.env.EXECUTOR_CATALOG_TOOLS ?? 400);
const ownTools = Array.from({ length: Number(process.env.EXECUTOR_CATALOG_OWN ?? 0) }, (_, index) => ({
  path: index === 0 ? "tools.executor.apps.list" : `tools.executor.admin.op_${String(index).padStart(3, "0")}`,
  description: "Manage this Executor, the way its own admin API describes a tool on one line.",
  input: "{ query?: { owner?: string | null } }",
}));
const catalog = [...ownTools, ...appNames.flatMap(app => Array.from({ length: toolsPerApp }, (_, index) => {
  const tool = `tool_${String(index).padStart(3, "0")}`;
  return {
    path: `tools.${app}.${tool}`,
    description: `Read the ${app} fixture record number ${index}, the way an Executor app tool describes itself on one line.`,
    input: "{ id: string, limit?: number, [key: string]: unknown }",
  };
}))];
const unavailable = (process.env.EXECUTOR_CATALOG_UNAVAILABLE ?? "").split(",").filter(Boolean);

function namespacesOf(items) {
  const apps = [...new Set(items.map(item => item.path.split(".")[1]))];
  // Executor lists each app's linked accounts; the adapter must not keep them.
  return apps.map(app => ({ path: `tools.${app}`, app, accounts: `${app}: acc_fixture_${app} (Fixture account)` }));
}

function search({ query = "", limit = 10, offset = 0 } = {}) {
  const items = [];
  for (const item of catalog.slice(offset, offset + limit)) {
    if (items.length > 0 && JSON.stringify({ items: [...items, item], namespaces: namespacesOf([...items, item]) }).length > PAGE_BYTES) break;
    items.push(item);
  }
  const end = offset + items.length;
  const page = {
    items,
    namespaces: namespacesOf(items),
    remaining: catalog.length - end,
    next: end < catalog.length ? { query, limit, offset: end } : null,
    unavailableApps: unavailable.map(name => ({
      app: `app_${name}`,
      name,
      reason: JSON.stringify({ code: "AppAccountRequired", status: 409, message: "This app needs an account, and none is linked to it for you.", retryable: false }),
    })),
  };
  const malformed = offset > 0 ? process.env.EXECUTOR_CATALOG_MALFORMED : undefined;
  if (malformed === "no-path") page.items = page.items.map(({ path: _path, ...item }) => item);
  if (malformed === "items") page.items = { path: "tools.alpha.tool_000" };
  if (malformed === "remaining") page.remaining = "many";
  record({ served: "search", offset, returned: items.length, next: page.next?.offset ?? null });
  return page;
}

function describe({ paths = [] } = {}) {
  const found = paths.map(path => catalog.find(item => item.path === path || item.path === `tools.${path}`)).filter(Boolean);
  return {
    items: found.map(item => ({ path: item.path, description: item.description, signature: "(input: {\n  id: string,\n  limit?: number,\n  [key: string]: unknown,\n}): Promise<unknown>" })),
    namespaces: namespacesOf(found),
    missing: paths.filter(path => !found.some(item => item.path === path || item.path === `tools.${path}`)).map(path => ({ path, matches: [] })),
  };
}

async function waitForGate() {
  const gate = process.env.EXECUTOR_SEARCH_GATE;
  while (gate && !existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 20));
}

// `call` with the object form of `calls`, answered with Executor's CallOutcome. An even-numbered
// tool returns an object, an odd-numbered one a string; `input.fail` fails the tool with a curated
// response, `input.big: n` returns n characters, `input.malformed` returns a result Executor never
// sends, and `input.hold` never answers. EXECUTOR_CALL_APPROVAL=1 pauses every call for approval.
function finished(path, value) {
  return { status: "completed", execution: { ok: true, value, toolCalls: [{ name: path, outcome: value.ok ? "success" : "failure" }] }, unavailableApps: [] };
}

function callOutcome(calls) {
  const { path, input = {} } = calls;
  const item = catalog.find(candidate => candidate.path === path);
  if (!item) {
    return finished(path, { path, ok: false, error: { kind: "UnknownTool", message: `No tool at ${path}.` }, matches: catalog.slice(0, 2).map(tool => tool.path) });
  }
  if (input.malformed) return { status: "completed", execution: { ok: true, toolCalls: [] }, unavailableApps: [] };
  if (input.fail) {
    const response = { code: "NotFound", status: 404, message: "No such record.", recovery: { action: "Check the id." }, retryable: false };
    return finished(path.slice("tools.".length), { path: path.slice("tools.".length), ok: false, error: { kind: "ToolFailure", message: "NotFound (HTTP 404): No such record.", response } });
  }
  const value = typeof input.big === "number" ? "x".repeat(input.big)
    : Number(path.slice(-3)) % 2 === 1 ? `${path} record ${input.id ?? ""}` : { path, input };
  return finished(path, { path, ok: true, value });
}

let pendingCall;
function call(args) {
  const calls = args?.calls;
  if (typeof calls !== "object" || calls === null || Array.isArray(calls)) {
    return { status: "completed", execution: { ok: false, error: { kind: "InvalidInput", message: "calls must be one call" }, toolCalls: [] }, unavailableApps: [] };
  }
  if (process.env.EXECUTOR_CALL_APPROVAL !== "1") return callOutcome(calls);
  pendingCall = calls;
  return {
    status: "approval-required",
    requestId: "apr_app_1",
    elicitation: { mode: "form", message: `Approve ${calls.path}?`, requestedSchema: { type: "object", properties: {} } },
    expiresAt: Date.now() + 60_000,
  };
}

function resume({ requestId, response }) {
  if (requestId !== "apr_app_1" || !pendingCall) return { status: "unavailable", requestId, reason: "not-found", message: "That request is no longer waiting." };
  const calls = pendingCall;
  pendingCall = undefined;
  return response?.action === "accept"
    ? callOutcome(calls)
    : finished(calls.path, { path: calls.path, ok: false, error: { kind: "ApprovalDeclined", message: `${calls.path} was not approved.` } });
}

const tools = [
  { name: "search", inputSchema: { type: "object", properties: { query: { type: "string" }, namespace: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } } }, annotations: { readOnlyHint: true, destructiveHint: false } },
  { name: "describe", inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] } },
  { name: "call", inputSchema: { type: "object", properties: { calls: { type: "object" } }, required: ["calls"] } },
  { name: "execute", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
  {
    name: "resume",
    inputSchema: { type: "object", properties: { requestId: { type: "string" }, response: { type: "object" } }, required: ["requestId", "response"] },
  },
];

lines.on("line", async line => {
  const request = JSON.parse(line);
  if (request.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28") modern = true;
  if (request.id !== undefined) record({ method: request.method, ...(request.params?.name ? { name: request.params.name, arguments: request.params.arguments } : {}) });
  if (request.method === "server/discover") {
    modern = true;
    respond(request.id, {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
    });
  } else if (request.method === "initialize") {
    respond(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo });
  } else if (request.method === "tools/list") {
    const hints = process.env.EXECUTOR_CATALOG_PRIVATE === "1" ? { ttlMs: 0, cacheScope: "private" } : { ttlMs: 3_600_000, cacheScope: "public" };
    respond(request.id, modern ? { resultType: "complete", ...hints, tools } : { tools });
  } else if (request.method === "tools/call") {
    const { name, arguments: args } = request.params;
    if (name === "search") {
      await waitForGate();
      respond(request.id, toolResult(search(args)));
    } else if (name === "describe") {
      respond(request.id, toolResult(describe(args)));
    } else if (name === "call") {
      if (!args?.calls?.input?.hold) respond(request.id, toolResult(call(args)));
    } else if (name === "resume") {
      respond(request.id, toolResult(resume(args)));
    } else {
      respond(request.id, { content: [{ type: "text", text: `${name} is not part of this fixture` }], isError: true });
    }
  } else if (request.id !== undefined) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    })}\n`);
  }
});
