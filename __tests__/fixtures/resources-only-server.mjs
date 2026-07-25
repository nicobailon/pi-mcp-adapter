import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

// A minimal MCP server that advertises resources only — no `tools`, no
// `prompts`. Used by resources-capability.test.ts to check that the adapter
// connects without aborting when tools/list is not supported, the spec-
// canonical shape for read-only data sources.
const server = new Server(
  { name: "resources-only-server", version: "1.0.0" },
  { capabilities: { resources: {} } },
);

const resource = {
  name: "resource_name",
  uri: "test://uri",
  description: "Test resource",
  mimeType: "application/json",
};

server.setRequestHandler("resources/list", async () => ({ resources: [resource] }));

server.setRequestHandler("resources/read", async () => ({
  contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: '{"status":"ok"}' }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
