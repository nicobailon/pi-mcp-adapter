import type { McpConfig, ServerEntry } from "./types.ts";
export declare function isBuiltInAgentPlugin(definition: ServerEntry): boolean;
export declare function clearBuiltInAgentPlugin(definition: ServerEntry): void;
export interface AgentPluginSummary {
    path: string;
    name?: string;
    serverCount: number;
}
export declare function loadAgentPluginConfigs(paths: unknown, cwd?: string): McpConfig;
export declare function getAgentPluginSummaries(paths: unknown, cwd?: string): AgentPluginSummary[];
