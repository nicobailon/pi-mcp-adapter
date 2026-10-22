import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "structured-echo-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
const valueSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
// Over the adapter's 50 KB output guard limit.
const large = JSON.stringify(Array.from({ length: 2000 }, (_, id) => ({ id, title: `Item ${id}`, body: "x".repeat(30) })));
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo a value", inputSchema: valueSchema, outputSchema: valueSchema },
    { name: "large", description: "Return a large JSON list", inputSchema: { type: "object", properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "large") return { content: [{ type: "text", text: large }] };
  const { value } = request.params.arguments;
  return { content: [{ type: "text", text: value }], structuredContent: { value } };
});
await server.connect(new StdioServerTransport());
