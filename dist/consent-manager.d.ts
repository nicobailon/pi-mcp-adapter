import type { SessionApprovalWriter } from "./session-approvals.ts";
export type ToolConsentMode = "never" | "once-per-server" | "always";
export declare class ConsentManager {
    private mode;
    private persistDecision?;
    private approvedServers;
    private deniedServers;
    private log;
    constructor(mode?: ToolConsentMode, persistDecision?: SessionApprovalWriter | undefined);
    requiresPrompt(serverName: string): boolean;
    shouldCacheConsent(): boolean;
    registerDecision(serverName: string, approved: boolean): void;
    /** Apply a persisted decision without writing it back to the session. */
    restoreDecision(serverName: string, approved: boolean): void;
    ensureApproved(serverName: string): void;
    clear(serverName?: string): void;
    private applyDecision;
}
