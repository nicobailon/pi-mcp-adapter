import { appendFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "handoff-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
    // A schema the adapter's validator cannot compile, so only the server validates it.
    { name: "unresolved", description: "Unresolvable $ref", inputSchema: { type: "object", properties: { v: { $ref: "#/definitions/Missing" } } } },
    { name: "slow", description: "Answers after 10 seconds", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await appendFile(process.env.MCP_HANDOFF_RECEIPTS, `${JSON.stringify(request.params)}\n`);
  if (request.params.name === "slow") await new Promise(resolve => setTimeout(resolve, 10_000));
  return { content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }] };
});
await server.connect(new StdioServerTransport());
