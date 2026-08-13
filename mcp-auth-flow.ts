/**
 * MCP Auth Flow
 * 
 * High-level OAuth flow management using the MCP SDK's built-in auth functions.
 */

import {
  auth as runSdkAuth,
  extractWWWAuthenticateParams,
  LATEST_PROTOCOL_VERSION,
  UnauthorizedError,
  type AuthOptions,
} from "@modelcontextprotocol/client"
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
  getOAuthState,
  clearOAuthState,
  getAuthBaseDir,
  OAuthCredentialStoreError,
  type AuthStorageOptions,
  type StoredTokens,
} from "./mcp-auth.ts"
import { isServerDisabled, type ServerEntry } from "./types.ts"
import { formatTerminalError, interpolateEnvRecord, interpolateEnvVars } from "./utils.ts"
import { abortable, throwIfAborted } from "./abort.ts"
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts"

/** Auth status for a server */
export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export interface McpOAuthRuntime {
  readonly signal: AbortSignal
}

export interface AuthenticateOptions {
  onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>
  onAuthorizationInput?: (
    authorizationUrl: string,
    signal: AbortSignal,
  ) => Promise<string | undefined>
  authStorageOptions?: AuthStorageOptions
  signal?: AbortSignal
  runtime?: McpOAuthRuntime
  skipIssuerMetadataValidation?: boolean
}

type AuthDiscovery = Pick<AuthOptions, "resourceMetadataUrl" | "scope" | "skipIssuerMetadataValidation">

function applyOAuthConfig(discovery: AuthDiscovery, config: McpOAuthConfig): AuthDiscovery {
  return {
    ...discovery,
    ...(config.scope !== undefined ? { scope: config.scope } : {}),
    ...(config.skipIssuerMetadataValidation === true ? { skipIssuerMetadataValidation: true } : {}),
  }
}

type PendingAuth = {
  serverName: string
  authProvider: McpOAuthProvider
  serverUrl: string
  authorizationUrl: string
  discovery: AuthDiscovery
  authStorageOptions: AuthStorageOptions
}

type RuntimeState = {
  controller: AbortController
  generation: number
  pendingAuths: Map<string, PendingAuth>
  pendingAuthStates: Map<string, string>
  pendingAuthCleanupTimers: Map<string, ReturnType<typeof setTimeout>>
  pendingAuthentications: Map<string, Promise<AuthStatus>>
}

const runtimeStates = new WeakMap<McpOAuthRuntime, RuntimeState>()
const activeRuntimes = new Set<McpOAuthRuntime>()

export function createOAuthRuntime(signal?: AbortSignal): McpOAuthRuntime {
  const controller = new AbortController()
  const runtime = { signal: combineAbortSignals(signal, controller.signal)! } satisfies McpOAuthRuntime
  runtimeStates.set(runtime, {
    controller,
    generation: 0,
    pendingAuths: new Map(),
    pendingAuthStates: new Map(),
    pendingAuthCleanupTimers: new Map(),
    pendingAuthentications: new Map(),
  })
  activeRuntimes.add(runtime)
  return runtime
}

let legacyRuntime = createOAuthRuntime()
activeRuntimes.delete(legacyRuntime)

function getRuntime(options?: AuthenticateOptions): McpOAuthRuntime {
  if (options?.runtime) {
    options.runtime.signal.throwIfAborted()
    activeRuntimes.add(options.runtime)
    return options.runtime
  }
  if (legacyRuntime.signal.aborted) legacyRuntime = createOAuthRuntime()
  activeRuntimes.add(legacyRuntime)
  return legacyRuntime
}

function getRuntimeState(runtime: McpOAuthRuntime): RuntimeState {
  const state = runtimeStates.get(runtime)
  if (!state) throw new Error("Unknown OAuth runtime")
  return state
}

function getPendingAuthKey(serverName: string, options: AuthStorageOptions): string {
  return `${serverName}|${getAuthBaseDir(options)}`
}

export function hasPendingAuth(serverName: string, options?: AuthStorageOptions, runtime?: McpOAuthRuntime): boolean {
  const state = getRuntimeState(runtime ?? legacyRuntime)
  if (options) {
    return state.pendingAuths.has(getPendingAuthKey(serverName, options))
  }
  return Array.from(state.pendingAuths.values()).some(pendingAuth => pendingAuth.serverName === serverName)
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
  if (definition.oauth?.clientId !== undefined) {
    if (typeof definition.oauth.clientId !== "string") throw new Error("OAuth clientId must be a string")
    config.clientId = interpolateEnvVars(definition.oauth.clientId)
  }
  if (definition.oauth?.clientSecret !== undefined) {
    if (typeof definition.oauth.clientSecret !== "string") throw new Error("OAuth clientSecret must be a string")
    // Preserve command expressions for the provider; interpolation remains eager for ordinary values.
    config.clientSecret = definition.oauth.clientSecret.startsWith("!")
      ? definition.oauth.clientSecret
      : interpolateEnvVars(definition.oauth.clientSecret)
  }
  if (definition.oauth?.scope !== undefined) {
    if (typeof definition.oauth.scope !== "string") throw new Error("OAuth scope must be a string")
    config.scope = interpolateEnvVars(definition.oauth.scope)
  }
  if (definition.oauth?.authorizationParams !== undefined) {
    const params = definition.oauth.authorizationParams
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("OAuth authorizationParams must be an object")
    }
    config.authorizationParams = {}
    for (const [key, value] of Object.entries(params)) {
      if (!key) throw new Error("OAuth authorizationParams keys must not be empty")
      if (typeof value !== "string") throw new Error(`OAuth authorizationParams.${key} must be a string`)
      config.authorizationParams[key] = interpolateEnvVars(value)
    }
  }
  if (definition.oauth?.redirectUri !== undefined) {
    if (typeof definition.oauth.redirectUri !== "string") {
      throw new Error("OAuth redirectUri must be a string")
    }
    const redirectUri = interpolateEnvVars(definition.oauth.redirectUri).trim()
    if (!redirectUri) {
      throw new Error("OAuth redirectUri must not be empty")
    }
    config.redirectUri = redirectUri
  }
  if (definition.oauth?.clientName !== undefined) {
    if (typeof definition.oauth.clientName !== "string") {
      throw new Error("OAuth clientName must be a string")
    }
    const clientName = interpolateEnvVars(definition.oauth.clientName).trim()
    if (!clientName) {
      throw new Error("OAuth clientName must not be empty")
    }
    config.clientName = clientName
  }
  if (definition.oauth?.clientUri !== undefined) {
    if (typeof definition.oauth.clientUri !== "string") {
      throw new Error("OAuth clientUri must be a string")
    }
    const clientUri = interpolateEnvVars(definition.oauth.clientUri).trim()
    if (!clientUri) {
      throw new Error("OAuth clientUri must not be empty")
    }
    config.clientUri = clientUri
  }
  if (definition.oauth?.logoUri !== undefined) {
    if (typeof definition.oauth.logoUri !== "string") {
      throw new Error("OAuth logoUri must be a string")
    }
    const logoUri = interpolateEnvVars(definition.oauth.logoUri).trim()
    if (!logoUri) {
      throw new Error("OAuth logoUri must not be empty")
    }
    // Consent screens fetch this server-side, so a local path silently renders
    // nothing. Fail here instead, where the message can say why.
    let parsed: URL
    try {
      parsed = new URL(logoUri)
    } catch {
      throw new Error("OAuth logoUri must be an absolute http(s) URL")
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("OAuth logoUri must be an absolute http(s) URL")
    }
    config.logoUri = logoUri
  }
  if (definition.oauth?.skipIssuerMetadataValidation !== undefined) {
    if (typeof definition.oauth.skipIssuerMetadataValidation !== "boolean") {
      throw new Error("OAuth skipIssuerMetadataValidation must be a boolean")
    }
    config.skipIssuerMetadataValidation = definition.oauth.skipIssuerMetadataValidation
  }
  return config
}

async function probeAuthDiscovery(serverUrl: string, definition?: ServerEntry, signal?: AbortSignal): Promise<AuthDiscovery> {
  // Discovery must not execute config commands or send their source text.
  const discoveryHeaders = definition?.headers
    ? Object.fromEntries(Object.entries(definition.headers).filter(([, value]) => !value.startsWith("!") || value.startsWith("!!")))
    : undefined
  const headers = new Headers(interpolateEnvRecord(discoveryHeaders))
  headers.set("content-type", "application/json")

  const controller = new AbortController()
  const discoverySignal = combineAbortSignals(signal, controller.signal)
  const timer = setTimeout(() => controller.abort(), 5000)

  try {
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
      ...(discoverySignal ? { signal: discoverySignal } : {}),
    })
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response)
    await response.body?.cancel().catch(() => {})
    return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) }
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal)
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
  if (isServerDisabled(definition)) throw new Error(`MCP server "${serverName}" is disabled`)
  const runtime = getRuntime(options)
  const runtimeState = getRuntimeState(runtime)
  const config = definition ? extractOAuthConfig(definition) : {}
  const authStorageOptions = options.authStorageOptions ?? {}
  const signal = combineAbortSignals(runtime.signal, options.signal)
  const generation = runtimeState.generation
  throwIfAborted(signal)

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
    }, authStorageOptions, runtime.signal)
    try {
      const discovery = applyOAuthConfig(await probeAuthDiscovery(serverUrl, definition, signal), config)
      throwIfAborted(signal)
      const result = await abortable(runSdkAuth(authProvider, { serverUrl, ...discovery }), signal)
      throwIfAborted(signal)
      if (result !== "AUTHORIZED") {
        throw new UnauthorizedError("Failed to authorize")
      }
      return { authorizationUrl: "" }
    } finally {
      authProvider.deactivate()
    }
  }

  const existingPendingAuth = runtimeState.pendingAuths.get(getPendingAuthKey(serverName, authStorageOptions))
  if (existingPendingAuth?.serverUrl === serverUrl) {
    return { authorizationUrl: existingPendingAuth.authorizationUrl }
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
    throwIfAborted(signal)
  } catch (error) {
    releaseCallbackServer(oauthState)
    try {
      await clearOAuthState(serverName, authStorageOptions)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OAuth startup cleanup failed")
    }
    throw error
  }

  let capturedUrl: URL | undefined
  const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
    onRedirect: async (url) => {
      capturedUrl = url
    },
  }, authStorageOptions, runtime.signal, oauthState)

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

    throwIfAborted(signal)

    const discovery = applyOAuthConfig(await probeAuthDiscovery(serverUrl, definition, signal), config)
    throwIfAborted(signal)
    const result = await abortable(runSdkAuth(authProvider, { serverUrl, ...discovery }), signal)
    throwIfAborted(signal)
    if (result === "AUTHORIZED") {
      authProvider.deactivate()
      releaseCallbackServer(oauthState)
      await clearOAuthState(serverName, authStorageOptions)
      return { authorizationUrl: "" }
    }
    if (!capturedUrl) {
      throw new UnauthorizedError("OAuth authorization URL was not provided")
    }
    await setPendingAuth(runtime, serverName, { serverName, authProvider, serverUrl, authorizationUrl: capturedUrl.toString(), discovery, authStorageOptions }, oauthState, signal, generation)
    return { authorizationUrl: capturedUrl.toString() }
  } catch (error) {
    authProvider.deactivate()
    try {
      await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "OAuth startup cleanup failed")
    }
    throw error
  }
}

async function setPendingAuth(
  runtime: McpOAuthRuntime,
  serverName: string,
  pendingAuth: PendingAuth,
  oauthState: string,
  signal?: AbortSignal,
  generation = getRuntimeState(runtime).generation,
): Promise<void> {
  const state = getRuntimeState(runtime)
  const key = getPendingAuthKey(serverName, pendingAuth.authStorageOptions)
  await clearPendingAuth(runtime, serverName, undefined, pendingAuth.authStorageOptions)
  throwIfAborted(signal)
  if (generation !== state.generation) throw new Error("OAuth runtime stopped")
  state.pendingAuths.set(key, pendingAuth)
  state.pendingAuthStates.set(key, oauthState)
  const cleanupTimer = setTimeout(() => {
    void clearPendingAuth(runtime, serverName, oauthState, pendingAuth.authStorageOptions).catch(error => {
      console.error(`MCP Auth: Timed-out flow cleanup failed: ${formatTerminalError(error)}`)
    })
  }, MANUAL_AUTH_TIMEOUT_MS)
  cleanupTimer.unref?.()
  state.pendingAuthCleanupTimers.set(key, cleanupTimer)
}

async function clearPendingAuth(runtime: McpOAuthRuntime, serverName: string, oauthState?: string, fallbackStorageOptions: AuthStorageOptions = {}): Promise<void> {
  const state = getRuntimeState(runtime)
  const key = getPendingAuthKey(serverName, fallbackStorageOptions)
  const pendingAuth = state.pendingAuths.get(key)
  const authStorageOptions = pendingAuth?.authStorageOptions ?? fallbackStorageOptions
  const pendingState = state.pendingAuthStates.get(key)
  if (oauthState && pendingState && pendingState !== oauthState) return

  const timer = state.pendingAuthCleanupTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    state.pendingAuthCleanupTimers.delete(key)
  }

  pendingAuth?.authProvider.deactivate()
  state.pendingAuths.delete(key)
  state.pendingAuthStates.delete(key)
  const stateToRelease = pendingState ?? oauthState
  if (stateToRelease) {
    cancelPendingCallback(stateToRelease)
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

/** Authorization code plus the optional RFC 9207 `iss` callback parameter. */
export interface AuthorizationCodeInput {
  code: string
  iss?: string
}

/**
 * Extract an OAuth authorization code (and the RFC 9207 `iss` parameter, when
 * present) from either a raw code, a query string, or the full localhost
 * redirect URL copied from the browser address bar.
 */
export function parseAuthorizationRedirectInput(input: string, expectedState?: string): AuthorizationCodeInput {
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
    if (code) {
      const iss = params.get("iss")
      return { code, ...(iss !== null ? { iss } : {}) }
    }
  }

  if (/^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) {
    return { code: trimmed }
  }

  throw new Error("Could not find an OAuth authorization code in the provided input")
}

/**
 * Extract an OAuth authorization code from either a raw code, a query string,
 * or the full localhost redirect URL copied from the browser address bar.
 */
export function parseAuthorizationCodeInput(input: string, expectedState?: string): string {
  return parseAuthorizationRedirectInput(input, expectedState).code
}

type AuthorizationResponse = {
  input: AuthorizationCodeInput
  source: "callback" | "manual"
}

/**
 * Wait for either the localhost callback or a manually pasted redirect URL.
 * The manual input prompt is dismissed as soon as either path finishes.
 */
export async function waitForAuthorizationResponse(
  callbackPromise: Promise<AuthorizationCodeInput>,
  authorizationUrl: string,
  expectedState: string,
  onAuthorizationInput?: AuthenticateOptions["onAuthorizationInput"],
  signal?: AbortSignal,
): Promise<AuthorizationResponse> {
  if (!onAuthorizationInput) {
    return {
      input: await abortable(callbackPromise, signal),
      source: "callback",
    }
  }

  const inputController = new AbortController()
  try {
    const response = await abortable(Promise.race([
      callbackPromise.then((input) => ({ input, source: "callback" as const })),
      onAuthorizationInput(authorizationUrl, inputController.signal).then((input) => ({
        input,
        source: "manual" as const,
      })),
    ]), signal)

    if (response.source === "callback") return response
    if (!response.input?.trim()) throw new Error("OAuth authentication cancelled")
    if (!getSearchParamsFromInput(response.input.trim())) {
      throw new Error("Paste the full OAuth callback URL, including its code and state parameters")
    }
    return {
      input: parseAuthorizationRedirectInput(response.input, expectedState),
      source: "manual",
    }
  } finally {
    inputController.abort()
  }
}

/**
 * Complete OAuth authentication from manual user input.
 */
export async function completeAuthFromInput(
  serverName: string,
  input: string,
  options: AuthenticateOptions = {},
): Promise<AuthStatus> {
  const runtime = getRuntime(options)
  const runtimeState = getRuntimeState(runtime)
  const fallbackAuthStorageOptions = options.authStorageOptions ?? {}
  const signal = combineAbortSignals(runtime.signal, options.signal)
  throwIfAborted(signal)
  const key = getPendingAuthKey(serverName, fallbackAuthStorageOptions)
  const oauthState = runtimeState.pendingAuthStates.get(key)
  throwIfAborted(signal)
  const parsed = parseAuthorizationRedirectInput(input, oauthState)
  return completeAuth(serverName, parsed, options)
}

/**
 * Complete OAuth authentication with the authorization code.
 */
export async function completeAuth(
  serverName: string,
  authorizationCode: string | AuthorizationCodeInput,
  options: AuthenticateOptions = {},
): Promise<AuthStatus> {
  const runtime = getRuntime(options)
  const runtimeState = getRuntimeState(runtime)
  const { code, iss } = typeof authorizationCode === "string"
    ? { code: authorizationCode, iss: undefined }
    : authorizationCode
  const fallbackAuthStorageOptions = options.authStorageOptions ?? {}
  const signal = combineAbortSignals(runtime.signal, options.signal)
  throwIfAborted(signal)
  const key = getPendingAuthKey(serverName, fallbackAuthStorageOptions)
  const pendingAuth = runtimeState.pendingAuths.get(key)
  const authStorageOptions = pendingAuth?.authStorageOptions ?? fallbackAuthStorageOptions
  if (!pendingAuth) {
    throw new Error(`No pending OAuth flow for server: ${serverName}`)
  }

  const oauthState = runtimeState.pendingAuthStates.get(key)
  throwIfAborted(signal)

  let keepPendingForRetry = false
  let caughtError: unknown
  try {
    const discoveryState = await pendingAuth.authProvider.discoveryState()
    const metadata = discoveryState?.authorizationServerMetadata
    const expectedIssuer = metadata?.issuer ?? discoveryState?.authorizationServerUrl
    const requiresIssuer = (metadata as { authorization_response_iss_parameter_supported?: unknown } | undefined)
      ?.authorization_response_iss_parameter_supported === true
    if (expectedIssuer !== undefined && iss === undefined && requiresIssuer) {
      keepPendingForRetry = true
      throw new Error(
        `The authorization server for ${serverName} requires the RFC 9207 "iss" parameter. ` +
        "Paste the full redirect URL from the browser address bar (not just the authorization code).",
      )
    }
    if (expectedIssuer !== undefined && iss !== undefined && iss !== expectedIssuer) {
      throw new Error(`The OAuth authorization response issuer does not match the discovered issuer for ${serverName}.`)
    }

    const result = await abortable(runSdkAuth(pendingAuth.authProvider, {
      serverUrl: pendingAuth.serverUrl,
      authorizationCode: code,
      ...(iss !== undefined ? { iss } : {}),
      ...pendingAuth.discovery,
    }), signal)
    throwIfAborted(signal)
    if (result !== "AUTHORIZED") {
      throw new UnauthorizedError("Failed to authorize")
    }
    return "authenticated"
  } catch (error) {
    caughtError = error
    throw error
  } finally {
    if (!keepPendingForRetry) {
      try {
        await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions)
      } catch (cleanupError) {
        if (caughtError !== undefined) {
          throw new AggregateError([caughtError, cleanupError], "OAuth completion cleanup failed")
        }
        throw cleanupError
      }
    }
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
  if (isServerDisabled(definition)) throw new Error(`MCP server "${serverName}" is disabled`)
  const runtime = getRuntime(options)
  const runtimeState = getRuntimeState(runtime)
  const authStorageOptions = options.authStorageOptions ?? {}
  const signal = combineAbortSignals(runtime.signal, options.signal)
  throwIfAborted(signal)
  const authKey = `${serverName}|${serverUrl}|${getAuthBaseDir(authStorageOptions)}`
  const inFlight = runtimeState.pendingAuthentications.get(authKey)
  if (inFlight) {
    return inFlight
  }

  const operation = (async (): Promise<AuthStatus> => {
    const { authorizationUrl } = await startAuth(serverName, serverUrl, definition, {
      ...options,
      ...(signal ? { signal } : {}),
      runtime,
    })

    if (!authorizationUrl) {
      return "authenticated"
    }

    let oauthState: string | undefined
    try {
      // Get the state that was already generated and stored in startAuth().
      // Keep this lookup and its abort check inside the cleanup boundary because
      // startAuth has already reserved callback state at this point.
      oauthState = runtimeState.pendingAuthStates.get(getPendingAuthKey(serverName, authStorageOptions))
      throwIfAborted(signal)
      if (!oauthState) {
        throw new Error("OAuth state not found - this should not happen")
      }

      // Register the callback BEFORE opening the browser.
      const callbackPromise = waitForCallback(oauthState)
      void callbackPromise.catch(() => {})

      // Open browser. Always surface the URL first so remote/headless users can copy it
      // even when the OS browser handoff is unavailable or invisible.
      if (options.onAuthorizationUrl) {
        await abortable(Promise.resolve(options.onAuthorizationUrl(authorizationUrl)), signal)
      } else {
        console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\n${authorizationUrl}`)
      }
      try {
        await abortable(open(authorizationUrl), signal)
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        console.warn(`MCP Auth: Failed to open browser for ${serverName}; waiting for manual callback`, { error })
      }

      const authorizationResponse = await waitForAuthorizationResponse(
        callbackPromise,
        authorizationUrl,
        oauthState,
        options.onAuthorizationInput,
        signal,
      )
      if (authorizationResponse.source === "manual") {
        cancelPendingCallback(oauthState)
      }

      // The callback server accepted only the flow-local reserved state. Manual
      // input is checked against the same state before token exchange.
      throwIfAborted(signal)

      return await completeAuth(serverName, authorizationResponse.input, {
        ...options,
        ...(signal ? { signal } : {}),
        runtime,
      })
    } catch (error) {
      if (oauthState) cancelPendingCallback(oauthState)
      try {
        await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "OAuth cancellation cleanup failed")
      }
      throw error
    }
  })()

  runtimeState.pendingAuthentications.set(authKey, operation)

  try {
    return await operation
  } finally {
    if (runtimeState.pendingAuthentications.get(authKey) === operation) {
      runtimeState.pendingAuthentications.delete(authKey)
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
  const runtime = getRuntime(options)
  const authStorageOptions = options.authStorageOptions ?? {}
  const signal = combineAbortSignals(runtime.signal, options.signal)
  throwIfAborted(signal)
  const entry = await getAuthForUrl(serverName, serverUrl, authStorageOptions)
  throwIfAborted(signal)
  if (!entry?.tokens) {
    return null
  }

  const expired = await isTokenExpired(serverName, authStorageOptions)
  if (expired === false) {
    return entry.tokens
  }

  if (expired === true && entry.tokens.refreshToken) {
    console.log(`MCP Auth: Token expired for ${serverName}, attempting refresh`)

    try {
      const authProvider = new McpOAuthProvider(serverName, serverUrl, {}, {
        onRedirect: async () => {},
      }, authStorageOptions, runtime.signal)

      try {
        const clientInfo = await authProvider.clientInformation()
        throwIfAborted(signal)
        if (!clientInfo) {
          console.log(`MCP Auth: No client info for refresh for ${serverName}`)
          return null
        }

        const discovery = await probeAuthDiscovery(serverUrl, undefined, signal)
        throwIfAborted(signal)
        const result = await abortable(runSdkAuth(authProvider, {
          serverUrl,
          ...discovery,
          ...(options.skipIssuerMetadataValidation === true ? { skipIssuerMetadataValidation: true } : {}),
        }), signal)
        throwIfAborted(signal)
        if (result !== "AUTHORIZED") {
          return null
        }
        const refreshed = await getAuthForUrl(serverName, serverUrl, authStorageOptions)
        throwIfAborted(signal)
        return refreshed?.tokens ?? null
      } finally {
        authProvider.deactivate()
      }
    } catch (error) {
      if (isAbortError(error, signal) || error instanceof OAuthCredentialStoreError) throw error
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
  getRuntime(options)
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
  const runtime = getRuntime(options)
  const signal = combineAbortSignals(runtime.signal, options.signal)
  throwIfAborted(signal)
  const authStorageOptions = options.authStorageOptions ?? {}
  const oauthState = await getOAuthState(serverName, authStorageOptions)
  throwIfAborted(signal)
  if (oauthState) {
    cancelPendingCallback(oauthState)
  }
  await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions)
  throwIfAborted(signal)
  clearAllCredentials(serverName, authStorageOptions)
  await clearOAuthState(serverName, authStorageOptions)
  throwIfAborted(signal)
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
export async function initializeOAuth(
  runtimeOrSignal?: McpOAuthRuntime | AbortSignal,
): Promise<McpOAuthRuntime> {
  if (runtimeOrSignal && "signal" in runtimeOrSignal) {
    runtimeOrSignal.signal.throwIfAborted()
    activeRuntimes.add(runtimeOrSignal)
    return runtimeOrSignal
  }

  await shutdownOAuth(legacyRuntime)
  legacyRuntime = createOAuthRuntime(runtimeOrSignal as AbortSignal | undefined)
  return legacyRuntime
}

/**
 * Shutdown one OAuth runtime. The callback server remains process-shared while
 * another runtime has pending/reserved callback state or is still active.
 */
export async function shutdownOAuth(runtime: McpOAuthRuntime = legacyRuntime): Promise<void> {
  const state = getRuntimeState(runtime)
  if (state.controller.signal.aborted) return
  state.generation += 1
  state.controller.abort(new Error("OAuth runtime stopped"))
  for (const callbackState of Array.from(state.pendingAuthStates.values())) cancelPendingCallback(callbackState)
  for (const pendingAuth of Array.from(state.pendingAuths.values())) {
    await clearPendingAuth(runtime, pendingAuth.serverName, undefined, pendingAuth.authStorageOptions)
  }
  state.pendingAuthentications.clear()
  activeRuntimes.delete(runtime)

  if (activeRuntimes.size === 0) {
    await stopCallbackServer()
  }
}
