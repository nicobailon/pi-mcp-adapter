import { appendFileSync } from "node:fs";
import readline from "node:readline";

// Follows Executor's model-mode pause contract (executor@2.0.0-beta.25): `call` and `execute`
// return a pending structuredContent, and `resume({requestId, response})` continues the program.
// EXECUTOR_SERVER_NAME lets a test present the same tools under another server name.
// EXECUTOR_RESUME_SCHEMA=browser gives `resume` browser mode's input, a requestId only.
// EXECUTOR_ACCOUNT_MODE=local|hosted makes `call` into tools["needs-account"] fail with
// AppAccountRequired until an account is connected, and answers the adapter's Executor-app
// programs with that product's shapes, matched by program text. EXECUTOR_ACCOUNT_STATE sets the
// connection state the read returns (default completed); EXECUTOR_ACCOUNT_LINKS=never keeps the
// account missing after a completed connection; EXECUTOR_NO_EXECUTOR_APP=1 has no Executor app.
const lines = readline.createInterface({ input: process.stdin });
const logFile = process.env.EXECUTOR_LOG_FILE;
const serverInfo = { name: process.env.EXECUTOR_SERVER_NAME ?? "Executor", version: "0.1.0" };
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

function completed(result, outcome = "success") {
  return {
    status: "completed",
    execution: { result, toolCalls: [{ name: "gmail.send_email", outcome }] },
    unavailableApps: [],
  };
}

const expiresAt = Date.now() + 15 * 60 * 1000;
const sendArgs = { to: "a@example.com" };

// Same message shape as Executor's approvalElicitation: the tool name, then its exact arguments.
function approval(requestId) {
  return {
    status: "approval-required",
    requestId,
    invocation: { app: "gmail", tool: "send_email", args: sendArgs },
    elicitation: {
      mode: "form",
      message: `Approve gmail.send_email?\n\nArguments:\n${JSON.stringify(sendArgs, null, 2)}`,
      requestedSchema: { type: "object", properties: {} },
      _meta: { "executor/approval": true },
    },
    expiresAt,
  };
}

const pending = {
  call: approval("apr_1"),
  execute: {
    status: "input-required",
    requestId: "elc_1",
    tool: { app: "gmail", tool: "pick_inbox" },
    elicitation: {
      mode: "form",
      message: "Which inbox?",
      requestedSchema: { type: "object", properties: { inbox: { type: "string" } }, required: ["inbox"] },
    },
    expiresAt,
  },
};

function resume({ requestId, response }) {
  if (requestId === "apr_1") {
    return response?.action === "accept"
      ? completed("email sent")
      : completed(`send_email was not approved: ${response?.action}`, "failure");
  }
  if (requestId === "apr_2" && response?.action === "accept") return pending.execute;
  const chain = /^apr_pause_(\d+)_of_(\d+)$/.exec(requestId);
  if (chain && response?.action === "accept") {
    const [step, total] = [Number(chain[1]), Number(chain[2])];
    return step < total ? approval(`apr_pause_${step + 1}_of_${total}`) : completed(`done after ${total} pauses`);
  }
  if (requestId === "elc_1" && response?.action === "accept") {
    return completed(`inbox ${response.content?.inbox}`);
  }
  // Test shim: Executor returns busy only for a concurrent resume on the same run.
  if (requestId === "elc_1" && response?.action === "cancel") return { status: "busy", requestId };
  if (requestId === "elc_1") {
    return { status: "unavailable", requestId, reason: "answered", message: "That question was already answered." };
  }
  return { status: "unavailable", requestId, reason: "not-found", message: "That request is no longer waiting." };
}

const accountMode = process.env.EXECUTOR_ACCOUNT_MODE;
const links = {
  local: { connection: "conn_local_1", url: "http://127.0.0.1:4788/account-connect#token=fixture-secret", expiresAt: "2026-10-22T00:30:00.000Z" },
  hosted: {
    id: "conn_hosted_1",
    target: { app: "app_1", requirement: "service", name: "Needs Account" },
    url: "https://executor.test/org/acme/connections/conn_hosted_1",
    state: { status: "pending" },
    expiresAt: "2026-10-22T00:30:00.000Z",
  },
};
let linked = false;

function finished(execution) {
  return { status: "completed", execution: { toolCalls: [], ...execution }, unavailableApps: [] };
}

function accountCall(path) {
  if (linked) {
    return finished({ ok: true, value: { path, ok: true, value: "needs-account data" }, toolCalls: [{ name: path, outcome: "success" }] });
  }
  const response = {
    code: "AppAccountRequired",
    status: 409,
    message: "This app needs an account, and none is linked to it for you.",
    recovery: { action: "Connect an account", instructions: "Connect an account in Executor, then start a new execution." },
    retryable: false,
  };
  return finished({ ok: true, value: { path, ok: false, error: { kind: "ToolFailure", message: response.message, response } } });
}

// Executor runs the adapter's program; this fixture recognises each fixed template instead.
function executorProgram(code) {
  const unknown = finished({ ok: false, error: { kind: "UnknownTool", message: "Unknown tool namespace 'executor'." } });
  if (process.env.EXECUTOR_NO_EXECUTOR_APP === "1") return unknown;
  const link = links[accountMode];
  const id = accountMode === "hosted" ? link.id : link.connection;
  if (code.includes("appAccounts.userConnect(") && code.includes('"needs-account"')) {
    return finished({ ok: true, value: { hosted: accountMode === "hosted", requirement: "service", link } });
  }
  const read = accountMode === "hosted" ? "tools.executor.accounts.connection(" : "tools.executor.accountConnections.get(";
  if (!code.includes(read) || !code.includes(JSON.stringify(id))) return unknown;
  const status = process.env.EXECUTOR_ACCOUNT_STATE ?? "completed";
  if (status === "completed" && process.env.EXECUTOR_ACCOUNT_LINKS !== "never") linked = true;
  return finished({ ok: true, value: status === "completed" ? { status, account: { id: "acc_1" } } : { status } });
}

function start(name, args) {
  if (accountMode && name === "call" && JSON.stringify(args?.calls ?? null).includes("needs-account")) {
    return accountCall(args.calls.path);
  }
  if (accountMode && name === "execute" && args?.code?.includes("tools.executor")) return executorProgram(args.code);
  if (name === "execute" && args?.code === "chain") return approval("apr_2");
  const pauses = /^pauses:(\d+)$/.exec(args?.code ?? "");
  if (name === "execute" && pauses) return approval(`apr_pause_1_of_${pauses[1]}`);
  return pending[name];
}

const resumeProperties = process.env.EXECUTOR_RESUME_SCHEMA === "browser"
  ? { requestId: { type: "string" } }
  : { requestId: { type: "string" }, response: { type: "object" } };

const tools = [
  { name: "execute", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
  { name: "call", inputSchema: { type: "object", properties: { path: { type: "string" }, args: { type: "object" } } } },
  {
    name: "resume",
    inputSchema: {
      type: "object",
      properties: resumeProperties,
      required: Object.keys(resumeProperties),
    },
  },
];

lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28") modern = true;
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
    respond(request.id, modern ? { resultType: "complete", ttlMs: 0, cacheScope: "private", tools } : { tools });
  } else if (request.method === "tools/call") {
    const { name, arguments: args } = request.params;
    record({ method: "tools/call", name, arguments: args });
    respond(request.id, toolResult(name === "resume" ? resume(args) : start(name, args)));
  } else if (request.id !== undefined) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    })}\n`);
  }
});
