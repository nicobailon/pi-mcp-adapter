/**
 * MCP Auth Flow
 * 
 * High-level OAuth flow management using the MCP SDK's built-in auth functions.
 */

import {
  auth as runSdkAuth,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
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
  type StoredTokens,
} from "./mcp-auth.ts"
import type { ServerEntry } from "./types.ts"

/** Auth status for a server */
export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// Track pending transports for auth completion
const pendingTransports = new Map<string, StreamableHTTPClientTransport>()
const pendingAuthStates = new Map<string, string>()
const pendingAuthCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Deduplicate concurrent authenticate() calls per server.
const pendingAuthentications = new Map<string, Promise<AuthStatus>>()

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
  definition?: ServerEntry
): Promise<{ authorizationUrl: string }> {
  const config = definition ? extractOAuthConfig(definition) : {}

  if (config.grantType === "client_credentials") {
    const storedAuth = await getAuthForUrl(serverName, serverUrl)
    if (storedAuth?.clientInfo && !storedAuth.tokens && !config.clientId) {
      clearClientInfo(serverName)
      clearCodeVerifier(serverName)
      await clearOAuthState(serverName)
    }

    const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
      onRedirect: async () => {
        throw new Error("Browser redirect is not used for client_credentials flow")
      },
    })
    const result = await runSdkAuth(authProvider, { serverUrl })
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
    await clearOAuthState(serverName)
    throw error
  }

  let capturedUrl: URL | undefined
  const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
    onRedirect: async (url) => {
      capturedUrl = url
    },
  })

  try {
    const storedAuth = await getAuthForUrl(serverName, serverUrl)
    if (storedAuth?.clientInfo && !config.clientId) {
      if (!storedAuth.tokens) {
        clearClientInfo(serverName)
        clearCodeVerifier(serverName)
        await clearOAuthState(serverName)
      } else {
        const redirectUris = storedAuth.clientInfo.redirectUris
        if (!Array.isArray(redirectUris) || !redirectUris.includes(authProvider.redirectUrl ?? "")) {
          clearClientInfo(serverName)
          clearTokens(serverName)
          clearCodeVerifier(serverName)
          await clearOAuthState(serverName)
        }
      }
    }

    await updateOAuthState(serverName, oauthState, serverUrl)

    const result = await runSdkAuth(authProvider, { serverUrl })
    if (result === "AUTHORIZED") {
      releaseCallbackServer(oauthState)
      await clearOAuthState(serverName)
      return { authorizationUrl: "" }
    }
    if (!capturedUrl) {
      throw new UnauthorizedError("OAuth authorization URL was not provided")
    }
    const pendingTransport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider })
    await setPendingTransport(serverName, pendingTransport, oauthState)
    return { authorizationUrl: capturedUrl.toString() }
  } catch (error) {
    await clearPendingAuth(serverName, oauthState)
    throw error
  }
}

async function setPendingTransport(
  serverName: string,
  transport: StreamableHTTPClientTransport,
  oauthState: string,
): Promise<void> {
  await clearPendingAuth(serverName)
  pendingTransports.set(serverName, transport)
  pendingAuthStates.set(serverName, oauthState)
  const cleanupTimer = setTimeout(() => {
    void clearPendingAuth(serverName, oauthState)
  }, MANUAL_AUTH_TIMEOUT_MS)
  cleanupTimer.unref?.()
  pendingAuthCleanupTimers.set(serverName, cleanupTimer)
}

async function clearPendingAuth(serverName: string, oauthState?: string): Promise<void> {
  const pendingState = pendingAuthStates.get(serverName)
  if (oauthState && pendingState && pendingState !== oauthState) return

  const timer = pendingAuthCleanupTimers.get(serverName)
  if (timer) {
    clearTimeout(timer)
    pendingAuthCleanupTimers.delete(serverName)
  }

  const transport = pendingTransports.get(serverName)
  pendingTransports.delete(serverName)
  pendingAuthStates.delete(serverName)
  const stateToRelease = pendingState ?? oauthState
  if (stateToRelease) {
    releaseCallbackServer(stateToRelease)
    const storedState = await getOAuthState(serverName)
    if (storedState === stateToRelease) {
      await clearOAuthState(serverName)
    }
  }
  if (transport) {
    await transport.close().catch(() => {})
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
): Promise<AuthStatus> {
  const oauthState = await getOAuthState(serverName)
  const code = parseAuthorizationCodeInput(input, oauthState)
  return completeAuth(serverName, code)
}

/**
 * Complete OAuth authentication with the authorization code.
 */
export async function completeAuth(
  serverName: string,
  authorizationCode: string
): Promise<AuthStatus> {
  const transport = pendingTransports.get(serverName)
  if (!transport) {
    throw new Error(`No pending OAuth flow for server: ${serverName}`)
  }

  const oauthState = await getOAuthState(serverName)

  try {
    // Complete the auth using the transport's finishAuth method
    await transport.finishAuth(authorizationCode)
    return "authenticated"
  } finally {
    await clearPendingAuth(serverName, oauthState)
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
): Promise<AuthStatus> {
  const inFlight = pendingAuthentications.get(serverName)
  if (inFlight) {
    return inFlight
  }

  const operation = (async (): Promise<AuthStatus> => {
    // Start auth flow
    const { authorizationUrl } = await startAuth(serverName, serverUrl, definition)

    // If no auth URL needed, already authenticated
    if (!authorizationUrl) {
      return "authenticated"
    }

    // Get the state that was already generated and stored in startAuth()
    const oauthState = await getOAuthState(serverName)
    if (!oauthState) {
      throw new Error("OAuth state not found - this should not happen")
    }

    // Register the callback BEFORE opening the browser
    const callbackPromise = waitForCallback(oauthState)

    try {
      // Open browser. Always print the URL first so remote/headless users can copy it
      // even when the OS browser handoff is unavailable or invisible.
      console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\n${authorizationUrl}`)
      try {
        await open(authorizationUrl)
      } catch (error) {
        console.warn(`MCP Auth: Failed to open browser for ${serverName}; waiting for manual callback`, { error })
      }

      // Wait for callback
      const code = await callbackPromise

      // Validate state
      const storedState = await getOAuthState(serverName)
      if (storedState !== oauthState) {
        await clearOAuthState(serverName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      await clearOAuthState(serverName)

      // Complete the auth
      return await completeAuth(serverName, code)
    } catch (error) {
      cancelPendingCallback(oauthState)
      await clearPendingAuth(serverName, oauthState)
      throw error
    }
  })()

  pendingAuthentications.set(serverName, operation)

  try {
    return await operation
  } finally {
    if (pendingAuthentications.get(serverName) === operation) {
      pendingAuthentications.delete(serverName)
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
): Promise<StoredTokens | null> {
  // Check if we have valid tokens
  const entry = await getAuthForUrl(serverName, serverUrl)
  if (!entry?.tokens) {
    return null
  }

  // Check expiration
  const expired = await isTokenExpired(serverName)
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
      })

      const clientInfo = await authProvider.clientInformation()
      if (!clientInfo) {
        console.log(`MCP Auth: No client info for refresh for ${serverName}`)
        return null
      }

      const result = await runSdkAuth(authProvider, { serverUrl })
      if (result !== "AUTHORIZED") {
        return null
      }
      const refreshed = await getAuthForUrl(serverName, serverUrl)
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
export async function getAuthStatus(serverName: string): Promise<AuthStatus> {
  const hasTokens = await hasStoredTokens(serverName)
  if (!hasTokens) return "not_authenticated"

  const expired = await isTokenExpired(serverName)
  return expired ? "expired" : "authenticated"
}

/**
 * Remove all OAuth credentials for a server.
 * 
 * @param serverName - The name of the MCP server
 */
export async function removeAuth(serverName: string): Promise<void> {
  const oauthState = await getOAuthState(serverName)
  if (oauthState) {
    cancelPendingCallback(oauthState)
  }
  await clearPendingAuth(serverName, oauthState)
  clearAllCredentials(serverName)
  await clearOAuthState(serverName)
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
  
  // OAuth is enabled if auth is 'oauth' or not specified (auto-detect)
  return definition.auth === "oauth" || definition.auth === undefined
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
  for (const serverName of Array.from(pendingTransports.keys())) {
    await clearPendingAuth(serverName)
  }
  await stopCallbackServer()
}
