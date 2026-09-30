import { type SessionRecoveryDeps } from "./session-recovery.ts";
import type { McpServerManager } from "./server-manager.ts";
import { type McpConfig, type UiResourceContent } from "./types.ts";
interface ReadUiResourceOptions {
    config?: McpConfig;
    signal?: AbortSignal;
    onNeedsAuth?: SessionRecoveryDeps["onNeedsAuth"];
}
export declare class UiResourceHandler {
    private manager;
    private config;
    private log;
    constructor(manager: McpServerManager, config?: McpConfig | undefined);
    readUiResource(serverName: string, uri: string, options?: ReadUiResourceOptions): Promise<UiResourceContent>;
    private getListResourceMeta;
}
export {};
