import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ServerEntry } from "./types.js";

export const MCP_COLLECT_SERVERS_EVENT = "pi-mcp-adapter:collect-servers";

export interface McpServerContribution {
  source: string;
  priority?: number;
  servers: Record<string, ServerEntry>;
}

export interface CollectMcpServersEvent {
  add: (contribution: McpServerContribution | McpServerContribution[]) => void;
}

export function registerMcpServerProvider(
  pi: ExtensionAPI,
  provider: () => McpServerContribution | McpServerContribution[] | void,
): void {
  pi.events.on(MCP_COLLECT_SERVERS_EVENT, (event) => {
    const collector = event as CollectMcpServersEvent;
    try {
      const contribution = provider();
      if (!contribution) return;
      collector.add(contribution);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`MCP: provider failed while contributing servers: ${message}`);
    }
  });
}
