import type { McpConfig, ServerEntry } from "./types.ts";
declare const LITERAL_PLUGIN_FIELDS: readonly ["args", "env", "cwd", "headers"];
type LiteralPluginField = typeof LITERAL_PLUGIN_FIELDS[number];
export declare function isBuiltInAgentPlugin(definition: ServerEntry, field: LiteralPluginField): boolean;
export declare function preserveBuiltInAgentPluginFields(target: ServerEntry, base: ServerEntry, next: ServerEntry): void;
export interface AgentPluginSummary {
    path: string;
    name?: string;
    serverCount: number;
}
export declare function loadAgentPluginConfigs(paths: unknown, cwd?: string): McpConfig;
export declare function getAgentPluginSummaries(paths: unknown, cwd?: string): AgentPluginSummary[];
export {};
