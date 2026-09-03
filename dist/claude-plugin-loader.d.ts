import { type ClaudePluginConfig, type McpConfig, type ServerEntry } from "./types.ts";
export interface ClaudePluginBundleResult {
    mcpServers: Record<string, ServerEntry>;
    skillPaths: string[];
}
export declare function loadClaudePluginBundles(plugins: readonly ClaudePluginConfig[] | undefined, cwd: string, validateConfig: (raw: unknown) => McpConfig, components: {
    mcp: boolean;
    skills: boolean;
}): ClaudePluginBundleResult;
