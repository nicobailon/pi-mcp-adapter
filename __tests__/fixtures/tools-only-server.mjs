import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A minimal MCP server that advertises tools only — no `resources`, no
// `prompts`. Used by resources-capability.test.ts to check that the adapter
// skips resources/list instead of asking a server that cannot answer.
// `--tools N` replaces the single noop tool with N tools that have realistic
// input/output schemas, for bench/server-memory.mjs.
const server = new Server(
  { name: "tools-only-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

const toolsFlag = process.argv.indexOf("--tools");
const toolCount = toolsFlag === -1 ? 0 : Number(process.argv[toolsFlag + 1]);

if (toolCount > 0) {
  const tools = Array.from({ length: toolCount }, (_, j) => ({
    name: `action_${j}`,
    description: `Tool ${j}. ` + "Read or update the specified resource using these options. ".repeat(3),
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 12 }, (_, p) => [`field_${p}`, {
        type: p % 2 ? "string" : "integer",
        description: `Field ${p} for tool ${j}. ` + "An optional search or pagination parameter. ".repeat(2),
      }])),
    },
    outputSchema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, value: { type: "string" } } } } },
    },
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    const structuredContent = { items: [{ id: "1", value: "ok" }] };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  });
} else {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "noop", inputSchema: { type: "object", properties: {} } }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
}

const transport = new StdioServerTransport();
await server.connect(transport);
