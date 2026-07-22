import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const pidPath = process.env.MCP_RELOAD_PID_DIR ? join(process.env.MCP_RELOAD_PID_DIR, `${process.pid}.pid`) : undefined;
if (pidPath) await writeFile(pidPath, String(process.pid));
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (pidPath) await unlink(pidPath).catch(() => {});
    process.exit(0);
  });
}
process.on("exit", () => { if (pidPath) void unlink(pidPath).catch(() => {}); });

const server = new Server({ name: "delayed-reload-fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
  return { tools: [] };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
await server.connect(new StdioServerTransport());
