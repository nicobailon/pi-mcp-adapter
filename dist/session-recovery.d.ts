import { type McpConfig } from "./types.ts";
import type { McpServerManager, ServerConnection } from "./server-manager.ts";
export declare function isTerminatedSession(err: unknown, hadSessionId: boolean): boolean;
export declare class SessionRecoveryAuthRequiredError extends Error {
    readonly serverName: string;
    readonly authMessage?: string | undefined;
    constructor(serverName: string, authMessage?: string | undefined);
}
export interface SessionRecoveryDeps {
    manager: McpServerManager;
    config: McpConfig;
    signal?: AbortSignal;
    onNeedsAuth?: (serverName: string) => Promise<ServerConnection | undefined>;
}
/**
 * Runs `fn` against the current connection for `serverName`. If it fails
 * with a terminated Streamable HTTP session (see `isTerminatedSession`),
 * reconnects exactly once via `McpServerManager.reconnect` (single-flight,
 * identity-guarded — see server-manager.ts) and retries `fn` exactly once
 * against the fresh connection.
 *
 * Any other failure — including a second failure after reconnecting, or the
 * server having been removed from config in the meantime — propagates
 * unchanged through the caller's existing error handling.
 */
export declare function withSessionRecovery<T>(deps: SessionRecoveryDeps, serverName: string, fn: (conn: ServerConnection) => Promise<T>): Promise<T>;
