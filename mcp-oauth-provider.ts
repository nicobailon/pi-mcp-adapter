/**
 * MCP OAuth Provider
 * 
 * Implementation of the MCP SDK's OAuthClientProvider interface.
 * Handles OAuth client registration, token storage, and authorization redirection.
 */

import {
  UnauthorizedError,
  type AddClientAuthentication,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client"
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/client"
import {
  getAuthForUrl,
  updateTokens,
  updateClientInfo,
  clearAllCredentials,
  clearClientInfo,
  clearCodeVerifier,
  clearTokens,
  type AuthEntry,
  type AuthStorageOptions,
  type StoredTokens,
  type StoredClientInfo,
} from "./mcp-auth.ts"
import { resolveCommandSecret } from "./utils.ts"
import { getAppClientUri, getAppName } from "./agent-dir.ts"

/**
 * Client name advertised during Dynamic Client Registration.
 *
 * A distribution that rebrands pi (arc, tau, …) should register under its own
 * name — otherwise every consent screen its users see asks them to authorize
 * an app they have never run. Stock pi keeps the long-standing
 * "Pi Coding Agent" so existing registrations are unaffected.
 */
function defaultClientName(): string {
  const app = getAppName()
  return app === "pi" ? "Pi Coding Agent" : app
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
function defaultClientUri(): string | undefined {
  const declared = getAppClientUri()
  if (declared) return declared
  return getAppName() === "pi" ? "https://github.com/nicobailon/pi-mcp-adapter" : undefined
}

type IssuerBoundClientInformation = OAuthClientInformationMixed & { issuer?: string }
type IssuerBoundTokens = OAuthTokens & { issuer?: string }

function issuersMatch(first: string, second: string): boolean {
  return first === second
    || (first.endsWith("/") && first.slice(0, -1) === second)
    || (second.endsWith("/") && second.slice(0, -1) === first)
}

// Callback server configuration
const DEFAULT_OAUTH_CALLBACK_PORT = 19876
const DEFAULT_OAUTH_CALLBACK_PATH = "/callback"

let configuredOAuthCallbackPort = DEFAULT_OAUTH_CALLBACK_PORT

if (process.env.MCP_OAUTH_CALLBACK_PORT) {
  const parsedPort = Number.parseInt(process.env.MCP_OAUTH_CALLBACK_PORT, 10)
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
    configuredOAuthCallbackPort = parsedPort
  }
}

let oauthCallbackPort = configuredOAuthCallbackPort
let oauthCallbackPath = DEFAULT_OAUTH_CALLBACK_PATH

export function getConfiguredOAuthCallbackPort(): number {
  return configuredOAuthCallbackPort
}

export function getOAuthCallbackPort(): number {
  return oauthCallbackPort
}

export function setOAuthCallbackPort(port: number): void {
  oauthCallbackPort = port
}

export function getOAuthCallbackPath(): string {
  return oauthCallbackPath
}

export function setOAuthCallbackPath(path: string): void {
  oauthCallbackPath = path.startsWith("/") ? path : `/${path}`
}

/** Configuration options for OAuth */
export interface McpOAuthConfig {
  grantType?: "authorization_code" | "client_credentials"
  clientId?: string
  clientSecret?: string
  scope?: string
  authorizationParams?: Record<string, string>
  redirectUri?: string
  clientName?: string
  clientUri?: string
  logoUri?: string
  skipIssuerMetadataValidation?: boolean
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
])

function addAuthorizationParams(authorizationUrl: URL, params: Record<string, string> | undefined): URL {
  if (!params) return authorizationUrl
  const nextUrl = new URL(authorizationUrl.toString())
  for (const [key, value] of Object.entries(params)) {
    if (reservedAuthorizationParams.has(key) || nextUrl.searchParams.has(key)) {
      throw new Error(`OAuth authorizationParams.${key} cannot override an authorization flow parameter`)
    }
    nextUrl.searchParams.set(key, value)
  }
  return nextUrl
}

/** Callbacks for OAuth flow interactions */
export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>
}

/**
 * OAuth provider implementation for MCP servers.
 * Implements the OAuthClientProvider interface from the MCP SDK.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly redirectUrlSnapshot: string | undefined
  private active = true
  private flowClientInfo: StoredClientInfo | undefined
  private flowCodeVerifier: string | undefined
  private flowDiscoveryState: OAuthDiscoveryState | undefined
  private flowIssuerMismatch = false
  private flowState: string | undefined

  constructor(
    private serverName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    private storageOptions: AuthStorageOptions = {},
    private runtimeSignal?: AbortSignal,
    initialState?: string,
  ) {
    this.flowState = initialState
    this.redirectUrlSnapshot = config.grantType === "client_credentials"
      ? undefined
      : config.redirectUri ?? `http://localhost:${getOAuthCallbackPort()}${getOAuthCallbackPath()}`
  }

  private get usesClientCredentials(): boolean {
    return this.config.grantType === "client_credentials"
  }

  private get discoveredIssuer(): string | undefined {
    return this.flowDiscoveryState?.authorizationServerMetadata?.issuer
      ?? this.flowDiscoveryState?.authorizationServerUrl
  }

  deactivate(): void {
    this.active = false
  }

  private assertStoredIssuerBindings(entry: AuthEntry | undefined, issuer: string | undefined): void {
    if (this.flowIssuerMismatch) {
      throw new Error(
        `OAuth authorization server issuer changed for ${this.serverName}; clear credentials before authenticating again`,
      )
    }
    if (!entry || !issuer) return

    const storedIssuers = [entry.clientInfo?.issuer, entry.tokens?.issuer]
      .filter((storedIssuer): storedIssuer is string => storedIssuer !== undefined)
    if (storedIssuers.some(storedIssuer => !issuersMatch(storedIssuer, issuer))) {
      this.flowIssuerMismatch = true
      throw new Error(
        `OAuth authorization server issuer changed for ${this.serverName}; clear credentials before authenticating again`,
      )
    }
  }

  private throwIfInactive(): void {
    if (!this.active) throw new Error("OAuth flow is no longer active")
    this.runtimeSignal?.throwIfAborted()
  }

  /**
   * The redirect URL for OAuth callbacks.
   * This must match the redirect_uri in client metadata.
   */
  get redirectUrl(): string | undefined {
    return this.redirectUrlSnapshot
  }

  /** Configured homepage, else the historical default on stock pi, else nothing. */
  private get clientUri(): string | undefined {
    return this.config.clientUri ?? defaultClientUri()
  }

  /**
   * Client metadata for dynamic registration.
   * Describes this client to the OAuth authorization server.
   */
  get clientMetadata(): OAuthClientMetadata {
    if (this.usesClientCredentials) {
      return {
        client_name: this.config.clientName ?? defaultClientName(),
        ...(this.clientUri !== undefined ? { client_uri: this.clientUri } : {}),
        ...(this.config.logoUri !== undefined ? { logo_uri: this.config.logoUri } : {}),
        redirect_uris: [],
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
      }
    }

    const redirectUrl = this.redirectUrl
    if (!redirectUrl) {
      throw new Error("redirectUrl is required for authorization_code flow")
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
    }
  }

  /**
   * Get client information (for pre-registered or dynamically registered clients).
   * Returns undefined if no client info exists or if the server URL has changed.
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const issuer = this.discoveredIssuer
    const stored = await getAuthForUrl(this.serverName, this.serverUrl, this.storageOptions)
    this.assertStoredIssuerBindings(stored, issuer)

    // Check config first (pre-registered client). Store only its issuer binding.
    // The configured secret stays in config and never enters the credential store.
    if (this.config.clientId) {
      const storedClient = stored?.clientInfo?.clientId === this.config.clientId
        ? stored.clientInfo
        : undefined
      if (issuer && (storedClient?.issuer !== issuer || storedClient.configPreRegistered !== true)) {
        updateClientInfo(
          this.serverName,
          { clientId: this.config.clientId, issuer, configPreRegistered: true },
          this.serverUrl,
          this.storageOptions,
        )
      }
      const clientSecret = this.config.clientSecret?.startsWith("!")
        ? resolveCommandSecret(
          this.config.clientSecret,
          `MCP server "${this.serverName}" OAuth clientSecret`,
        )
        : this.config.clientSecret
      return {
        client_id: this.config.clientId,
        client_secret: clientSecret,
        ...(issuer !== undefined ? { issuer } : {}),
      } as IssuerBoundClientInformation
    }

    // Keep client registration associated with this in-flight flow even if
    // another runtime writes the shared persistent entry for the same name.
    const clientInfo = this.flowClientInfo ?? stored?.clientInfo
    if (clientInfo) {
      // A stored SEP-2352 issuer stub for a config-pre-registered client
      // (identified by the explicit marker, or by the legacy stub shape of
      // {clientId, issuer} with no registration metadata) is only meaningful
      // when the config supplies the matching client secret. Since we reach
      // this branch only when config.clientId is absent, serving the stub
      // would let a token refresh go out with a client_id but no secret,
      // causing invalid_client and credential invalidation. Return undefined
      // so callers treat this as "no client info".
      const isConfigStub = clientInfo.configPreRegistered === true
        || (clientInfo.clientSecret === undefined
          && clientInfo.clientIdIssuedAt === undefined
          && clientInfo.clientSecretExpiresAt === undefined
          && clientInfo.redirectUris === undefined)
      if (isConfigStub) {
        return undefined
      }
      // Check if client secret has expired
      if (clientInfo.clientSecretExpiresAt && clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
        return undefined
      }
      if (issuer && clientInfo.issuer && !issuersMatch(clientInfo.issuer, issuer)) {
        return undefined
      }
      if (issuer && clientInfo.issuer === undefined) {
        clientInfo.issuer = issuer
        this.flowClientInfo = clientInfo
        updateClientInfo(this.serverName, clientInfo, this.serverUrl, this.storageOptions)
      }
      // Return all registration metadata and the local issuer extension.
      // This keeps the SDK OAuth view and the stored issuer binding consistent.
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
      } as IssuerBoundClientInformation
    }

    // No client info or URL changed - will trigger dynamic registration
    return undefined
  }

  /**
   * Save client information from dynamic registration.
   */
  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.throwIfInactive()
    const issuer = this.discoveredIssuer ?? (info as IssuerBoundClientInformation).issuer
    if (this.config.clientId && info.client_id === this.config.clientId) {
      updateClientInfo(
        this.serverName,
        {
          clientId: info.client_id,
          ...(issuer !== undefined ? { issuer } : {}),
          configPreRegistered: true,
        },
        this.serverUrl,
        this.storageOptions,
      )
      return
    }

    const redirectUris = ("redirect_uris" in info ? info.redirect_uris : undefined)
      ?? (this.redirectUrl ? [this.redirectUrl] : undefined)
    const clientInfo: StoredClientInfo = {
      clientId: info.client_id,
      ...(info.client_secret !== undefined ? { clientSecret: info.client_secret } : {}),
      ...(info.client_id_issued_at !== undefined ? { clientIdIssuedAt: info.client_id_issued_at } : {}),
      ...(info.client_secret_expires_at !== undefined ? { clientSecretExpiresAt: info.client_secret_expires_at } : {}),
      ...(redirectUris !== undefined ? { redirectUris } : {}),
      ...(issuer !== undefined ? { issuer } : {}),
    }
    this.flowClientInfo = clientInfo
    updateClientInfo(this.serverName, clientInfo, this.serverUrl, this.storageOptions)
  }

  /**
   * Get stored OAuth tokens.
   * Returns undefined if no tokens exist or if the server URL has changed.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    // Use getAuthForUrl to validate tokens are for the current server URL.
    const entry = await getAuthForUrl(this.serverName, this.serverUrl, this.storageOptions)
    if (!entry?.tokens) return undefined
    const issuer = this.discoveredIssuer
    this.assertStoredIssuerBindings(entry, issuer)
    if (issuer && entry.tokens.issuer === undefined) {
      entry.tokens.issuer = issuer
      updateTokens(this.serverName, entry.tokens, this.serverUrl, this.storageOptions)
    }

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
      ...(entry.tokens.issuer !== undefined ? { issuer: entry.tokens.issuer } : {}),
    } as IssuerBoundTokens
  }

  /**
   * Save OAuth tokens.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const issuer = this.discoveredIssuer ?? (tokens as IssuerBoundTokens).issuer
    const storedTokens: StoredTokens = {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token !== undefined ? { refreshToken: tokens.refresh_token } : {}),
      // Preserve expiry even when expires_in is 0 (e.g. the SDK re-saving an
      // already-expired token) so expired tokens stay expired instead of
      // being persisted as never-expiring.
      ...(tokens.expires_in !== undefined ? { expiresAt: Date.now() / 1000 + tokens.expires_in } : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      ...(issuer !== undefined ? { issuer } : {}),
    }
    this.throwIfInactive()
    updateTokens(this.serverName, storedTokens, this.serverUrl, this.storageOptions)
    // Discovery must survive the browser redirect so the callback can verify
    // the authorization server that minted the code. Once token issuance
    // succeeds, clear it so a later 401 re-reads PRM and can observe an
    // authorization-server migration.
    this.flowDiscoveryState = undefined
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
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.usesClientCredentials) {
      throw new Error("redirectToAuthorization is not used for client_credentials flow")
    }
    // No flow-local state means we're on the post-refresh authorize fallback.
    this.throwIfInactive()
    if (!this.flowState) {
      throw new UnauthorizedError(
        `Re-authentication required for MCP server: ${this.serverName}`,
      )
    }
    // URL is passed to callback, not logged (may contain sensitive params)
    await this.callbacks.onRedirect(addAuthorizationParams(authorizationUrl, this.config.authorizationParams))
  }

  /**
   * Save the PKCE code verifier.
   */
  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.throwIfInactive()
    this.flowCodeVerifier = codeVerifier
  }

  /**
   * Get the stored PKCE code verifier.
   * @throws Error if no code verifier is stored
   */
  async codeVerifier(): Promise<string> {
    if (this.usesClientCredentials) {
      throw new Error("codeVerifier is not used for client_credentials flow")
    }
    this.throwIfInactive()
    if (!this.flowCodeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.serverName}`)
    }
    return this.flowCodeVerifier
  }

  /**
   * Keep discovery with the in-flight PKCE verifier. The callback leg uses it
   * to validate the authorization response issuer before token exchange.
   */
  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.throwIfInactive()
    this.flowDiscoveryState = structuredClone(state)
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    this.throwIfInactive()
    return this.flowDiscoveryState ? structuredClone(this.flowDiscoveryState) : undefined
  }

  /**
   * Save the OAuth state parameter for CSRF protection.
   */
  async saveState(state: string): Promise<void> {
    this.throwIfInactive()
    this.flowState = state
  }

  /**
   * Get the stored OAuth state parameter.
   * @throws UnauthorizedError if no flow is in progress (see redirectToAuthorization)
   */
  async state(): Promise<string> {
    if (this.usesClientCredentials) {
      throw new Error("state is not used for client_credentials flow")
    }
    this.throwIfInactive()
    if (!this.flowState) {
      throw new UnauthorizedError(
        `Re-authentication required for MCP server: ${this.serverName}`,
      )
    }
    return this.flowState
  }

  /**
   * Invalidate credentials when authentication fails.
   * Clears tokens, client info, or all credentials based on the type.
   */
  async invalidateCredentials(type: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    this.throwIfInactive()
    switch (type) {
      case "all":
        this.flowClientInfo = undefined
        this.flowCodeVerifier = undefined
        this.flowDiscoveryState = undefined
        this.flowIssuerMismatch = false
        this.flowState = undefined
        clearAllCredentials(this.serverName, this.storageOptions)
        break
      case "client":
        this.flowClientInfo = undefined
        clearClientInfo(this.serverName, this.storageOptions)
        break
      case "tokens":
        clearTokens(this.serverName, this.storageOptions)
        break
      case "verifier":
        clearCodeVerifier(this.serverName, this.storageOptions)
        break
      case "discovery":
        this.flowDiscoveryState = undefined
        break
    }
  }

  /**
   * Adds configured authorization-code scope without replacing the SDK's
   * default token endpoint authentication behavior.
   */
  addClientAuthentication: AddClientAuthentication = async (headers, params, _url, metadata) => {
    this.throwIfInactive()
    if (params.get("grant_type") === "authorization_code" && !params.has("scope") && this.config.scope) {
      params.set("scope", this.config.scope)
    }

    const clientInfo = await this.clientInformation()
    this.throwIfInactive()
    if (!clientInfo) {
      return
    }

    const supportedMethods = metadata?.token_endpoint_auth_methods_supported ?? []
    const hasClientSecret = clientInfo.client_secret !== undefined
    let authMethod: "client_secret_basic" | "client_secret_post" | "none"

    if (supportedMethods.length === 0) {
      authMethod = hasClientSecret ? "client_secret_post" : "none"
    } else if (hasClientSecret && supportedMethods.includes("client_secret_basic")) {
      authMethod = "client_secret_basic"
    } else if (hasClientSecret && supportedMethods.includes("client_secret_post")) {
      authMethod = "client_secret_post"
    } else if (supportedMethods.includes("none")) {
      authMethod = "none"
    } else {
      authMethod = hasClientSecret ? "client_secret_post" : "none"
    }

    if (authMethod === "client_secret_basic") {
      if (!clientInfo.client_secret) {
        throw new Error("client_secret_basic authentication requires a client_secret")
      }
      headers.set("Authorization", `Basic ${Buffer.from(`${clientInfo.client_id}:${clientInfo.client_secret}`).toString("base64")}`)
      return
    }

    if (!params.has("client_id")) {
      params.set("client_id", clientInfo.client_id)
    }
    if (authMethod === "client_secret_post" && clientInfo.client_secret && !params.has("client_secret")) {
      params.set("client_secret", clientInfo.client_secret)
    }
  }

  prepareTokenRequest(scope?: string): URLSearchParams | undefined {
    if (!this.usesClientCredentials) {
      return undefined
    }

    const params = new URLSearchParams({ grant_type: "client_credentials" })
    const requestedScope = scope ?? this.config.scope
    if (requestedScope) {
      params.set("scope", requestedScope)
    }
    return params
  }
}

export { DEFAULT_OAUTH_CALLBACK_PORT, DEFAULT_OAUTH_CALLBACK_PATH }
