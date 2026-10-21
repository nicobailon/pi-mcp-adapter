import { appendFileSync } from "node:fs";
import readline from "node:readline";

// Follows Executor's model-mode pause contract (executor@2.0.0-beta.25): `call` and `execute`
// return a pending structuredContent, and `resume({requestId, response})` continues the program.
// EXECUTOR_SERVER_NAME lets a test present the same tools under another server name.
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
const pending = {
  call: {
    status: "approval-required",
    requestId: "apr_1",
    invocation: { app: "gmail", tool: "send_email", args: { to: "a@example.com" } },
    elicitation: {
      mode: "form",
      message: "Approve gmail.send_email?",
      requestedSchema: { type: "object", properties: {} },
      _meta: { "executor/approval": true },
    },
    expiresAt,
  },
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
  if (requestId === "elc_1" && response?.action === "accept") {
    return completed(`inbox ${response.content?.inbox}`);
  }
  return { status: "unavailable", requestId, reason: "not-found", message: "That request is no longer waiting." };
}

const tools = [
  { name: "execute", inputSchema: { type: "object", properties: { code: { type: "string" } } } },
  { name: "call", inputSchema: { type: "object", properties: { path: { type: "string" }, args: { type: "object" } } } },
  {
    name: "resume",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" }, response: { type: "object" } },
      required: ["requestId", "response"],
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
    respond(request.id, toolResult(name === "resume" ? resume(args) : pending[name]));
  } else if (request.id !== undefined) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    })}\n`);
  }
});
