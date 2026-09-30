import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
export declare const MCP_APPROVAL_CUSTOM_TYPE = "mcp-approval-v1";
export type SessionApprovalEntry = {
    version: 1;
    kind: "tool";
    decision: "allow_for_session";
    serverName: string;
    originalToolName: string;
    definitionHash: string;
    argsHash: string;
} | {
    version: 1;
    kind: "iframe";
    decision: "allow" | "deny";
    serverName: string;
};
export type SessionApprovalWriter = (record: SessionApprovalEntry) => void;
export declare function computeToolArgumentsHash(args: unknown): string;
export declare function computeToolDefinitionHash(toolMeta: Pick<ToolMetadata, "originalName" | "inputSchema" | "resourceUri" | "uiResourceUri">): string;
export declare function makeToolApprovalKey(serverName: string, originalToolName: string, definitionHash: string, argsHash: string): string;
export declare function getToolApprovalIdentity(serverName: string, toolMeta: Pick<ToolMetadata, "originalName" | "inputSchema" | "resourceUri" | "uiResourceUri">, args: unknown): {
    definitionHash: string;
    argsHash: string;
    cacheKey: string;
};
export declare function createSessionApprovalWriter(appendEntry: (customType: string, data?: unknown) => void, canAppend?: (() => boolean) | undefined): SessionApprovalWriter;
export declare function rememberToolApproval(state: McpExtensionState, serverName: string, toolMeta: Pick<ToolMetadata, "originalName" | "inputSchema" | "resourceUri" | "uiResourceUri">, args: unknown): void;
/** Bind broad consent to this configured server, not a replacement with the same name. */
export declare function getServerApprovalIdentity(state: McpExtensionState, serverName: string): {
    definition: import("./types.ts").ServerEntry;
    hash: string;
} | undefined;
export declare function restoreSessionApprovalState(state: McpExtensionState, branchEntries: readonly unknown[]): void;
