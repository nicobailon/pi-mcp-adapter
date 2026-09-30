/**
 * MCP OAuth Provider
 *
 * Implementation of the MCP SDK's OAuthClientProvider interface.
 * Handles OAuth client registration, token storage, and authorization redirection.
 */
import { UnauthorizedError, } from "@modelcontextprotocol/client";
import { getAuthForUrl, updateTokens, updateClientInfo, clearAllCredentials, clearCodeVerifier, invalidateAuthEntryCache, captureOAuthAuthority, } from "./mcp-auth.js";
import { OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema } from "@modelcontextprotocol/core";
import { createOAuthFetch } from "./mcp-auth-fetch.js";
import { resolveCommandSecret } from "./utils.js";
import { getAppClientUri, getAppName } from "./agent-dir.js";
/**
 * Client name advertised during Dynamic Client Registration.
 *
 * A distribution that rebrands pi (arc, tau, …) should register under its own
 * name — otherwise every consent screen its users see asks them to authorize
 * an app they have never run. Stock pi keeps the long-standing
 * "Pi Coding Agent" so existing registrations are unaffected.
 */
function defaultClientName() {
    const app = getAppName();
    return app === "pi" ? "Pi Coding Agent" : app;
}
/**
 * Client homepage advertised during Dynamic Client Registration.
 *
 * RFC 7591 defines client_uri as the home page *of the client*. Under a
 * rebranded pi the client is that distribution, not this adapter, so pointing
 * at the adapter's repository misidentifies it on the consent screen. There is
 * no way to guess the right URL and a wrong one is worse than none, so the
 * field is omitted unless a server config supplies oauth.clientUri.
 *
 * Stock pi keeps the historical value.
 */
function defaultClientUri() {
    const declared = getAppClientUri();
    if (declared)
        return declared;
    return getAppName() === "pi" ? "https://github.com/nicobailon/pi-mcp-adapter" : undefined;
}
function issuersMatch(first, second) {
    return first === second
        || (first.endsWith("/") && first.slice(0, -1) === second)
        || (second.endsWith("/") && second.slice(0, -1) === first);
}
function toOAuthTokens(tokens) {
    const result = {
        access_token: tokens.accessToken,
        token_type: "Bearer",
    };
    if (tokens.refreshToken !== undefined)
        result.refresh_token = tokens.refreshToken;
    if (tokens.expiresAt !== undefined)
        result.expires_in = Math.max(0, Math.floor(tokens.expiresAt - Date.now() / 1000));
    if (tokens.scope !== undefined)
        result.scope = tokens.scope;
    if (tokens.issuer !== undefined)
        result.issuer = tokens.issuer;
    return result;
}
// Callback server configuration
// RFC 8252 section 7.3: use the loopback IP literal, not "localhost". The
// callback listener binds this same host so the advertised redirect reaches it.
const DEFAULT_OAUTH_CALLBACK_HOST = "127.0.0.1";
const DEFAULT_OAUTH_CALLBACK_PORT = 19876;
const DEFAULT_OAUTH_CALLBACK_PATH = "/callback";
let configuredOAuthCallbackPort = DEFAULT_OAUTH_CALLBACK_PORT;
if (process.env.MCP_OAUTH_CALLBACK_PORT) {
    const parsedPort = Number.parseInt(process.env.MCP_OAUTH_CALLBACK_PORT, 10);
    if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
        configuredOAuthCallbackPort = parsedPort;
    }
}
let oauthCallbackPort = configuredOAuthCallbackPort;
let oauthCallbackPath = DEFAULT_OAUTH_CALLBACK_PATH;
export function getConfiguredOAuthCallbackPort() {
    return configuredOAuthCallbackPort;
}
export function getOAuthCallbackPort() {
    return oauthCallbackPort;
}
export function setOAuthCallbackPort(port) {
    oauthCallbackPort = port;
}
export function getOAuthCallbackPath() {
    return oauthCallbackPath;
}
export function setOAuthCallbackPath(path) {
    oauthCallbackPath = path.startsWith("/") ? path : `/${path}`;
}
const reservedAuthorizationParams = new Set([
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "redirect_uri",
    "resource",
    "response_type",
    "scope",
    "state",
]);
function addAuthorizationParams(authorizationUrl, params) {
    if (!params)
        return authorizationUrl;
    const nextUrl = new URL(authorizationUrl.toString());
    for (const [key, value] of Object.entries(params)) {
        if (reservedAuthorizationParams.has(key) || nextUrl.searchParams.has(key)) {
            throw new Error(`OAuth authorizationParams.${key} cannot override an authorization flow parameter`);
        }
        nextUrl.searchParams.set(key, value);
    }
    return nextUrl;
}
function inferIssuerFromMetadataUrl(metadataUrl) {
    const url = new URL(metadataUrl);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    const oauthPrefix = "/.well-known/oauth-authorization-server";
    if (pathname === oauthPrefix || pathname.startsWith(`${oauthPrefix}/`)) {
        const issuerPath = pathname.slice(oauthPrefix.length) || "/";
        return new URL(issuerPath, url.origin).toString();
    }
    const oidcPath = "/.well-known/openid-configuration";
    if (pathname === oidcPath || pathname.startsWith(`${oidcPath}/`)) {
        const issuerPath = pathname.slice(oidcPath.length) || "/";
        return new URL(issuerPath, url.origin).toString();
    }
    if (pathname.endsWith(oidcPath)) {
        const issuerPath = pathname.slice(0, -oidcPath.length) || "/";
        return new URL(issuerPath, url.origin).toString();
    }
    return undefined;
}
function validateConfiguredIssuer(metadataUrl, issuer, skipIssuerValidation) {
    let parsedIssuer;
    try {
        parsedIssuer = new URL(issuer);
    }
    catch (error) {
        throw new Error("OAuth authorization-server metadata issuer must be an absolute URL", { cause: error });
    }
    if (parsedIssuer.protocol !== "http:" && parsedIssuer.protocol !== "https:") {
        throw new Error("OAuth authorization-server metadata issuer must use http:// or https://");
    }
    const expectedIssuer = inferIssuerFromMetadataUrl(metadataUrl);
    if (skipIssuerValidation)
        return;
    if (expectedIssuer !== undefined && !issuersMatch(expectedIssuer, issuer)) {
        throw new Error(`OAuth authorization-server metadata issuer does not match authServerMetadataUrl: expected ${expectedIssuer}`);
    }
    if (expectedIssuer === undefined && !issuersMatch(new URL(metadataUrl).origin, issuer)) {
        throw new Error(`OAuth authorization-server metadata issuer does not match authServerMetadataUrl origin: expected ${new URL(metadataUrl).origin}`);
    }
}
async function loadConfiguredDiscoveryState(metadataUrl, serverUrl, skipIssuerValidation, fetchFn) {
    const response = await fetchFn(metadataUrl, {
        headers: { accept: "application/json" },
    });
    if (!response.ok) {
        await response.text().catch(() => { });
        throw new Error(`OAuth authServerMetadataUrl request failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    const oauthResult = OAuthMetadataSchema.safeParse(payload);
    const metadata = oauthResult.success
        ? oauthResult.data
        : OpenIdProviderDiscoveryMetadataSchema.parse(payload);
    validateConfiguredIssuer(metadataUrl, metadata.issuer, skipIssuerValidation);
    const resource = new URL(serverUrl);
    resource.hash = "";
    return {
        authorizationServerUrl: metadata.issuer,
        authorizationServerMetadata: metadata,
        // The configured AS document is authoritative, so avoid a second PRM
        // lookup while still binding the token request to the configured resource.
        resourceMetadata: { resource: resource.toString() },
    };
}
/**
 * OAuth provider implementation for MCP servers.
 * Implements the OAuthClientProvider interface from the MCP SDK.
 */
export class McpOAuthProvider {
    serverName;
    serverUrl;
    config;
    callbacks;
    storageOptions;
    runtimeSignal;
    clientMetadataUrl;
    redirectUrlSnapshot;
    authFetch;
    active = true;
    flowClientInfo;
    flowCodeVerifier;
    flowDiscoveryState;
    flowIssuerMismatch = false;
    flowState;
    invalidatedAccessToken;
    invalidatedClientId;
    staleRedirectClientId;
    lastObservedClientId;
    lastSavedAccessToken;
    pendingAuthAccessToken;
    assertAuthority;
    constructor(serverName, serverUrl, config, callbacks, storageOptions = {}, runtimeSignal, initialState, authority) {
        this.serverName = serverName;
        this.serverUrl = serverUrl;
        this.config = config;
        this.callbacks = callbacks;
        this.storageOptions = storageOptions;
        this.runtimeSignal = runtimeSignal;
        this.assertAuthority = authority ?? captureOAuthAuthority(serverName);
        this.assertAuthority();
        if (config.clientId === undefined && config.clientMetadataUrl !== undefined) {
            this.clientMetadataUrl = config.clientMetadataUrl;
        }
        this.authFetch = createOAuthFetch(serverUrl, undefined, runtimeSignal);
        this.flowState = initialState;
        this.redirectUrlSnapshot = config.grantType === "client_credentials"
            ? undefined
            : config.redirectUri ?? `http://${DEFAULT_OAUTH_CALLBACK_HOST}:${getOAuthCallbackPort()}${getOAuthCallbackPath()}`;
    }
    setAuthFetch(fetchFn) {
        this.authFetch = fetchFn;
    }
    get usesClientCredentials() {
        return this.config.grantType === "client_credentials";
    }
    get discoveredIssuer() {
        return this.flowDiscoveryState?.authorizationServerMetadata?.issuer
            ?? this.flowDiscoveryState?.authorizationServerUrl;
    }
    deactivate() {
        this.active = false;
        this.invalidatedAccessToken = undefined;
        this.invalidatedClientId = undefined;
        this.staleRedirectClientId = undefined;
        this.lastObservedClientId = undefined;
        this.lastSavedAccessToken = undefined;
        this.pendingAuthAccessToken = undefined;
    }
    assertStoredIssuerBindings(entry, issuer) {
        if (this.flowIssuerMismatch) {
            throw new Error(`OAuth authorization server issuer changed for ${this.serverName}; clear credentials before authenticating again`);
        }
        if (!entry || !issuer)
            return;
        const storedIssuers = [entry.clientInfo?.issuer, entry.tokens?.issuer]
            .filter((storedIssuer) => storedIssuer !== undefined);
        if (storedIssuers.some(storedIssuer => !issuersMatch(storedIssuer, issuer))) {
            this.flowIssuerMismatch = true;
            throw new Error(`OAuth authorization server issuer changed for ${this.serverName}; clear credentials before authenticating again`);
        }
    }
    throwIfInactive() {
        if (!this.active)
            throw new Error("OAuth flow is no longer active");
        this.assertAuthority();
        this.runtimeSignal?.throwIfAborted();
        // The SDK can swallow refresh fetch errors and attempt browser authorization.
        // A failed service credential must stop that fallback and token persistence.
        this.authFetch.throwIfHeaderResolutionFailed();
    }
    /**
     * The redirect URL for OAuth callbacks.
     * This must match the redirect_uri in client metadata.
     */
    get redirectUrl() {
        return this.redirectUrlSnapshot;
    }
    /** Configured homepage, else the historical default on stock pi, else nothing. */
    get clientUri() {
        return this.config.clientUri ?? defaultClientUri();
    }
    /**
     * Client metadata for dynamic registration.
     * Describes this client to the OAuth authorization server.
     */
    get clientMetadata() {
        if (this.usesClientCredentials) {
            return {
                client_name: this.config.clientName ?? defaultClientName(),
                ...(this.clientUri !== undefined ? { client_uri: this.clientUri } : {}),
                ...(this.config.logoUri !== undefined ? { logo_uri: this.config.logoUri } : {}),
                redirect_uris: [],
                grant_types: ["client_credentials"],
                token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
            };
        }
        const redirectUrl = this.redirectUrl;
        if (!redirectUrl) {
            throw new Error("redirectUrl is required for authorization_code flow");
        }
        return {
            redirect_uris: [redirectUrl],
            client_name: this.config.clientName ?? defaultClientName(),
            ...(this.clientUri !== undefined ? { client_uri: this.clientUri } : {}),
            ...(this.config.logoUri !== undefined ? { logo_uri: this.config.logoUri } : {}),
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
            ...(this.config.scope !== undefined ? { scope: this.config.scope } : {}),
        };
    }
    /**
     * Get client information (for pre-registered or dynamically registered clients).
     * Returns undefined if no client info exists or if the server URL has changed.
     */
    async clientInformation() {
        this.throwIfInactive();
        if (this.invalidatedClientId !== undefined) {
            invalidateAuthEntryCache(this.serverName);
        }
        const issuer = this.discoveredIssuer;
        const stored = await getAuthForUrl(this.serverName, this.serverUrl, this.storageOptions);
        this.throwIfInactive();
        this.assertStoredIssuerBindings(stored, issuer);
        // Check config first (pre-registered client). Store only its issuer binding.
        // The configured secret stays in config and never enters the credential store.
        if (this.config.clientId) {
            const storedClient = stored?.clientInfo?.clientId === this.config.clientId
                ? stored.clientInfo
                : undefined;
            if (issuer && (storedClient?.issuer !== issuer || storedClient.configPreRegistered !== true)) {
                this.throwIfInactive();
                updateClientInfo(this.serverName, { clientId: this.config.clientId, issuer, configPreRegistered: true }, this.serverUrl, this.storageOptions);
            }
            const clientSecret = this.config.clientSecret?.startsWith("!")
                ? resolveCommandSecret(this.config.clientSecret, `MCP server "${this.serverName}" OAuth clientSecret`)
                : this.config.clientSecret;
            return {
                client_id: this.config.clientId,
                client_secret: clientSecret,
                ...(issuer !== undefined ? { issuer } : {}),
            };
        }
        // Keep client registration associated with this in-flight flow even if
        // another runtime writes the shared persistent entry for the same name.
        const clientInfo = this.flowClientInfo ?? stored?.clientInfo;
        if (clientInfo?.clientId === this.invalidatedClientId)
            return undefined;
        const clientMetadataUrl = this.clientMetadataUrl;
        const supportsClientMetadataDocument = this.flowDiscoveryState
            ?.authorizationServerMetadata?.client_id_metadata_document_supported;
        if (clientMetadataUrl !== undefined && supportsClientMetadataDocument !== undefined) {
            if (supportsClientMetadataDocument === true
                && clientInfo?.clientId !== clientMetadataUrl
                && (stored?.tokens?.refreshToken === undefined || this.invalidatedAccessToken !== undefined)) {
                // With no DCR refresh pair to preserve, let the SDK select CIMD now.
                return undefined;
            }
            if (supportsClientMetadataDocument !== true && clientInfo?.clientId === clientMetadataUrl) {
                return undefined;
            }
        }
        if (clientInfo) {
            this.invalidatedClientId = undefined;
            // A stored SEP-2352 issuer stub for a config-pre-registered client
            // (identified by the explicit marker, or by the legacy stub shape of
            // {clientId, issuer} with no registration metadata) is only meaningful
            // when the config supplies the matching client secret. Since we reach
            // this branch only when config.clientId is absent, serving the stub
            // would let a token refresh go out with a client_id but no secret,
            // causing invalid_client and credential invalidation. Return undefined
            // so callers treat this as "no client info".
            const isConfiguredCimd = clientMetadataUrl !== undefined
                && clientInfo.clientId === clientMetadataUrl;
            const isConfigStub = clientInfo.configPreRegistered === true
                || (clientInfo.clientSecret === undefined
                    && clientInfo.clientIdIssuedAt === undefined
                    && clientInfo.clientSecretExpiresAt === undefined
                    && clientInfo.redirectUris === undefined);
            if (isConfigStub && !isConfiguredCimd) {
                return undefined;
            }
            // Check if client secret has expired
            if (clientInfo.clientSecretExpiresAt && clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
                return undefined;
            }
            if (issuer && clientInfo.issuer && !issuersMatch(clientInfo.issuer, issuer)) {
                return undefined;
            }
            if (issuer && clientInfo.issuer === undefined) {
                clientInfo.issuer = issuer;
                this.flowClientInfo = clientInfo;
                this.throwIfInactive();
                updateClientInfo(this.serverName, clientInfo, this.serverUrl, this.storageOptions);
            }
            // Keep a stale dynamic registration available for its refresh attempt,
            // but suppress it if that attempt invalidates the token and auth falls
            // back to an interactive flow. The next clientInformation() call then
            // makes the SDK register the current callback URI.
            const redirectUriIsStale = this.redirectUrl !== undefined
                && (!Array.isArray(clientInfo.redirectUris) || !clientInfo.redirectUris.includes(this.redirectUrl));
            this.staleRedirectClientId = redirectUriIsStale ? clientInfo.clientId : undefined;
            // Return all registration metadata and the local issuer extension.
            // This keeps the SDK OAuth view and the stored issuer binding consistent.
            this.lastObservedClientId = clientInfo.clientId;
            return {
                client_id: clientInfo.clientId,
                client_secret: clientInfo.clientSecret,
                ...(clientInfo.clientIdIssuedAt !== undefined
                    ? { client_id_issued_at: clientInfo.clientIdIssuedAt }
                    : {}),
                ...(clientInfo.clientSecretExpiresAt !== undefined
                    ? { client_secret_expires_at: clientInfo.clientSecretExpiresAt }
                    : {}),
                ...(clientInfo.redirectUris !== undefined
                    ? { redirect_uris: clientInfo.redirectUris }
                    : {}),
                ...(clientInfo.issuer !== undefined ? { issuer: clientInfo.issuer } : {}),
            };
        }
        // No client info or URL changed - will trigger dynamic registration
        return undefined;
    }
    /**
     * Save client information from dynamic registration.
     */
    async saveClientInformation(info) {
        this.throwIfInactive();
        const issuer = this.discoveredIssuer ?? info.issuer;
        if (this.config.clientId && info.client_id === this.config.clientId) {
            updateClientInfo(this.serverName, {
                clientId: info.client_id,
                ...(issuer !== undefined ? { issuer } : {}),
                configPreRegistered: true,
            }, this.serverUrl, this.storageOptions);
            return;
        }
        const redirectUris = ("redirect_uris" in info ? info.redirect_uris : undefined)
            ?? (this.redirectUrl ? [this.redirectUrl] : undefined);
        const clientInfo = {
            clientId: info.client_id,
            ...(info.client_secret !== undefined ? { clientSecret: info.client_secret } : {}),
            ...(info.client_id_issued_at !== undefined ? { clientIdIssuedAt: info.client_id_issued_at } : {}),
            ...(info.client_secret_expires_at !== undefined ? { clientSecretExpiresAt: info.client_secret_expires_at } : {}),
            ...(redirectUris !== undefined ? { redirectUris } : {}),
            ...(issuer !== undefined ? { issuer } : {}),
        };
        this.flowClientInfo = clientInfo;
        this.invalidatedClientId = undefined;
        this.lastObservedClientId = clientInfo.clientId;
        updateClientInfo(this.serverName, clientInfo, this.serverUrl, this.storageOptions);
    }
    /**
     * Get stored OAuth tokens.
     * Returns undefined if no tokens exist or if the server URL has changed.
     */
    async tokens(ctx) {
        this.throwIfInactive();
        // Once this provider rejects a token, bypass its process-local cache until
        // another process replaces that token in shared secure storage.
        if (this.invalidatedAccessToken !== undefined) {
            invalidateAuthEntryCache(this.serverName);
        }
        // Use getAuthForUrl to validate tokens are for the current server URL.
        const entry = await getAuthForUrl(this.serverName, this.serverUrl, this.storageOptions);
        this.throwIfInactive();
        if (!entry?.tokens || entry.tokens.accessToken === this.invalidatedAccessToken)
            return undefined;
        this.invalidatedAccessToken = undefined;
        const issuer = this.discoveredIssuer;
        this.assertStoredIssuerBindings(entry, issuer);
        if (issuer && entry.tokens.issuer === undefined) {
            entry.tokens.issuer = issuer;
            this.throwIfInactive();
            updateTokens(this.serverName, entry.tokens, this.serverUrl, this.storageOptions);
        }
        if (ctx !== undefined) {
            this.pendingAuthAccessToken = entry.tokens.accessToken;
        }
        return toOAuthTokens(entry.tokens);
    }
    /**
     * Save OAuth tokens.
     */
    async saveTokens(tokens) {
        const issuer = this.discoveredIssuer ?? tokens.issuer;
        const storedTokens = {
            accessToken: tokens.access_token,
            ...(tokens.refresh_token !== undefined ? { refreshToken: tokens.refresh_token } : {}),
            // Preserve expiry even when expires_in is 0 (e.g. the SDK re-saving an
            // already-expired token) so expired tokens stay expired instead of
            // being persisted as never-expiring.
            ...(tokens.expires_in !== undefined ? { expiresAt: Date.now() / 1000 + tokens.expires_in } : {}),
            ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
            ...(issuer !== undefined ? { issuer } : {}),
        };
        this.throwIfInactive();
        updateTokens(this.serverName, storedTokens, this.serverUrl, this.storageOptions);
        this.invalidatedAccessToken = undefined;
        this.lastSavedAccessToken = storedTokens.accessToken;
        // Discovery must survive the browser redirect so the callback can verify
        // the authorization server that minted the code. Once token issuance
        // succeeds, clear it so a later 401 re-reads PRM and can observe an
        // authorization-server migration.
        this.flowDiscoveryState = undefined;
    }
    /**
     * Redirect the user to the authorization URL.
     * This opens the browser for the user to authenticate.
     *
     * Throws UnauthorizedError when called outside of a user-initiated flow
     * (no oauthState saved by startAuth). That path is reached when the SDK
     * falls through from a failed refresh into a fresh authorization_code
     * flow, which library hosts cannot complete in-process.
     */
    async redirectToAuthorization(authorizationUrl) {
        if (this.usesClientCredentials) {
            throw new Error("redirectToAuthorization is not used for client_credentials flow");
        }
        // No flow-local state means we're on the post-refresh authorize fallback.
        this.throwIfInactive();
        if (!this.flowState) {
            throw new UnauthorizedError(`Re-authentication required for MCP server: ${this.serverName}`);
        }
        // URL is passed to callback, not logged (may contain sensitive params)
        await this.callbacks.onRedirect(addAuthorizationParams(authorizationUrl, this.config.authorizationParams));
    }
    /**
     * Save the PKCE code verifier.
     */
    async saveCodeVerifier(codeVerifier) {
        this.throwIfInactive();
        this.flowCodeVerifier = codeVerifier;
    }
    /**
     * Get the stored PKCE code verifier.
     * @throws Error if no code verifier is stored
     */
    async codeVerifier() {
        if (this.usesClientCredentials) {
            throw new Error("codeVerifier is not used for client_credentials flow");
        }
        this.throwIfInactive();
        if (!this.flowCodeVerifier) {
            throw new Error(`No code verifier saved for MCP server: ${this.serverName}`);
        }
        return this.flowCodeVerifier;
    }
    /**
     * Keep discovery with the in-flight PKCE verifier. The callback leg uses it
     * to validate the authorization response issuer before token exchange.
     */
    async saveDiscoveryState(state) {
        this.throwIfInactive();
        this.flowDiscoveryState = structuredClone(state);
    }
    async discoveryState() {
        this.throwIfInactive();
        if (!this.flowDiscoveryState && this.config.authServerMetadataUrl !== undefined) {
            const discoveryState = await loadConfiguredDiscoveryState(this.config.authServerMetadataUrl, this.serverUrl, this.config.skipIssuerMetadataValidation === true, this.authFetch);
            this.throwIfInactive();
            this.flowDiscoveryState = discoveryState;
        }
        this.throwIfInactive();
        return this.flowDiscoveryState ? structuredClone(this.flowDiscoveryState) : undefined;
    }
    /** Internal connection-attempt identity check for manager cleanup. */
    /**
     * Save the OAuth state parameter for CSRF protection.
     */
    async saveState(state) {
        this.throwIfInactive();
        this.flowState = state;
    }
    /**
     * Get the stored OAuth state parameter.
     * @throws UnauthorizedError if no flow is in progress (see redirectToAuthorization)
     */
    async state() {
        if (this.usesClientCredentials) {
            throw new Error("state is not used for client_credentials flow");
        }
        this.throwIfInactive();
        if (!this.flowState) {
            throw new UnauthorizedError(`Re-authentication required for MCP server: ${this.serverName}`);
        }
        return this.flowState;
    }
    /**
     * Invalidate credentials when authentication fails.
     * Clears tokens, client info, or all credentials based on the type.
     */
    async invalidateCredentials(type) {
        this.throwIfInactive();
        switch (type) {
            case "all":
                this.flowClientInfo = undefined;
                this.flowCodeVerifier = undefined;
                this.flowDiscoveryState = undefined;
                this.flowIssuerMismatch = false;
                this.flowState = undefined;
                this.invalidatedAccessToken = undefined;
                this.invalidatedClientId = undefined;
                this.staleRedirectClientId = undefined;
                this.lastObservedClientId = undefined;
                this.lastSavedAccessToken = undefined;
                this.pendingAuthAccessToken = undefined;
                clearAllCredentials(this.serverName, this.storageOptions);
                break;
            case "client":
                // Dynamic client registrations share the same credential-store entry as
                // tokens. Keep SDK invalidation local so a stale process cannot rewrite
                // that entry over credentials another process just authorized.
                this.invalidatedClientId = this.lastObservedClientId;
                this.lastObservedClientId = undefined;
                this.flowClientInfo = undefined;
                invalidateAuthEntryCache(this.serverName);
                break;
            case "tokens":
                // Invalidation is provider-local. Persistently deleting a shared token
                // here lets a process refreshing stale cached credentials erase a token
                // that another process just authorized. A later tokens() call bypasses
                // the local cache and adopts a replacement token when one exists.
                this.invalidatedAccessToken = this.pendingAuthAccessToken ?? this.lastSavedAccessToken;
                this.lastSavedAccessToken = undefined;
                this.pendingAuthAccessToken = undefined;
                if (this.staleRedirectClientId !== undefined) {
                    this.invalidatedClientId = this.staleRedirectClientId;
                }
                invalidateAuthEntryCache(this.serverName);
                break;
            case "verifier":
                clearCodeVerifier(this.serverName, this.storageOptions);
                break;
            case "discovery":
                this.flowDiscoveryState = undefined;
                break;
        }
    }
    /**
     * Adds configured authorization-code scope without replacing the SDK's
     * default token endpoint authentication behavior.
     */
    addClientAuthentication = async (headers, params, _url, metadata) => {
        this.throwIfInactive();
        if (params.get("grant_type") === "authorization_code" && !params.has("scope") && this.config.scope) {
            params.set("scope", this.config.scope);
        }
        const clientInfo = await this.clientInformation();
        this.throwIfInactive();
        if (!clientInfo) {
            return;
        }
        const supportedMethods = metadata?.token_endpoint_auth_methods_supported ?? [];
        const hasClientSecret = clientInfo.client_secret !== undefined;
        let authMethod;
        if (supportedMethods.length === 0) {
            authMethod = hasClientSecret ? "client_secret_post" : "none";
        }
        else if (hasClientSecret && supportedMethods.includes("client_secret_basic")) {
            authMethod = "client_secret_basic";
        }
        else if (hasClientSecret && supportedMethods.includes("client_secret_post")) {
            authMethod = "client_secret_post";
        }
        else if (supportedMethods.includes("none")) {
            authMethod = "none";
        }
        else {
            authMethod = hasClientSecret ? "client_secret_post" : "none";
        }
        if (authMethod === "client_secret_basic") {
            if (!clientInfo.client_secret) {
                throw new Error("client_secret_basic authentication requires a client_secret");
            }
            headers.set("Authorization", `Basic ${Buffer.from(`${clientInfo.client_id}:${clientInfo.client_secret}`).toString("base64")}`);
            return;
        }
        if (!params.has("client_id")) {
            params.set("client_id", clientInfo.client_id);
        }
        if (authMethod === "client_secret_post" && clientInfo.client_secret && !params.has("client_secret")) {
            params.set("client_secret", clientInfo.client_secret);
        }
    };
    prepareTokenRequest(scope) {
        if (!this.usesClientCredentials) {
            return undefined;
        }
        const params = new URLSearchParams({ grant_type: "client_credentials" });
        const requestedScope = scope ?? this.config.scope;
        if (requestedScope) {
            params.set("scope", requestedScope);
        }
        return params;
    }
}
export { DEFAULT_OAUTH_CALLBACK_HOST, DEFAULT_OAUTH_CALLBACK_PORT, DEFAULT_OAUTH_CALLBACK_PATH };
//# sourceMappingURL=mcp-oauth-provider.js.map