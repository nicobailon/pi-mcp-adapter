import type { FetchLike } from "@modelcontextprotocol/client"
import { combineAbortSignals } from "./runtime-owner.ts"
import { interpolateEnvRecord, resolveCommandSecretsRecord } from "./utils.ts"

/**
 * Resolve only at a connection/authentication boundary, never during config discovery.
 * TypeError is fatal to the native SDK's fresh and cached discovery paths; ordinary
 * errors can be swallowed and allow authentication to continue without credentials.
 */
export function resolveOAuthHeaders(values: Record<string, string> | undefined, commands = true): Headers {
  const selected = Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) =>
    commands || !value.startsWith("!") || value.startsWith("!!")))
  for (const value of Object.values(selected)) {
    if (value.startsWith("!") && !value.startsWith("!!")) continue
    for (const match of value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
      const name = (match[1] ?? match[2] ?? match[3])!
      if (!process.env[name]) throw new TypeError("Missing environment credential in OAuth HTTP headers")
    }
  }
  try {
    const resolved = commands
      ? resolveCommandSecretsRecord(selected, () => "OAuth HTTP header")
      : interpolateEnvRecord(selected)
    if (Object.values(resolved ?? {}).some(value => !value.trim())) {
      throw new Error("empty header")
    }
    return new Headers(resolved)
  } catch {
    // Header constructors and command errors can otherwise include secret values.
    throw new TypeError("Failed to resolve OAuth HTTP headers")
  }
}

const DEFAULT_OAUTH_REQUEST_TIMEOUT_MS = 30_000
function resolveOAuthRequestTimeoutMs(): number {
  const parsed = Number(process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647
    ? parsed : DEFAULT_OAUTH_REQUEST_TIMEOUT_MS
}

export type OAuthFetch = FetchLike & { throwIfHeaderResolutionFailed(): void }

/**
 * Configured service headers belong only to the configured MCP origin, not to
 * discovered issuers. SDK request headers win (notably Authorization and MIME
 * types). Credential-bearing redirects fail closed, including same-origin ones.
 */
export function createOAuthFetch(
  serverUrl: string,
  getHeaders: () => Headers = () => new Headers(),
  signal?: AbortSignal,
  options: { timeout?: boolean; delegate?: FetchLike } = {},
): OAuthFetch {
  const origin = new URL(serverUrl).origin
  let headerResolutionError: TypeError | undefined
  const throwIfHeaderResolutionFailed = () => {
    if (headerResolutionError) throw headerResolutionError
  }
  const fetchFn: FetchLike = async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const combined = combineAbortSignals(signal, init?.signal ?? request?.signal,
      options.timeout === false ? undefined : AbortSignal.timeout(resolveOAuthRequestTimeoutMs()))
    combined?.throwIfAborted()
    throwIfHeaderResolutionFailed()
    let serviceHeaders: Headers
    try {
      serviceHeaders = url.origin === origin ? getHeaders() : new Headers()
    } catch {
      headerResolutionError = new TypeError("Failed to resolve OAuth HTTP headers")
      throw headerResolutionError
    }
    const headers = new Headers(serviceHeaders)
    new Headers(init?.headers ?? request?.headers).forEach((value, key) => headers.set(key, value))
    const protectedRequest = [...serviceHeaders].length > 0
    try {
      return await (options.delegate ?? globalThis.fetch)(input, {
        ...init,
        headers,
        ...(combined ? { signal: combined } : {}),
        ...(protectedRequest ? { redirect: "error" as const } : {}),
      })
    } catch (error) {
      combined?.throwIfAborted()
      // Fetch failures also include DNS, TLS, and connection errors. Do not
      // misdiagnose them as redirects or expose a potentially secret-bearing cause.
      if (protectedRequest) throw new TypeError("OAuth HTTP request failed")
      throw error
    }
  }
  return Object.assign(fetchFn, { throwIfHeaderResolutionFailed })
}

/** Cache success or failure only in the owning auth leg/connection, never in storage. */
export function oauthHeaderResolver(values: Record<string, string> | undefined): () => Headers {
  const snapshot = values ? { ...values } : undefined
  let result: { headers: Headers } | { error: unknown } | undefined
  return () => {
    if (!result) {
      try {
        result = { headers: resolveOAuthHeaders(snapshot) }
      } catch (error) {
        result = { error }
      }
    }
    if ("error" in result) throw result.error
    return result.headers
  }
}
