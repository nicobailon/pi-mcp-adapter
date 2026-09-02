import { type AgentPluginSummary } from "./agent-plugin-loader.ts";
import { type HostConfigDiscovery, type McpConfig, type ServerEntry, type ImportKind, type ServerProvenance } from "./types.ts";
export interface KnownServerPreset {
    id: string;
    name: string;
    summary: string;
    entry: ServerEntry;
}
export declare const KNOWN_SERVER_PRESETS: readonly KnownServerPreset[];
interface ConfigSourceSpec {
    id: "shared-global" | "agents-global" | "agents-nested-global" | "pi-global" | "shared-project" | "pi-project";
    label: string;
    readPath: string;
    writePath: string;
    kind: "user" | "project" | "import";
    importKind?: string;
    shared: boolean;
    scope: "global" | "project";
}
export interface ConfigDiscoveryPath {
    label: string;
    path: string;
    exists: boolean;
}
export interface DiscoveredImportConfig {
    kind: ImportKind;
    path: string;
}
export interface ConfigDiscoverySource extends ConfigDiscoveryPath {
    id: ConfigSourceSpec["id"];
    scope: ConfigSourceSpec["scope"];
    kind: "shared" | "pi";
    serverCount: number;
}
export interface ImportConfigSummary extends DiscoveredImportConfig {
    serverCount: number;
}
export interface HostConfigSummary extends ImportConfigSummary {
    active: boolean;
}
export interface McpConfigConflict {
    serverName: string;
    sources: Array<{
        kind: "shared" | "pi" | "host";
        path: string;
    }>;
    winner: {
        kind: "shared" | "pi" | "host";
        path: string;
    };
}
export interface RepoPromptDiscovery {
    configured: boolean;
    configuredPath?: string;
    executablePath?: string;
    targetPath?: string;
    serverName?: string;
    entry?: ServerEntry;
}
export interface McpDiscoverySummary {
    sources: ConfigDiscoverySource[];
    imports: ImportConfigSummary[];
    hostConfigs: HostConfigSummary[];
    hostConfigDiscovery: HostConfigDiscovery;
    agentPlugins: AgentPluginSummary[];
    conflicts: McpConfigConflict[];
    hasAnyConfig: boolean;
    hasAnyDetectedPaths: boolean;
    hasSharedServers: boolean;
    hasPiOwnedServers: boolean;
    totalServerCount: number;
    fingerprint: string;
    repoPrompt: RepoPromptDiscovery;
}
export interface McpStandardConfigSummary {
    sources: ConfigDiscoverySource[];
    hasSharedServers: boolean;
    fingerprint: string;
}
export interface ConfigWritePreview {
    path: string;
    existed: boolean;
    changed: boolean;
    beforeText: string;
    afterText: string;
    diffText: string;
}
export type SharedConfigTarget = "project" | "global";
export declare function getPiGlobalConfigPath(overridePath?: string): string;
export declare function getGenericGlobalConfigPath(): string;
export declare function getProjectConfigPath(cwd?: string): string;
export declare function getProjectPiConfigPath(cwd?: string): string;
export declare function getSharedConfigPath(target: SharedConfigTarget, cwd?: string): string;
export declare function getConfigDiscoveryPaths(overridePath?: string, cwd?: string): ConfigDiscoveryPath[];
export declare function findAvailableImportConfigs(cwd?: string): DiscoveredImportConfig[];
export declare function getMcpStandardConfigSummary(overridePath?: string, cwd?: string): McpStandardConfigSummary;
export declare function getMcpDiscoverySummary(overridePath?: string, cwd?: string, options?: {
    includeHostConfigs?: boolean;
}): McpDiscoverySummary;
export declare function cloneMcpConfig(config: McpConfig): McpConfig;
export declare function loadMcpConfig(overridePath?: string, cwd?: string): McpConfig;
export interface ServerDisabledOverrideResult {
    path: string;
    changed: boolean;
}
/**
 * Persist only the disabled field in the project Pi layer. Enabling writes an
 * explicit false only when a lower-precedence source is itself disabled; this
 * writer never copies a server definition or its credentials into the file.
 */
export declare function writeProjectServerDisabledOverride(overridePath: string | undefined, cwd: string, serverName: string, disabled: boolean): ServerDisabledOverrideResult;
export declare function previewCompatibilityImports(importKinds: ImportKind[], overridePath?: string): ConfigWritePreview;
export declare function ensureCompatibilityImports(importKinds: ImportKind[], overridePath?: string): {
    path: string;
    added: ImportKind[];
};
export declare function buildStarterProjectConfig(): McpConfig;
export declare function previewStarterSharedConfig(target: SharedConfigTarget, cwd?: string): ConfigWritePreview;
export declare function writeStarterSharedConfig(target: SharedConfigTarget, cwd?: string): string;
export declare function previewStarterProjectConfig(cwd?: string): ConfigWritePreview;
export declare function writeStarterProjectConfig(cwd?: string): string;
export declare function previewSharedServerEntry(filePath: string, serverName: string, entry: ServerEntry): ConfigWritePreview;
export declare function writeSharedServerEntry(filePath: string, serverName: string, entry: ServerEntry): string;
export declare function getServerProvenance(overridePath?: string, cwd?: string): Map<string, ServerProvenance>;
export declare function writeDirectToolsConfig(changes: Map<string, true | string[] | false>, provenance: Map<string, ServerProvenance>, fullConfig: McpConfig): void;
export declare function resolveConfiguredOAuthDir(raw: unknown, cwd?: string): string | undefined;
export {};
