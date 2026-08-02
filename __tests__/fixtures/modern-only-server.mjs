#!/usr/bin/env node

// Strict MCP 2026-07-28 stdio fixture. It rejects legacy initialization and
// validates that every post-discovery request carries the negotiated revision.
import readline from "node:readline";

const MODERN_REVISION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: { resultType: "complete", ...value } });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === "server/discover") {
    result(message.id, {
      supportedVersions: [MODERN_REVISION],
      capabilities: { tools: { listChanged: true } },
      ttlMs: 0,
      cacheScope: "private",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "modern-only-test-server",
          version: "1.0.0",
        },
      },
    });
    return;
  }

  if (message.method === "initialize") {
    error(message.id, -32601, "Legacy initialize is not supported");
    return;
  }

  if (message.method === "subscriptions/listen") {
    if (message.params?.notifications?.toolsListChanged !== true) {
      error(message.id, -32602, "tools list-change subscription missing");
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: message.params.notifications,
        _meta: { [SUBSCRIPTION_ID_META_KEY]: message.id },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    if (message.params?._meta?.[PROTOCOL_VERSION_META_KEY] !== MODERN_REVISION) {
      error(message.id, -32602, "Missing negotiated protocol metadata");
      return;
    }

    result(message.id, {
      tools: [{
        name: "modern_tool",
        description: "Tool exposed only through the modern protocol",
        inputSchema: { type: "object", properties: {} },
      }],
      ttlMs: 60_000,
      cacheScope: "public",
    });
    return;
  }

  if (message.method === "tools/call") {
    const inputResponse = message.params?.inputResponses?.profile;
    if (inputResponse === undefined) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          resultType: "input_required",
          inputRequests: {
            profile: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Provide a profile name",
                requestedSchema: {
                  type: "object",
                  properties: { name: { type: "string", title: "Name" } },
                  required: ["name"],
                },
              },
            },
          },
          requestState: "modern-state-1",
        },
      });
      return;
    }

    if (message.params?.requestState !== "modern-state-1") {
      error(message.id, -32602, "requestState was not echoed");
      return;
    }
    const name = inputResponse.action === "accept" ? inputResponse.content?.name : undefined;
    result(message.id, {
      content: [{ type: "text", text: `accepted:${name ?? inputResponse.action}` }],
    });
    return;
  }

  if (message.id !== undefined) {
    error(message.id, -32601, `Unsupported method: ${message.method}`);
  }
});
