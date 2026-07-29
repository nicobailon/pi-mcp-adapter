import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "output-schema-integration-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const draft07Tuple = {
  type: "object",
  properties: {
    values: {
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
      additionalItems: false,
    },
  },
  required: ["values"],
};

const draft07Schema = { $schema: "http://json-schema.org/draft-07/schema#", ...draft07Tuple };
const draft07InvalidSchema = {
  $schema: "https://json-schema.org/draft-07/schema#",
  ...draft07Tuple,
};
const draft2020Tuple = {
  type: "object",
  properties: {
    values: {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
    },
  },
  required: ["values"],
};
const draft2020Schema = { $schema: "https://json-schema.org/draft/2020-12/schema", ...draft2020Tuple };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "draft07-valid", inputSchema: { type: "object" }, outputSchema: draft07Schema },
    { name: "draft07-invalid", inputSchema: { type: "object" }, outputSchema: draft07InvalidSchema },
    { name: "draft2020-valid", inputSchema: { type: "object" }, outputSchema: draft2020Schema },
    { name: "draft2020-invalid", inputSchema: { type: "object" }, outputSchema: draft2020Schema },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name;
  if (name === "draft07-valid" || name === "draft2020-valid") {
    return { structuredContent: { values: ["ok", 1] }, content: [{ type: "text", text: name }] };
  }
  if (name === "draft07-invalid") {
    return { structuredContent: { values: ["ok", 1, true] }, content: [{ type: "text", text: name }] };
  }
  if (name === "draft2020-invalid") {
    return { structuredContent: { values: ["ok", 1, true] }, content: [{ type: "text", text: name }] };
  }
  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
