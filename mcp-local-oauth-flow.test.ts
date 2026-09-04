import assert from "node:assert"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { after, before, describe, it } from "node:test"

import {
  completeAuth,
  initializeOAuth,
  shutdownOAuth,
  startAuth,
} from "./mcp-auth-flow.ts"
import {
  clearAllCredentials,
  getAuthForUrl,
  getTestAuthSecretStoreEntries,
  resetTestAuthSecretStore,
  updateClientInfo,
  updateTokens,
} from "./mcp-auth.ts"
import { waitForCallback } from "./mcp-callback-server.ts"

describe("local OAuth authorization-code flow", () => {
  const serverName = "local-oauth-integration"
  let origin = ""
  let serverUrl = ""
  let authorizationRequest: URL | undefined
  let tokenRequest: URLSearchParams | undefined
  const registrationRedirectUris: string[][] = []
  const refreshTokenRequests: URLSearchParams[] = []
  const authServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", origin || "http://127.0.0.1")

    if (request.method === "POST" && requestUrl.pathname === "/mcp") {
      response.writeHead(401, {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      })
      response.end()
      return
    }

    if (request.method === "GET" && requestUrl.pathname === "/.well-known/oauth-protected-resource") {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({
        resource: serverUrl,
        authorization_servers: [origin],
        scopes_supported: ["mcp:read"],
      }))
      return
    }

    if (request.method === "GET" && [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ].includes(requestUrl.pathname)) {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      }))
      return
    }

    if (request.method === "POST" && requestUrl.pathname === "/register") {
      let body = ""
      for await (const chunk of request) body += chunk
      const metadata = JSON.parse(body) as { redirect_uris?: string[] }
      const redirectUris = metadata.redirect_uris ?? []
      registrationRedirectUris.push(redirectUris)
      response.writeHead(201, { "Content-Type": "application/json" })
      response.end(JSON.stringify({
        client_id: "new-dynamic-client",
        redirect_uris: redirectUris,
      }))
      return
    }

    if (request.method === "POST" && requestUrl.pathname === "/token") {
      let body = ""
      for await (const chunk of request) body += chunk
      tokenRequest = new URLSearchParams(body)
      if (tokenRequest.get("grant_type") === "refresh_token"
        && tokenRequest.get("refresh_token") === "revoked-refresh") {
        refreshTokenRequests.push(tokenRequest)
        response.writeHead(400, { "Content-Type": "application/json" })
        response.end(JSON.stringify({ error: "invalid_grant" }))
        return
      }
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({
        access_token: "example-access-token",
        refresh_token: "example-refresh-token",
        token_type: "Bearer",
        expires_in: 900,
        scope: "mcp:read",
      }))
      return
    }

    response.writeHead(404)
    response.end()
  })

  before(async () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory"
    process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE = "1"
    resetTestAuthSecretStore()
    await new Promise<void>((resolve, reject) => {
      authServer.once("error", reject)
      authServer.listen(0, "127.0.0.1", resolve)
    })
    const address = authServer.address()
    if (!address || typeof address === "string") throw new Error("OAuth test server did not bind a TCP port")
    origin = `http://127.0.0.1:${address.port}`
    serverUrl = `${origin}/mcp`
    await initializeOAuth()
  })

  after(async () => {
    await shutdownOAuth()
    clearAllCredentials(serverName)
    resetTestAuthSecretStore()
    await new Promise<void>(resolve => authServer.close(() => resolve()))
  })

  it("authorizes with S256 PKCE, handles a dynamic loopback callback, and stores tokens securely", async () => {
    const { authorizationUrl } = await startAuth(serverName, serverUrl, {
      url: serverUrl,
      auth: "oauth",
      oauth: {
        clientId: "pi-dev-client",
        scope: "mcp:read",
        redirectUri: "http://127.0.0.1:{port}/callback",
      },
    })
    authorizationRequest = new URL(authorizationUrl)

    assert.strictEqual(authorizationRequest.pathname, "/authorize")
    assert.strictEqual(authorizationRequest.searchParams.get("client_id"), "pi-dev-client")
    assert.strictEqual(authorizationRequest.searchParams.get("code_challenge_method"), "S256")
    assert.strictEqual(authorizationRequest.searchParams.get("resource"), serverUrl)
    assert.strictEqual(authorizationRequest.searchParams.get("scope"), "mcp:read")

    const state = authorizationRequest.searchParams.get("state")
    const redirectUri = authorizationRequest.searchParams.get("redirect_uri")
    const codeChallenge = authorizationRequest.searchParams.get("code_challenge")
    assert.ok(state)
    assert.match(redirectUri ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    assert.ok(codeChallenge)

    const callbackResultPromise = waitForCallback(state)
    const callbackUrl = new URL(redirectUri!)
    callbackUrl.searchParams.set("code", "example-authorization-code")
    callbackUrl.searchParams.set("state", state)
    callbackUrl.searchParams.set("iss", origin)
    const callbackResponse = await fetch(callbackUrl)
    assert.strictEqual(callbackResponse.status, 200)

    const callbackResult = await callbackResultPromise
    assert.deepStrictEqual(callbackResult, {
      code: "example-authorization-code",
      iss: origin,
    })
    assert.strictEqual(await completeAuth(serverName, callbackResult), "authenticated")

    assert.strictEqual(tokenRequest?.get("grant_type"), "authorization_code")
    assert.strictEqual(tokenRequest?.get("code"), "example-authorization-code")
    assert.strictEqual(tokenRequest?.get("client_id"), "pi-dev-client")
    assert.strictEqual(tokenRequest?.get("redirect_uri"), redirectUri)
    assert.strictEqual(tokenRequest?.get("resource"), serverUrl)
    const codeVerifier = tokenRequest?.get("code_verifier")
    assert.ok(codeVerifier)
    assert.strictEqual(
      createHash("sha256").update(codeVerifier).digest("base64url"),
      codeChallenge,
    )

    const stored = await getAuthForUrl(serverName, serverUrl)
    assert.strictEqual(stored?.tokens?.accessToken, "example-access-token")
    assert.strictEqual(stored?.tokens?.refreshToken, "example-refresh-token")
    assert.strictEqual(stored?.tokens?.scope, "mcp:read")
    assert.strictEqual(stored?.clientInfo?.clientId, "pi-dev-client")
    assert.strictEqual(stored?.codeVerifier, undefined)
    assert.strictEqual(stored?.oauthState, undefined)

    const secureStorePayload = getTestAuthSecretStoreEntries().map(([, value]) => value).join("")
    assert.ok(secureStorePayload.includes("example-access-token"))
    assert.ok(secureStorePayload.includes("example-refresh-token"))
    assert.ok(!secureStorePayload.includes(codeVerifier))
    assert.ok(!secureStorePayload.includes(state))
  })

  it("re-registers a stale dynamic client after a refresh invalid_grant", async () => {
    const refreshServerName = "local-oauth-redirect-refresh"
    const staleRedirectUri = "http://127.0.0.1:1/callback"
    await updateClientInfo(refreshServerName, {
      clientId: "stale-dynamic-client",
      redirectUris: [staleRedirectUri],
    }, serverUrl)
    await updateTokens(refreshServerName, {
      accessToken: "expired-access-token",
      refreshToken: "revoked-refresh",
      expiresAt: Date.now() / 1000 - 60,
    }, serverUrl)

    const registrationCount = registrationRedirectUris.length
    refreshTokenRequests.length = 0
    const { authorizationUrl } = await startAuth(refreshServerName, serverUrl, {
      url: serverUrl,
      auth: "oauth",
      oauth: { redirectUri: "http://127.0.0.1:{port}/callback" },
    })
    const fallbackAuthorizationRequest = new URL(authorizationUrl)

    assert.strictEqual(refreshTokenRequests.length, 1)
    assert.strictEqual(registrationRedirectUris.length, registrationCount + 1)
    const registeredRedirectUri = registrationRedirectUris[registrationRedirectUris.length - 1]?.[0]
    assert.ok(registeredRedirectUri)
    assert.notStrictEqual(registeredRedirectUri, staleRedirectUri)
    assert.strictEqual(fallbackAuthorizationRequest.searchParams.get("client_id"), "new-dynamic-client")
    assert.strictEqual(
      fallbackAuthorizationRequest.searchParams.get("redirect_uri"),
      registeredRedirectUri,
    )

    const stored = await getAuthForUrl(refreshServerName, serverUrl)
    assert.strictEqual(stored?.clientInfo?.clientId, "new-dynamic-client")
    clearAllCredentials(refreshServerName)
  })
})
