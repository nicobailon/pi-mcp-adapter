import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mcp-code-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a value",
      inputSchema: {
        type: "object",
        properties: { value: {} },
      },
    },
    {
      name: "fail",
      description: "Return an MCP tool error",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "hang",
      description: "Never resolves",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "sized",
      description: "Return an exact-sized UTF-8 JSON result",
      inputSchema: { type: "object", properties: { bytes: { type: "integer" }, multibyte: { type: "boolean" } }, required: ["bytes"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "sized") {
    const result = { content: [], structuredContent: { padding: "", rows: [7] } };
    const remaining = request.params.arguments.bytes - Buffer.byteLength(JSON.stringify(result));
    result.structuredContent.padding = request.params.arguments.multibyte
      ? "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2)
      : "x".repeat(remaining);
    return result;
  }
  if (request.params.name === "fail") {
    return { isError: true, content: [{ type: "text", text: "fixture failure" }] };
  }
  if (request.params.name === "hang") {
    return new Promise(() => {});
  }
  return {
    content: [{ type: "text", text: String(request.params.arguments?.value ?? "") }],
    structuredContent: { echoed: request.params.arguments?.value },
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "fixture://text", name: "resource" }, { uri: "fixture://empty", name: "empty" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: request.params.uri === "fixture://empty" ? [] : [
    { uri: request.params.uri, text: "first" },
    { uri: request.params.uri, text: "second" },
  ],
}));

await server.connect(new StdioServerTransport());
