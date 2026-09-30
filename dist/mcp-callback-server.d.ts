/**
 * MCP OAuth Callback Server
 *
 * HTTP server that handles OAuth callbacks from the authorization server.
 * Uses Node.js http module for compatibility.
 */
/** Result of a successful OAuth callback */
export interface OAuthCallbackResult {
    code: string;
    /** RFC 9207 `iss` authorization response parameter, when provided */
    iss?: string;
}
interface EnsureCallbackServerOptions {
    strictPort?: boolean;
    port?: number;
    callbackHost?: string;
    callbackPath?: string;
    oauthState?: string;
    reserveState?: boolean;
}
/**
 * Ensure the callback server is running.
 * If strictPort is true, requires binding on the configured callback port.
 * If strictPort is false, asks the OS for an available local port.
 */
export declare function ensureCallbackServer(options?: EnsureCallbackServerOptions): Promise<void>;
export declare function reserveCallbackServer(oauthState: string): void;
export declare function releaseCallbackServer(oauthState: string): void;
/**
 * Wait for a callback with the given OAuth state.
 * Returns a promise that resolves with the authorization code and, when the
 * authorization server sends one, the RFC 9207 `iss` parameter.
 */
export declare function waitForCallback(oauthState: string): Promise<OAuthCallbackResult>;
/**
 * Cancel a pending authorization by state.
 */
export declare function cancelPendingCallback(oauthState: string): void;
/**
 * Stop the callback server and reject all pending authorizations.
 */
export declare function stopCallbackServer(): Promise<void>;
/** Stop the callback server only when no bind or authorization owns it. */
export declare function stopCallbackServerIfIdle(): Promise<void>;
/**
 * Check if the callback server is running.
 */
export declare function isCallbackServerRunning(): boolean;
/**
 * Get the number of pending authorizations.
 */
export declare function getPendingAuthCount(): number;
export {};
