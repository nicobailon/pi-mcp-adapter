import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoadedMcpConfig } from "./config.ts";
import { type McpConfig, type ProjectServerBlock, type ProjectServerBlockReason, type ServerDefinition } from "./types.ts";
export interface ProjectTrustResult {
    config: McpConfig;
    blockedServers: Map<string, ProjectServerBlock>;
}
export declare function describeProjectServerBlock(reason: ProjectServerBlockReason): string;
export declare function disabledServerReason(blocked: ReadonlyMap<string, ProjectServerBlock> | undefined, name: string): string;
export declare function hasProjectServerDefinitions(config: McpConfig): boolean;
export declare function hashProjectServerDefinition(definition: ServerDefinition): string;
export declare function canonicalProjectRoot(cwd: string): string;
export declare function approveProjectServer(cwd: string, serverName: string, definition: ServerDefinition): void;
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
/** Remove project-derived servers before an ExtensionContext exists. */
export declare function excludeProjectServersAtLoadTime(loadedOrConfig: LoadedMcpConfig | McpConfig): McpConfig;
