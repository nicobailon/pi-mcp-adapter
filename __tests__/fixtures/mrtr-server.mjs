import { appendFileSync } from "node:fs";
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const logFile = process.env.MRTR_LOG_FILE;
let modern = false;
const ONE_ROUND_STATE = "one-round-state:v1";
const FIRST_ROUND_STATE = "two-round-state:first:v1";
const SECOND_ROUND_STATE = "two-round-state:second:v1";

function record(event) {
  if (!logFile) return;
  appendFileSync(logFile, `${JSON.stringify(event)}\n`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function reject(id, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32602, message },
  })}\n`);
}

function result(body) {
  return modern ? { resultType: "complete", ...body } : body;
}

function elicitationRequest(key, message) {
  return {
    [key]: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message,
        requestedSchema: { type: "object", properties: {} },
      },
    },
  };
}

function hasAcceptedResponse(params, key) {
  const response = params?.inputResponses?.[key];
  return response?.action === "accept";
}

function handleTool(request) {
  const params = request.params ?? {};
  const name = params.name;
  record({ method: "tools/call", name, params });

  if (name === "one_round") {
    if (hasAcceptedResponse(params, "one-round-input")) {
      respond(request.id, result({ content: [{ type: "text", text: "one-round complete" }] }));
    } else if (params.inputResponses === undefined) {
      respond(request.id, {
        resultType: "input_required",
        inputRequests: elicitationRequest("one-round-input", "Confirm one round"),
        requestState: ONE_ROUND_STATE,
      });
    } else {
      reject(request.id, "one_round did not receive an accepted input response");
    }
    return;
  }

  if (name === "two_rounds") {
    if (params.inputResponses === undefined) {
      respond(request.id, {
        resultType: "input_required",
        inputRequests: elicitationRequest("first-round-input", "Confirm the first round"),
        requestState: FIRST_ROUND_STATE,
      });
    } else if (params.requestState === FIRST_ROUND_STATE && hasAcceptedResponse(params, "first-round-input")) {
      respond(request.id, {
        resultType: "input_required",
        inputRequests: elicitationRequest("second-round-input", "Confirm the second round"),
        requestState: SECOND_ROUND_STATE,
      });
    } else if (params.requestState === SECOND_ROUND_STATE && hasAcceptedResponse(params, "second-round-input")) {
      respond(request.id, result({ content: [{ type: "text", text: "two-round complete" }] }));
    } else {
      reject(request.id, `two_rounds received an unexpected requestState: ${String(params.requestState)}`);
    }
    return;
  }

  if (name === "needs_ui" || name === "abort_pending") {
    respond(request.id, {
      resultType: "input_required",
      inputRequests: elicitationRequest(
        name === "abort_pending" ? "abort-pending-input" : "missing-ui-input",
        name === "abort_pending" ? "Wait for input" : "Input is required",
      ),
      requestState: `${name}-state:v1`,
    });
    return;
  }

  if (name === "legacy_complete") {
    respond(request.id, modern
      ? result({ content: [{ type: "text", text: "modern complete" }] })
      : { content: [{ type: "text", text: "legacy complete" }] });
    return;
  }

  reject(request.id, `Unknown tool: ${String(name)}`);
}

function handleReadResource(request) {
  const uri = request.params?.uri;
  record({ method: "resources/read", uri, params: request.params });

  if (uri === "test://mrtr/resource") {
    const key = "resource-input";
    const params = request.params ?? {};
    if (params.inputResponses === undefined) {
      respond(request.id, {
        resultType: "input_required",
        inputRequests: elicitationRequest(key, "Confirm resource read"),
        requestState: "resource-state:v1",
      });
    } else if (params.requestState === "resource-state:v1" && hasAcceptedResponse(params, key)) {
      respond(request.id, result({ ttlMs: 0, cacheScope: "private", contents: [{ uri, mimeType: "text/plain", text: "resource complete" }] }));
    } else {
      reject(request.id, "resource read received an unexpected input response");
    }
    return;
  }

  if (uri === "ui://mrtr/resource") {
    const key = "ui-resource-input";
    const params = request.params ?? {};
    if (params.inputResponses === undefined) {
      respond(request.id, {
        resultType: "input_required",
        inputRequests: elicitationRequest(key, "Confirm UI resource read"),
        requestState: "ui-resource-state:v1",
      });
    } else if (params.requestState === "ui-resource-state:v1" && hasAcceptedResponse(params, key)) {
      respond(request.id, result({ ttlMs: 0, cacheScope: "private", contents: [{ uri, mimeType: "text/html", text: "<main>resource UI complete</main>" }] }));
    } else {
      reject(request.id, "UI resource read received an unexpected input response");
    }
    return;
  }

  reject(request.id, `Unknown resource: ${String(uri)}`);
}

lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28") {
    modern = true;
  }
  if (request.method === "server/discover") {
    modern = true;
    respond(request.id, {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {}, resources: {} },
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "mrtr",
          version: "1.0.0",
        },
      },
    });
    return;
  }
  if (request.method === "initialize") {
    modern = false;
    respond(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "mrtr", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, modern
      ? {
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
          tools: [
            { name: "one_round", description: "One input-required round", inputSchema: { type: "object", properties: {} } },
            { name: "two_rounds", description: "Two input-required rounds", inputSchema: { type: "object", properties: {} } },
            { name: "needs_ui", description: "Needs an input handler", inputSchema: { type: "object", properties: {} } },
            { name: "abort_pending", description: "Waits for a pending input handler", inputSchema: { type: "object", properties: {} } },
            { name: "legacy_complete", description: "Legacy result without a resultType", inputSchema: { type: "object", properties: {} } },
          ],
        }
      : {
          tools: [
            { name: "one_round", description: "One input-required round", inputSchema: { type: "object", properties: {} } },
            { name: "two_rounds", description: "Two input-required rounds", inputSchema: { type: "object", properties: {} } },
            { name: "needs_ui", description: "Needs an input handler", inputSchema: { type: "object", properties: {} } },
            { name: "abort_pending", description: "Waits for a pending input handler", inputSchema: { type: "object", properties: {} } },
            { name: "legacy_complete", description: "Legacy result without a resultType", inputSchema: { type: "object", properties: {} } },
          ],
        });
    return;
  }
  if (request.method === "resources/list") {
    respond(request.id, modern
      ? {
          resultType: "complete",
          ttlMs: 0,
          cacheScope: "private",
          resources: [
            { uri: "test://mrtr/resource", name: "MRTR resource", mimeType: "text/plain" },
            { uri: "ui://mrtr/resource", name: "MRTR UI resource", mimeType: "text/html" },
          ],
        }
      : {
          resources: [
            { uri: "test://mrtr/resource", name: "MRTR resource", mimeType: "text/plain" },
            { uri: "ui://mrtr/resource", name: "MRTR UI resource", mimeType: "text/html" },
          ],
        });
    return;
  }
  if (request.method === "tools/call") {
    handleTool(request);
    return;
  }
  if (request.method === "resources/read") {
    handleReadResource(request);
    return;
  }
  if (request.id !== undefined) reject(request.id, `Method not found: ${request.method}`);
});
