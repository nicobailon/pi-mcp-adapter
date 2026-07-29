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
    reject(request.id, "server/discover is not supported");
    return;
  }
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "legacy-no-discover", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [{
        name: "classic_initialize_reached",
        description: "Classic initialize completed",
        inputSchema: { type: "object", properties: {} },
      }],
    });
    return;
  }
  if (request.id !== undefined) {
    reject(request.id, "Method not found");
  }
});
