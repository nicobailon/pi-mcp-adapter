import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedMcpConfig } from "./config.ts";
import { type McpConfig, type ProjectServerBlock, type ProjectServerBlockReason, type ScriptToolDefinition, type ServerDefinition } from "./types.ts";
export interface ProjectTrustResult {
    config: McpConfig;
    blockedServers: Map<string, ProjectServerBlock>;
    /** Project script tools left out of `config.scriptTools`, by name. */
    blockedScriptTools?: Map<string, ProjectServerBlock>;
}
export declare function describeProjectServerBlock(reason: ProjectServerBlockReason): string;
export declare function disabledServerReason(blocked: ReadonlyMap<string, ProjectServerBlock> | undefined, name: string): string;
/** One line per blocked project script tool, for scriptToolIssues. */
export declare function describeBlockedScriptTool(name: string, block: ProjectServerBlock): string;
export declare function hasProjectServerDefinitions(config: McpConfig): boolean;
export declare function hasProjectScriptToolDefinitions(config: McpConfig): boolean;
/** The script-tool issues `loadMcpConfig` found in the config files of `config`; none for any other config. */
export declare function loadedScriptToolIssues(config: McpConfig): string[];
export declare function hashProjectServerDefinition(definition: ServerDefinition | ScriptToolDefinition): string;
export declare function canonicalProjectRoot(cwd: string): string;
export declare function approveProjectServer(cwd: string, serverName: string, definition: ServerDefinition): void;
/** The approval covers the entry as loaded, with its resolved file path, not the script file's bytes. */
export declare function approveProjectScriptTool(cwd: string, name: string, definition: ScriptToolDefinition): void;
/**
 * After the adapter edits config on the user's behalf (a panel save), re-approve each named project
 * server whose pre-edit definition was approved, so the edit does not revoke the approval. Only a
 * `directTools` change carries the approval over; any other difference, such as a concurrent edit to
 * the file, still needs a new approval. A server without a matching approval stays unapproved: an
 * adapter edit never creates one.
 */
export declare function keepProjectServerApprovals(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, before: McpConfig, after: McpConfig, serverNames: Iterable<string>): void;
export declare function applyProjectServerTrust(loaded: LoadedMcpConfig, ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui" | "isProjectTrusted">, options?: {
    allowUnapproved?: boolean;
}): Promise<ProjectTrustResult>;
export declare function applyProjectServerTrustToConfig(config: McpConfig, ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui" | "isProjectTrusted">, options?: {
    allowUnapproved?: boolean;
}): Promise<ProjectTrustResult>;
/** Remove project-derived servers and script tools before an ExtensionContext exists. */
export declare function excludeProjectServersAtLoadTime(loadedOrConfig: LoadedMcpConfig | McpConfig): McpConfig;
