import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// A minimal MCP server that advertises the `prompts` capability and returns
// deterministic content, used by prompts-sdk-integration.test.ts to exercise
// the adapter's prompts pipeline against real SDK dispatch.
const server = new Server(
  { name: "prompts-integration-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: { listChanged: false } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "noop", inputSchema: { type: "object", properties: {} } }],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "ok" }],
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "brief",
      description: "Daily brief on a topic",
      arguments: [
        { name: "topic", description: "Topic to summarize", required: true },
        { name: "date", description: "Optional ISO date", required: false },
      ],
    },
    {
      name: "haiku",
      description: "Compose a haiku",
      arguments: [],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === "brief") {
    const topic = typeof args.topic === "string" ? args.topic : "(missing)";
    const date = typeof args.date === "string" ? args.date : "today";
    return {
      description: "Daily brief",
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Give me the brief on ${topic} for ${date}.` },
        },
      ],
    };
  }
  if (name === "haiku") {
    return {
      description: "Haiku",
      messages: [
        { role: "user", content: { type: "text", text: "Write a haiku about MCP." } },
        { role: "assistant", content: { type: "text", text: "Bridges of context…" } },
      ],
    };
  }
  throw new Error(`Unknown prompt: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
