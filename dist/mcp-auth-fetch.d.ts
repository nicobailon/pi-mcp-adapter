import type { FetchLike } from "@modelcontextprotocol/client";
/**
 * Resolve only at a connection/authentication boundary, never during config discovery.
 * TypeError is fatal to the native SDK's fresh and cached discovery paths; ordinary
 * errors can be swallowed and allow authentication to continue without credentials.
 */
type OAuthHeaderOptions = {
    commands?: boolean;
    literal?: boolean;
};
export declare function resolveOAuthHeaders(values: Record<string, string> | undefined, options?: OAuthHeaderOptions): Headers;
export type OAuthFetch = FetchLike & {
    throwIfHeaderResolutionFailed(): void;
};
/**
 * Configured service headers belong only to the configured MCP origin, not to
 * discovered issuers. SDK request headers win (notably Authorization and MIME
 * types). Credential-bearing redirects fail closed, including same-origin ones.
 */
export declare function createOAuthFetch(serverUrl: string, getHeaders?: () => Headers, signal?: AbortSignal, options?: {
    timeout?: boolean;
    delegate?: FetchLike;
}): OAuthFetch;
/** Cache success or failure only in the owning auth leg/connection, never in storage. */
export declare function oauthHeaderResolver(values: Record<string, string> | undefined, options?: Pick<OAuthHeaderOptions, "literal">): () => Headers;
export {};
