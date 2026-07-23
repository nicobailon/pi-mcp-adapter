/**
 * MCP Auth Flow
 * 
 * High-level OAuth flow management using the MCP SDK's built-in auth functions.
 */

import {
  auth as runSdkAuth,
  extractWWWAuthenticateParams,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import open from "open"
import { McpOAuthProvider, type McpOAuthConfig } from "./mcp-oauth-provider.ts"
import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  stopCallbackServer,
  releaseCallbackServer,
} from "./mcp-callback-server.ts"
import {
  getAuthForUrl,
  isTokenExpired,
  hasStoredTokens,
  clearAllCredentials,
  clearClientInfo,
  clearTokens,
  clearCodeVerifier,
  updateOAuthState,
  getOAuthState,
  clearOAuthState,
  getAuthBaseDir,
  type AuthStorageOptions,
  type StoredTokens,
} from "./mcp-auth.ts"
import type { ServerEntry } from "./types.ts"
import { interpolateEnvRecord } from "./utils.ts"

/** Auth status for a server */
export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export interface AuthenticateOptions {
  onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>
  authStorageOptions?: AuthStorageOptions
}

type AuthDiscovery = {
  resourceMetadataUrl?: URL
  scope?: string
}

type PendingAuth = {
  serverName: string
  authProvider: McpOAuthProvider
  serverUrl: string
  discovery: AuthDiscovery
  authStorageOptions: AuthStorageOptions
}

const pendingAuths = new Map<string, PendingAuth>()
const pendingAuthStates = new Map<string, string>()
const pendingAuthCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Deduplicate concurrent authenticate() calls per server.
const pendingAuthentications = new Map<string, Promise<AuthStatus>>()

function getPendingAuthKey(serverName: string, options: AuthStorageOptions): string {
  return `${serverName}|${getAuthBaseDir(options)}`
}

/** Timeout for manual auth completion (5 minutes) */
const MANUAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Generate a cryptographically secure random state parameter.
 */
function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Extract OAuth configuration from a ServerEntry.
 */
export function extractOAuthConfig(definition: ServerEntry): McpOAuthConfig {
  if (definition.oauth === false) {
    return {}
  }

  const config: McpOAuthConfig = {}
  if (definition.oauth?.grantType !== undefined) config.grantType = definition.oauth.grantType
  if (definition.oauth?.clientId !== undefined) config.clientId = definition.oauth.clientId
  if (definition.oauth?.clientSecret !== undefined) config.clientSecret = definition.oauth.clientSecret
  if (definition.oauth?.scope !== undefined) config.scope = definition.oauth.scope
  if (definition.oauth?.redirectUri !== undefined) {
    if (typeof definition.oauth.redirectUri !== "string") {
      throw new Error("OAuth redirectUri must be a string")
    }
    const redirectUri = definition.oauth.redirectUri.trim()
    if (!redirectUri) {
      throw new Error("OAuth redirectUri must not be empty")
    }
    config.redirectUri = redirectUri
  }
  if (definition.oauth?.clientName !== undefined) {
    if (typeof definition.oauth.clientName !== "string") {
      throw new Error("OAuth clientName must be a string")
    }
    const clientName = definition.oauth.clientName.trim()
    if (!clientName) {
      throw new Error("OAuth clientName must not be empty")
    }
    config.clientName = clientName
  }
  if (definition.oauth?.clientUri !== undefined) {
    if (typeof definition.oauth.clientUri !== "string") {
      throw new Error("OAuth clientUri must be a string")
    }
    const clientUri = definition.oauth.clientUri.trim()
    if (!clientUri) {
      throw new Error("OAuth clientUri must not be empty")
    }
    config.clientUri = clientUri
  }
  return config
}

async function probeAuthDiscovery(serverUrl: string, definition?: ServerEntry): Promise<AuthDiscovery> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)

  try {
    const headers = new Headers(interpolateEnvRecord(definition?.headers))
    headers.set("content-type", "application/json")
    headers.set("accept", "application/json, text/event-stream")

    const response = await fetch(new URL(serverUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "pi-mcp-adapter", version: "2.11.0" },
        },
      }),
      signal: controller.signal,
    })
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response)
    await response.body?.cancel().catch(() => {})
    return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) }
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

function parseOAuthRedirectUri(redirectUri: string): { port: number; callbackHost: string; callbackPath: string } {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch (error) {
    throw new Error(`Invalid OAuth redirectUri: ${redirectUri}`, { cause: error })
  }

  const hostname = url.hostname.toLowerCase()
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
  if (url.protocol !== "http:" || !isLocalhost) {
    throw new Error("OAuth redirectUri must be an http:// localhost or loopback URI")
  }

  if (url.username || url.password) {
    throw new Error("OAuth redirectUri must not include username or password")
  }

  if (url.hash) {
    throw new Error("OAuth redirectUri must not include a fragment")
  }

  if (!url.port) {
    throw new Error("OAuth redirectUri must include an explicit numeric port")
  }

  const port = Number.parseInt(url.port, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("OAuth redirectUri must include an explicit numeric port")
  }

  const callbackHost = hostname === "[::1]" ? "::1" : hostname
  return { port, callbackHost, callbackPath: url.pathname }
}

/**
 * Start OAuth authentication flow for a server.
 * Returns the authorization URL when browser authorization is required.
 */
export async function startAuth(
  serverName: string,
  serverUrl: string,
  definition?: ServerEntry,
  options: AuthenticateOptions = {},
): Promise<{ authorizationUrl: string }> {
  const config = definition ? extractOAuthConfig(definition) : {}
  const authStorageOptions = options.authStorageOptions ?? {}

  if (config.grantType === "client_credentials") {
    const storedAuth = await getAuthForUrl(serverName, serverUrl, authStorageOptions)
    if (storedAuth?.clientInfo && !storedAuth.tokens && !config.clientId) {
      clearClientInfo(serverName, authStorageOptions)
      clearCodeVerifier(serverName, authStorageOptions)
      await clearOAuthState(serverName, authStorageOptions)
    }

    const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
      onRedirect: async () => {
        throw new Error("Browser redirect is not used for client_credentials flow")
      },
    }, authStorageOptions)
    const discovery = await probeAuthDiscovery(serverUrl, definition)
    const result = await runSdkAuth(authProvider, { serverUrl, ...discovery })
    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError("Failed to authorize")
    }
    return { authorizationUrl: "" }
  }

  const redirectCallback = config.redirectUri !== undefined ? parseOAuthRedirectUri(config.redirectUri) : undefined
  const oauthState = generateState()

  try {
    await ensureCallbackServer({
      strictPort: Boolean(config.clientId) || config.redirectUri !== undefined,
      oauthState,
      reserveState: true,
      ...(redirectCallback ? { port: redirectCallback.port, callbackHost: redirectCallback.callbackHost, callbackPath: redirectCallback.callbackPath } : {}),
    })
  } catch (error) {
    await clearOAuthState(serverName, authStorageOptions)
    throw error
  }

  let capturedUrl: URL | undefined
  const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
    onRedirect: async (url) => {
      capturedUrl = url
    },
  }, authStorageOptions)

  try {
    const storedAuth = await getAuthForUrl(serverName, serverUrl, authStorageOptions)
    if (storedAuth?.clientInfo && !config.clientId) {
      if (!storedAuth.tokens) {
        clearClientInfo(serverName, authStorageOptions)
        clearCodeVerifier(serverName, authStorageOptions)
        await clearOAuthState(serverName, authStorageOptions)
      } else {
        const redirectUris = storedAuth.clientInfo.redirectUris
        if (!Array.isArray(redirectUris) || !redirectUris.includes(authProvider.redirectUrl ?? "")) {
          clearClientInfo(serverName, authStorageOptions)
          clearTokens(serverName, authStorageOptions)
          clearCodeVerifier(serverName, authStorageOptions)
          await clearOAuthState(serverName, authStorageOptions)
        }
      }
    }

    await updateOAuthState(serverName, oauthState, serverUrl, authStorageOptions)

    const discovery = await probeAuthDiscovery(serverUrl, definition)
    const result = await runSdkAuth(authProvider, { serverUrl, ...discovery })
    if (result === "AUTHORIZED") {
      releaseCallbackServer(oauthState)
      await clearOAuthState(serverName, authStorageOptions)
      return { authorizationUrl: "" }
    }
    if (!capturedUrl) {
      throw new UnauthorizedError("OAuth authorization URL was not provided")
    }
    await setPendingAuth(serverName, { serverName, authProvider, serverUrl, discovery, authStorageOptions }, oauthState)
    return { authorizationUrl: capturedUrl.toString() }
  } catch (error) {
    await clearPendingAuth(serverName, oauthState, authStorageOptions)
    throw error
  }
}

async function setPendingAuth(
  serverName: string,
  pendingAuth: PendingAuth,
  oauthState: string,
): Promise<void> {
  const key = getPendingAuthKey(serverName, pendingAuth.authStorageOptions)
  await clearPendingAuth(serverName, undefined, pendingAuth.authStorageOptions)
  pendingAuths.set(key, pendingAuth)
  pendingAuthStates.set(key, oauthState)
  const cleanupTimer = setTimeout(() => {
    void clearPendingAuth(serverName, oauthState, pendingAuth.authStorageOptions)
  }, MANUAL_AUTH_TIMEOUT_MS)
  cleanupTimer.unref?.()
  pendingAuthCleanupTimers.set(key, cleanupTimer)
}

async function clearPendingAuth(serverName: string, oauthState?: string, fallbackStorageOptions: AuthStorageOptions = {}): Promise<void> {
  const key = getPendingAuthKey(serverName, fallbackStorageOptions)
  const pendingAuth = pendingAuths.get(key)
  const authStorageOptions = pendingAuth?.authStorageOptions ?? fallbackStorageOptions
  const pendingState = pendingAuthStates.get(key)
  if (oauthState && pendingState && pendingState !== oauthState) return

  const timer = pendingAuthCleanupTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    pendingAuthCleanupTimers.delete(key)
  }

  pendingAuths.delete(key)
  pendingAuthStates.delete(key)
  const stateToRelease = pendingState ?? oauthState
  if (stateToRelease) {
    releaseCallbackServer(stateToRelease)
    const storedState = await getOAuthState(serverName, authStorageOptions)
    if (storedState === stateToRelease) {
      await clearOAuthState(serverName, authStorageOptions)
    }
  }
}

function getSearchParamsFromInput(input: string): URLSearchParams | undefined {
  try {
    const url = new URL(input)
    const params = new URLSearchParams(url.search)
    if (url.hash) {
      const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash
      const hashParams = new URLSearchParams(hash)
      for (const [key, value] of hashParams) {
        if (!params.has(key)) params.set(key, value)
      }
    }
    return params
  } catch {
    const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input
    const params = new URLSearchParams(query.startsWith("#") ? query.slice(1) : query)
    return params.has("code") || params.has("state") || params.has("error") ? params : undefined
  }
}

/**
 * Extract an OAuth authorization code from either a raw code, a query string,
 * or the full localhost redirect URL copied from the browser address bar.
 */
export function parseAuthorizationCodeInput(input: string, expectedState?: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Authorization code or redirect URL is required")
  }

  const params = getSearchParamsFromInput(trimmed)
  if (params) {
    const error = params.get("error")
    if (error) {
      const description = params.get("error_description")
      throw new Error(description ? `${error}: ${description}` : error)
    }

    const state = params.get("state")
    if (expectedState && !state) {
      throw new Error("OAuth state missing from redirect URL")
    }
    if (expectedState && state !== expectedState) {
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }

    const code = params.get("code")
    if (code) return code
  }

  if (/^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) {
    return trimmed
  }

  throw new Error("Could not find an OAuth authorization code in the provided input")
}

/**
 * Complete OAuth authentication from manual user input.
 */
export async function completeAuthFromInput(
  serverName: string,
  input: string,
  options: AuthenticateOptions = {},
): Promise<AuthStatus> {
  const fallbackAuthStorageOptions = options.authStorageOptions ?? {}
  const authStorageOptions = pendingAuths.get(getPendingAuthKey(serverName, fallbackAuthStorageOptions))?.authStorageOptions ?? fallbackAuthStorageOptions
  const oauthState = await getOAuthState(serverName, authStorageOptions)
  const code = parseAuthorizationCodeInput(input, oauthState)
  return completeAuth(serverName, code, options)
}

/**
 * Complete OAuth authentication with the authorization code.
 */
export async function completeAuth(
  serverName: string,
  authorizationCode: string,
  options: AuthenticateOptions = {},
): Promise<AuthStatus> {
  const fallbackAuthStorageOptions = options.authStorageOptions ?? {}
  const key = getPendingAuthKey(serverName, fallbackAuthStorageOptions)
  const pendingAuth = pendingAuths.get(key)
  const authStorageOptions = pendingAuth?.authStorageOptions ?? fallbackAuthStorageOptions
  if (!pendingAuth) {
    throw new Error(`No pending OAuth flow for server: ${serverName}`)
  }

  const oauthState = await getOAuthState(serverName, authStorageOptions)

  try {
    const result = await runSdkAuth(pendingAuth.authProvider, {
      serverUrl: pendingAuth.serverUrl,
      authorizationCode,
      ...pendingAuth.discovery,
    })
    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError("Failed to authorize")
    }
    return "authenticated"
  } finally {
    await clearPendingAuth(serverName, oauthState, authStorageOptions)
  }
}

/**
 * Perform the complete OAuth authentication flow for a server.
 * 
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server  
 * @param definition - The server definition (optional)
 * @returns The final auth status
 */
export async function authenticate(
  serverName: string,
  serverUrl: string,
  definition?: ServerEntry,
  options: AuthenticateOptions = {},
): Promise<AuthStatus> {
  const authStorageOptions = options.authStorageOptions ?? {}
  const authKey = `${serverName}|${serverUrl}|${getAuthBaseDir(authStorageOptions)}`
  const inFlight = pendingAuthentications.get(authKey)
  if (inFlight) {
    return inFlight
  }

  const operation = (async (): Promise<AuthStatus> => {
    // Start auth flow
    const { authorizationUrl } = await startAuth(serverName, serverUrl, definition, options)

    // If no auth URL needed, already authenticated
    if (!authorizationUrl) {
      return "authenticated"
    }

    // Get the state that was already generated and stored in startAuth()
    const oauthState = await getOAuthState(serverName, authStorageOptions)
    if (!oauthState) {
      throw new Error("OAuth state not found - this should not happen")
    }

    // Register the callback BEFORE opening the browser
    const callbackPromise = waitForCallback(oauthState)

    try {
      // Open browser. Always surface the URL first so remote/headless users can copy it
      // even when the OS browser handoff is unavailable or invisible.
      if (options.onAuthorizationUrl) {
        await options.onAuthorizationUrl(authorizationUrl)
      } else {
        console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\n${authorizationUrl}`)
      }
      try {
        await open(authorizationUrl)
      } catch (error) {
        console.warn(`MCP Auth: Failed to open browser for ${serverName}; waiting for manual callback`, { error })
      }

      // Wait for callback
      const code = await callbackPromise

      // Validate state
      const storedState = await getOAuthState(serverName, authStorageOptions)
      if (storedState !== oauthState) {
        await clearOAuthState(serverName, authStorageOptions)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      await clearOAuthState(serverName, authStorageOptions)

      // Complete the auth
      return await completeAuth(serverName, code, options)
    } catch (error) {
      cancelPendingCallback(oauthState)
      await clearPendingAuth(serverName, oauthState, authStorageOptions)
      throw error
    }
  })()

  pendingAuthentications.set(authKey, operation)

  try {
    return await operation
  } finally {
    if (pendingAuthentications.get(authKey) === operation) {
      pendingAuthentications.delete(authKey)
    }
  }
}

/**
 * Get a valid access token for a server, refreshing if necessary.
 * 
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @returns The valid tokens or null if not authenticated
 */
export async function getValidToken(
  serverName: string,
  serverUrl: string,
  options: AuthenticateOptions = {},
): Promise<StoredTokens | null> {
  const authStorageOptions = options.authStorageOptions ?? {}
  // Check if we have valid tokens
  const entry = await getAuthForUrl(serverName, serverUrl, authStorageOptions)
  if (!entry?.tokens) {
    return null
  }

  // Check expiration
  const expired = await isTokenExpired(serverName, authStorageOptions)
  if (expired === false) {
    return entry.tokens
  }

  if (expired === true && entry.tokens.refreshToken) {
    // Token is expired, try to refresh
    console.log(`MCP Auth: Token expired for ${serverName}, attempting refresh`)

    try {
      // Create auth provider for token refresh
      const authProvider = new McpOAuthProvider(serverName, serverUrl, {}, {
        onRedirect: async () => {},
      }, authStorageOptions)

      const clientInfo = await authProvider.clientInformation()
      if (!clientInfo) {
        console.log(`MCP Auth: No client info for refresh for ${serverName}`)
        return null
      }

      const discovery = await probeAuthDiscovery(serverUrl)
      const result = await runSdkAuth(authProvider, { serverUrl, ...discovery })
      if (result !== "AUTHORIZED") {
        return null
      }
      const refreshed = await getAuthForUrl(serverName, serverUrl, authStorageOptions)
      return refreshed?.tokens ?? null
    } catch (error) {
      console.error(`MCP Auth: Token refresh failed for ${serverName}`, { error })
      return null
    }
  }

  // No expiration info or no refresh token, assume valid
  return entry.tokens
}

/**
 * Check the authentication status for a server.
 * 
 * @param serverName - The name of the MCP server
 * @returns The current auth status
 */
export async function getAuthStatus(serverName: string, options: AuthenticateOptions = {}): Promise<AuthStatus> {
  const authStorageOptions = options.authStorageOptions ?? {}
  const hasTokens = await hasStoredTokens(serverName, authStorageOptions)
  if (!hasTokens) return "not_authenticated"

  const expired = await isTokenExpired(serverName, authStorageOptions)
  return expired ? "expired" : "authenticated"
}

/**
 * Remove all OAuth credentials for a server.
 * 
 * @param serverName - The name of the MCP server
 */
export async function removeAuth(serverName: string, options: AuthenticateOptions = {}): Promise<void> {
  const authStorageOptions = options.authStorageOptions ?? {}
  const oauthState = await getOAuthState(serverName, authStorageOptions)
  if (oauthState) {
    cancelPendingCallback(oauthState)
  }
  await clearPendingAuth(serverName, oauthState, authStorageOptions)
  clearAllCredentials(serverName, authStorageOptions)
  await clearOAuthState(serverName, authStorageOptions)
  console.log(`MCP Auth: Removed credentials for ${serverName}`)
}

/**
 * Check if OAuth is supported for a server configuration.
 * OAuth is supported for HTTP servers unless explicitly disabled.
 * 
 * @param definition - The server definition
 * @returns True if OAuth is supported
 */
export function supportsOAuth(definition: ServerEntry): boolean {
  // OAuth requires a URL
  if (!definition.url) return false
  
  // Explicitly disabled via auth: false or oauth: false
  if (definition.auth === false) return false
  if (definition.oauth === false) return false
  if (definition.auth === "oauth") return true
  
  // Configured custom headers take precedence over implicit OAuth auto-detection.
  if (definition.headers && Object.keys(definition.headers).length > 0) return false

  // OAuth is enabled when auth is not specified (auto-detect)
  return definition.auth === undefined
}

/**
 * Initialize the OAuth system on startup.
 * OAuth callback binding is lazy and starts from startAuth() only.
 */
export async function initializeOAuth(): Promise<void> {}

/**
 * Shutdown the OAuth system.
 * Stops the callback server and cancels pending auths.
 */
export async function shutdownOAuth(): Promise<void> {
  for (const pendingAuth of Array.from(pendingAuths.values())) {
    await clearPendingAuth(pendingAuth.serverName, undefined, pendingAuth.authStorageOptions)
  }
  await stopCallbackServer()
}
