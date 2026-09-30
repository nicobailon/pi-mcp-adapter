import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const STEPS = 10;
const STEP_MS = 100;

const server = new Server(
  { name: "progress-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "slow", inputSchema: { type: "object", properties: {} } }],
}));

// Runs for STEPS * STEP_MS and reports progress after each step when the client asked for it.
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const progressToken = request.params._meta?.progressToken;
  for (let step = 1; step <= STEPS; step++) {
    await new Promise(resolve => setTimeout(resolve, STEP_MS));
    if (progressToken !== undefined) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: step, total: STEPS },
      });
    }
  }
  return { content: [{ type: "text", text: "finished" }] };
});

await server.connect(new StdioServerTransport());
