import type { McpConfig, ServerEntry } from "./types.ts";
type LiteralPluginField = "args" | "env" | "cwd" | "headers";
export declare function isBuiltInAgentPlugin(definition: ServerEntry, field: LiteralPluginField): boolean;
export declare function clearBuiltInAgentPlugin(definition: ServerEntry): void;
export declare function preserveBuiltInAgentPluginFields(target: ServerEntry, base: ServerEntry, next: ServerEntry): void;
export interface AgentPluginSummary {
    path: string;
    name?: string;
    serverCount: number;
}
export declare function loadAgentPluginConfigs(paths: unknown, cwd?: string): McpConfig;
export declare function getAgentPluginSummaries(paths: unknown, cwd?: string): AgentPluginSummary[];
export {};
