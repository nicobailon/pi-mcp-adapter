import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function reject(id, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message },
  })}\n`);
}

lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") {
    respond(request.id, {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "modern-discover",
          version: "1.0.0",
        },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, {
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      tools: [{
        name: "modern_discovery_reached",
        description: "MCP 2026-07-28 negotiation completed",
        inputSchema: { type: "object", properties: {} },
      }],
    });
    return;
  }
  if (request.id !== undefined) {
    reject(request.id, "Method not found");
  }
});
