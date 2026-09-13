import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "argv-echo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    literalEnv: process.env.PLUGIN_LITERAL_ENV,
    protoEnv: process.env.__proto__,
  }) }],
}));
await server.connect(new StdioServerTransport());
