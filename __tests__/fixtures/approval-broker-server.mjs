import { appendFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "approval-broker-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "echo",
    description: "Echo a value and record receipt",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await appendFile(process.env.MCP_APPROVAL_RECEIPTS, `${JSON.stringify(request.params)}\n`);
  return { content: [{ type: "text", text: request.params.arguments.value }] };
});
await server.connect(new StdioServerTransport());
