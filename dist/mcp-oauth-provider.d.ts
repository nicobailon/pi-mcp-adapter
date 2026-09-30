/**
 * MCP OAuth Provider
 *
 * Implementation of the MCP SDK's OAuthClientProvider interface.
 * Handles OAuth client registration, token storage, and authorization redirection.
 */
import { type AddClientAuthentication, type OAuthClientInformationContext, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/client";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/client";
import { type AuthStorageOptions, type OAuthAuthority } from "./mcp-auth.ts";
import { type OAuthFetch } from "./mcp-auth-fetch.ts";
declare const DEFAULT_OAUTH_CALLBACK_HOST = "127.0.0.1";
declare const DEFAULT_OAUTH_CALLBACK_PORT = 19876;
declare const DEFAULT_OAUTH_CALLBACK_PATH = "/callback";
export declare function getConfiguredOAuthCallbackPort(): number;
export declare function getOAuthCallbackPort(): number;
export declare function setOAuthCallbackPort(port: number): void;
export declare function getOAuthCallbackPath(): string;
export declare function setOAuthCallbackPath(path: string): void;
/** Configuration options for OAuth */
export interface McpOAuthConfig {
    grantType?: "authorization_code" | "client_credentials";
    clientId?: string;
    clientSecret?: string;
    clientMetadataUrl?: string;
    scope?: string;
    authorizationParams?: Record<string, string>;
    redirectUri?: string;
    clientName?: string;
    clientUri?: string;
    logoUri?: string;
    authServerMetadataUrl?: string;
    skipIssuerMetadataValidation?: boolean;
}
/** Callbacks for OAuth flow interactions */
export interface McpOAuthCallbacks {
    onRedirect: (url: URL) => void | Promise<void>;
}
/**
 * OAuth provider implementation for MCP servers.
 * Implements the OAuthClientProvider interface from the MCP SDK.
 */
export declare class McpOAuthProvider implements OAuthClientProvider {
    private serverName;
    private serverUrl;
    private config;
    private callbacks;
    private storageOptions;
    private runtimeSignal?;
    readonly clientMetadataUrl?: string;
    private readonly redirectUrlSnapshot;
    private authFetch;
    private active;
    private flowClientInfo;
    private flowCodeVerifier;
    private flowDiscoveryState;
    private flowIssuerMismatch;
    private flowState;
    private invalidatedAccessToken;
    private invalidatedClientId;
    private staleRedirectClientId;
    private lastObservedClientId;
    private lastSavedAccessToken;
    private pendingAuthAccessToken;
    private readonly assertAuthority;
    constructor(serverName: string, serverUrl: string, config: McpOAuthConfig, callbacks: McpOAuthCallbacks, storageOptions?: AuthStorageOptions, runtimeSignal?: AbortSignal | undefined, initialState?: string, authority?: OAuthAuthority);
    setAuthFetch(fetchFn: OAuthFetch): void;
    private get usesClientCredentials();
    private get discoveredIssuer();
    deactivate(): void;
    private assertStoredIssuerBindings;
    private throwIfInactive;
    /**
     * The redirect URL for OAuth callbacks.
     * This must match the redirect_uri in client metadata.
     */
    get redirectUrl(): string | undefined;
    /** Configured homepage, else the historical default on stock pi, else nothing. */
    private get clientUri();
    /**
     * Client metadata for dynamic registration.
     * Describes this client to the OAuth authorization server.
     */
    get clientMetadata(): OAuthClientMetadata;
    /**
     * Get client information (for pre-registered or dynamically registered clients).
     * Returns undefined if no client info exists or if the server URL has changed.
     */
    clientInformation(): Promise<OAuthClientInformationMixed | undefined>;
    /**
     * Save client information from dynamic registration.
     */
    saveClientInformation(info: OAuthClientInformationMixed): Promise<void>;
    /**
     * Get stored OAuth tokens.
     * Returns undefined if no tokens exist or if the server URL has changed.
     */
    tokens(ctx?: OAuthClientInformationContext): Promise<OAuthTokens | undefined>;
    /**
     * Save OAuth tokens.
     */
    saveTokens(tokens: OAuthTokens): Promise<void>;
    /**
     * Redirect the user to the authorization URL.
     * This opens the browser for the user to authenticate.
     *
     * Throws UnauthorizedError when called outside of a user-initiated flow
     * (no oauthState saved by startAuth). That path is reached when the SDK
     * falls through from a failed refresh into a fresh authorization_code
     * flow, which library hosts cannot complete in-process.
     */
    redirectToAuthorization(authorizationUrl: URL): Promise<void>;
    /**
     * Save the PKCE code verifier.
     */
    saveCodeVerifier(codeVerifier: string): Promise<void>;
    /**
     * Get the stored PKCE code verifier.
     * @throws Error if no code verifier is stored
     */
    codeVerifier(): Promise<string>;
    /**
     * Keep discovery with the in-flight PKCE verifier. The callback leg uses it
     * to validate the authorization response issuer before token exchange.
     */
    saveDiscoveryState(state: OAuthDiscoveryState): Promise<void>;
    discoveryState(): Promise<OAuthDiscoveryState | undefined>;
    /** Internal connection-attempt identity check for manager cleanup. */
    /**
     * Save the OAuth state parameter for CSRF protection.
     */
    saveState(state: string): Promise<void>;
    /**
     * Get the stored OAuth state parameter.
     * @throws UnauthorizedError if no flow is in progress (see redirectToAuthorization)
     */
    state(): Promise<string>;
    /**
     * Invalidate credentials when authentication fails.
     * Clears tokens, client info, or all credentials based on the type.
     */
    invalidateCredentials(type: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void>;
    /**
     * Adds configured authorization-code scope without replacing the SDK's
     * default token endpoint authentication behavior.
     */
    addClientAuthentication: AddClientAuthentication;
    prepareTokenRequest(scope?: string): URLSearchParams | undefined;
}
export { DEFAULT_OAUTH_CALLBACK_HOST, DEFAULT_OAUTH_CALLBACK_PORT, DEFAULT_OAUTH_CALLBACK_PATH };
