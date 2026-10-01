import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Lists its tools but fails to list the resources and prompts it advertises.
const server = new Server(
  { name: "catalog-failure-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "list", description: "List things", inputSchema: { type: "object" } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));
server.setRequestHandler(ListResourcesRequestSchema, async () => { throw new Error("resources unavailable"); });
server.setRequestHandler(ListPromptsRequestSchema, async () => { throw new Error("prompts unavailable"); });

await server.connect(new StdioServerTransport());
