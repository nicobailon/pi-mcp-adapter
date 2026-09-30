/**
 * MCP Auth Flow
 *
 * High-level OAuth flow management using the MCP SDK's built-in auth functions.
 */
import { RegistrationRejectedError } from "@modelcontextprotocol/client";
import { type McpOAuthConfig } from "./mcp-oauth-provider.ts";
import { type AuthStorageOptions, type OAuthAuthority, type StoredTokens } from "./mcp-auth.ts";
import { type ServerEntry } from "./types.ts";
/** Auth status for a server */
export type AuthStatus = "authenticated" | "expired" | "not_authenticated";
export interface McpOAuthRuntime {
    readonly signal: AbortSignal;
}
export interface AuthenticateOptions {
    onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>;
    openAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>;
    onAuthorizationInput?: (authorizationUrl: string, signal: AbortSignal) => Promise<string | undefined>;
    authStorageOptions?: AuthStorageOptions;
    signal?: AbortSignal;
    runtime?: McpOAuthRuntime;
    skipIssuerMetadataValidation?: boolean;
    definition?: Pick<ServerEntry, "headers" | "oauth">;
}
export declare function createOAuthRuntime(signal?: AbortSignal): McpOAuthRuntime;
export declare function hasPendingAuth(serverName: string, options?: AuthStorageOptions, runtime?: McpOAuthRuntime): boolean;
/**
 * Extract OAuth configuration from a ServerEntry.
 */
export declare function extractOAuthConfig(definition: ServerEntry): McpOAuthConfig;
export declare function explainRegistrationRejection(error: RegistrationRejectedError, serverUrl: string): Error;
/**
 * Start OAuth authentication flow for a server.
 * Returns the authorization URL when browser authorization is required.
 */
export declare function startAuth(serverName: string, serverUrl: string, definition?: ServerEntry, options?: AuthenticateOptions, operationAuthority?: OAuthAuthority): Promise<{
    authorizationUrl: string;
}>;
/** Authorization code plus the optional RFC 9207 `iss` callback parameter. */
export interface AuthorizationCodeInput {
    code: string;
    iss?: string;
}
/**
 * Extract an OAuth authorization code (and the RFC 9207 `iss` parameter, when
 * present) from either a raw code, a query string, or the full localhost
 * redirect URL copied from the browser address bar.
 */
export declare function parseAuthorizationRedirectInput(input: string, expectedState?: string): AuthorizationCodeInput;
/**
 * Extract an OAuth authorization code from either a raw code, a query string,
 * or the full localhost redirect URL copied from the browser address bar.
 */
export declare function parseAuthorizationCodeInput(input: string, expectedState?: string): string;
type AuthorizationResponse = {
    input: AuthorizationCodeInput;
    source: "callback" | "manual";
};
/**
 * Wait for either the localhost callback or a manually pasted redirect URL.
 * The manual input prompt is dismissed as soon as either path finishes.
 */
export declare function waitForAuthorizationResponse(callbackPromise: Promise<AuthorizationCodeInput>, authorizationUrl: string, expectedState: string, onAuthorizationInput?: AuthenticateOptions["onAuthorizationInput"], signal?: AbortSignal): Promise<AuthorizationResponse>;
/**
 * Complete OAuth authentication from manual user input.
 */
export declare function completeAuthFromInput(serverName: string, input: string, options?: AuthenticateOptions): Promise<AuthStatus>;
/**
 * Complete OAuth authentication with the authorization code.
 */
export declare function completeAuth(serverName: string, authorizationCode: string | AuthorizationCodeInput, options?: AuthenticateOptions): Promise<AuthStatus>;
/**
 * Perform the complete OAuth authentication flow for a server.
 *
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @param definition - The server definition (optional)
 * @returns The final auth status
 */
export declare function authenticate(serverName: string, serverUrl: string, definition?: ServerEntry, options?: AuthenticateOptions): Promise<AuthStatus>;
/**
 * Get a valid access token for a server, refreshing if necessary.
 *
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @returns The valid tokens or null if not authenticated
 */
export declare function getValidToken(serverName: string, serverUrl: string, options?: AuthenticateOptions): Promise<StoredTokens | null>;
/**
 * Check the authentication status for a server.
 *
 * @param serverName - The name of the MCP server
 * @returns The current auth status
 */
export declare function getAuthStatus(serverName: string, options?: AuthenticateOptions): Promise<AuthStatus>;
/**
 * Remove all OAuth credentials for a server.
 *
 * @param serverName - The name of the MCP server
 */
export declare function removeAuth(serverName: string, options?: AuthenticateOptions): Promise<void>;
/**
 * Check if OAuth is supported for a server configuration.
 * OAuth is supported for HTTP servers unless explicitly disabled.
 *
 * @param definition - The server definition
 * @returns True if OAuth is supported
 */
export declare function supportsOAuth(definition: ServerEntry): boolean;
/**
 * Initialize the OAuth system on startup.
 * OAuth callback binding is lazy and starts from startAuth() only.
 */
export declare function initializeOAuth(runtimeOrSignal?: McpOAuthRuntime | AbortSignal): Promise<McpOAuthRuntime>;
/**
 * Shutdown one OAuth runtime. The callback server remains process-shared while
 * another runtime has pending/reserved callback state or is still active.
 */
export declare function shutdownOAuth(runtime?: McpOAuthRuntime): Promise<void>;
export {};
