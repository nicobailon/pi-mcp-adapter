import { runMcpScript } from "../../mcp-code.ts";
import type { McpExtensionState } from "../../state.ts";

const state = {
  owner: undefined,
  toolMetadata: new Map(),
  config: { settings: {} },
} as unknown as McpExtensionState;

for (let index = 0; index < 32; index += 1) {
  const result = await runMcpScript(state, 'emit("ok")', 5_000);
  if (result.details.error) {
    throw new Error(`mcpScript failed: ${JSON.stringify(result.details)}`);
  }
}

process.stdout.write("completed 32 mcpScript workers\n");
