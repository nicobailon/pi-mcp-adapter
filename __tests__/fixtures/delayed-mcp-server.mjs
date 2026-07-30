import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const pidPath = process.env.MCP_RELOAD_PID_DIR ? join(process.env.MCP_RELOAD_PID_DIR, `${process.pid}.json`) : undefined;
const identity = { pid: process.pid, toolName: "reload_identity" };
if (pidPath) {
  const pendingPath = `${pidPath}.tmp`;
  await writeFile(pendingPath, JSON.stringify(identity));
  await rename(pendingPath, pidPath);
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}

const server = new Server(
  { name: "delayed-reload-fixture", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
  return {
    tools: [{ name: identity.toolName, description: "reload identity", inputSchema: { type: "object", properties: {} } }],
  };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
await server.connect(new StdioServerTransport());
