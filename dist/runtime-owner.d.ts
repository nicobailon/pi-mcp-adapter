import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
export interface McpRuntimeOwner {
    readonly signal: AbortSignal;
    isActive(): boolean;
    addCleanup(cleanup: () => void | Promise<void>): void;
    stop(reason?: string): Promise<void>;
    throwIfInactive(): void;
}
export declare function createMcpRuntimeOwner(): McpRuntimeOwner;
export declare function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined;
/** Fence session-bound UI calls after the owning extension runtime stops. */
export declare function createOwnedUi(ui: ExtensionUIContext, owner: McpRuntimeOwner): ExtensionUIContext;
export declare function isAbortError(error: unknown, signal?: AbortSignal): boolean;
