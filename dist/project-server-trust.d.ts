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
export declare function applyProjectServerTrust(loaded: LoadedMcpConfig, ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui" | "isProjectTrusted">): Promise<ProjectTrustResult>;
export declare function applyProjectServerTrustToConfig(config: McpConfig, ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui" | "isProjectTrusted">): Promise<ProjectTrustResult>;
/** Remove project-derived servers before an ExtensionContext exists. */
export declare function excludeProjectServersAtLoadTime(loadedOrConfig: LoadedMcpConfig | McpConfig): McpConfig;
