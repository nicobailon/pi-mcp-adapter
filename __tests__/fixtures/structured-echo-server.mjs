import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "structured-echo-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
const valueSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo a value", inputSchema: valueSchema, outputSchema: valueSchema }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { value } = request.params.arguments;
  return { content: [{ type: "text", text: value }], structuredContent: { value } };
});
await server.connect(new StdioServerTransport());
