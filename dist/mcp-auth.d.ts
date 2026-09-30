/**
 * MCP Auth Storage Module
 *
 * Handles secure storage of OAuth credentials, tokens, client information,
 * and legacy PKCE state for MCP servers.
 *
 * Persistent OAuth entries are stored in the operating system credential store
 * unless the externally keyed encrypted-file backend is explicitly selected.
 * The default backend imports and removes legacy plaintext entries from
 * $MCP_OAUTH_DIR or <Pi agent dir>/mcp-oauth.
 */
export type OAuthAuthority = () => void;
/** Capture immutable process-local authority for one server's OAuth lifecycle. */
export declare function captureOAuthAuthority(serverName: string, assertNow?: boolean): OAuthAuthority;
/** Begin an overlap-safe process-local logout interval. */
export declare function beginOAuthRevocation(serverName: string): () => void;
/** OAuth token storage format */
export interface StoredTokens {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scope?: string;
    /** SEP-2352 authorization-server issuer binding */
    issuer?: string;
}
/** OAuth client information from dynamic or static registration */
export interface StoredClientInfo {
    clientId: string;
    clientSecret?: string;
    clientIdIssuedAt?: number;
    clientSecretExpiresAt?: number;
    redirectUris?: string[];
    /** SEP-2352 authorization-server issuer binding */
    issuer?: string;
    /**
     * True when this entry is a secretless SEP-2352 issuer stub persisted for a
     * config-pre-registered client (written by the config-clientId path of
     * saveClientInformation). Such a stub is only usable when paired with the
     * config that supplies the client secret; it must never be served as
     * standalone client information.
     */
    configPreRegistered?: boolean;
}
/** Complete auth entry for a server */
export interface AuthEntry {
    tokens?: StoredTokens;
    clientInfo?: StoredClientInfo;
    codeVerifier?: string;
    oauthState?: string;
    serverUrl?: string;
}
export interface AuthStorageOptions {
    /** Legacy plaintext import directory. Persistent secrets no longer use this as their store. */
    baseDir?: string;
    credentialStore?: 'encrypted-file';
}
export declare class OAuthCredentialStoreError extends Error {
    readonly operation: 'read' | 'write' | 'remove';
    readonly backend?: "encrypted-file" | undefined;
    readonly code = "OAUTH_CREDENTIAL_STORE_UNAVAILABLE";
    constructor(message: string, operation: 'read' | 'write' | 'remove', cause: unknown, backend?: "encrypted-file" | undefined);
}
export type OAuthCredentialStatus = {
    status: 'present';
    entry: AuthEntry;
} | {
    status: 'absent';
} | {
    status: 'unavailable';
    message: string;
};
export declare function formatOAuthCredentialStoreUnavailable(error: OAuthCredentialStoreError): string;
interface KeyringEntry {
    getPassword(): string | null;
    setPassword(password: string): void;
    deleteCredential(): boolean;
}
type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntry;
type KeyringRequire = ((id: string) => unknown) & {
    resolve(id: string): string;
};
export declare function resetTestAuthSecretStore(): void;
/** Install a fake native Entry for OAuth storage tests without opening a real keyring. */
export declare function setTestKeyringEntryClass(entryClass: KeyringEntryConstructor | undefined): void;
export declare function resetAuthEntryCache(): void;
export declare function getTestAuthSecretStoreReadCount(): number;
export declare function getTestAuthSecretStoreEntries(): [string, string][];
export declare function removeTestAuthSecretStoreEntry(account: string): void;
export declare function setTestAuthSecretStoreEntry(account: string, payload: string): void;
export declare function loadTestKeyringEntryClass(keyringRequire: KeyringRequire, platform: NodeJS.Platform, arch: NodeJS.Architecture): KeyringEntryConstructor;
export declare function getAuthStorageOptions(oauthDir: unknown, cwd?: string, oauthCredentialStore?: unknown): AuthStorageOptions;
export declare function getAuthBaseDir(options?: AuthStorageOptions): string;
/**
 * Get the legacy plaintext tokens file path for a server.
 */
export declare function getAuthEntryFilePath(serverName: string, options?: AuthStorageOptions): string;
/**
 * Get auth entry for a server.
 */
export declare function getAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined;
/**
 * Get auth entry and validate it's for the correct URL.
 * Returns undefined if URL has changed (credentials are invalid).
 */
export declare function getAuthForUrl(serverName: string, serverUrl: string, options?: AuthStorageOptions): AuthEntry | undefined;
/**
 * Inspect credentials for status-only UI paths without treating an unavailable
 * secure store as missing credentials. Authentication operations continue to
 * use getAuthForUrl() directly and therefore remain fail-closed.
 */
export declare function inspectAuthForUrl(serverName: string, serverUrl: string, options?: AuthStorageOptions): OAuthCredentialStatus;
/**
 * Save auth entry for a server.
 */
export declare function saveAuthEntry(serverName: string, entry: AuthEntry, serverUrl?: string, options?: AuthStorageOptions): void;
export declare function removeAuthEntry(serverName: string, options?: AuthStorageOptions): void;
/**
 * Forget a cached entry so the next ordinary read reloads secure storage.
 */
export declare function invalidateAuthEntryCache(serverName: string): void;
/**
 * Update tokens for a server.
 */
export declare function updateTokens(serverName: string, tokens: StoredTokens, serverUrl?: string, options?: AuthStorageOptions): void;
/**
 * Update client info for a server.
 */
export declare function updateClientInfo(serverName: string, clientInfo: StoredClientInfo, serverUrl?: string, options?: AuthStorageOptions): void;
/**
 * Update code verifier for a server.
 */
export declare function updateCodeVerifier(serverName: string, codeVerifier: string, serverUrl?: string, options?: AuthStorageOptions): void;
/**
 * Clear code verifier for a server.
 */
export declare function clearCodeVerifier(serverName: string, options?: AuthStorageOptions): void;
/**
 * Update OAuth state for a server.
 */
export declare function updateOAuthState(serverName: string, state: string, serverUrl?: string, options?: AuthStorageOptions): void;
/**
 * Get OAuth state for a server.
 */
export declare function getOAuthState(serverName: string, options?: AuthStorageOptions): string | undefined;
/**
 * Clear OAuth state for a server.
 */
export declare function clearOAuthState(serverName: string, options?: AuthStorageOptions): void;
/**
 * Check if stored tokens are expired.
 * Returns null if no tokens exist, false if no expiry or not expired, true if expired.
 */
export declare function isTokenExpired(serverName: string, options?: AuthStorageOptions): boolean | null;
/**
 * Check if a server has stored tokens.
 */
export declare function hasStoredTokens(serverName: string, options?: AuthStorageOptions): boolean;
/**
 * Clear all credentials for a server.
 */
export declare function clearAllCredentials(serverName: string, options?: AuthStorageOptions): void;
/**
 * Clear only client info for a server.
 */
export declare function clearClientInfo(serverName: string, options?: AuthStorageOptions): void;
/**
 * Clear only tokens for a server.
 */
export declare function clearTokens(serverName: string, options?: AuthStorageOptions): void;
export {};
