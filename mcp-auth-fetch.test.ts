import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { createOAuthFetch, oauthHeaderResolver, resolveOAuthHeaders } from "./mcp-auth-fetch.ts"
import { completeAuth, createOAuthRuntime, shutdownOAuth, startAuth } from "./mcp-auth-flow.ts"
import { getAuthForUrl, getTestAuthSecretStoreEntries, resetTestAuthSecretStore, updateTokens } from "./mcp-auth.ts"
import { getMcpOAuthTokensForUrl } from "./oauth.ts"
import { auth as runSdkAuth, type FetchLike } from "@modelcontextprotocol/client"
import { McpOAuthProvider } from "./mcp-oauth-provider.ts"
import type { ServerEntry } from "./types.ts"

const origin = "https://service.example.test"
const serverUrl = `${origin}/mcp`
const service = "synthetic-service-credential"
const metadata = (issuer = origin) => ({
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
})

// A real secret command that fails once (even though it prints a credential),
// then succeeds. Keep its invocation counter inside the checkout and clean it up.
function failingOnceHeaderCommand() {
  const directory = mkdtempSync(join(process.cwd(), ".oauth-header-test-"))
  const counter = join(directory, "count")
  const script = join(directory, "secret.cjs")
  writeFileSync(script, `
    const fs = require("node:fs");
    const counter = ${JSON.stringify(counter)};
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
    fs.writeFileSync(counter, String(count));
    process.stdout.write(${JSON.stringify(service)});
    process.exit(count === 1 ? 1 : 0);
  `)
  return {
    value: `!${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
    invocations: () => Number(readFileSync(counter, "utf8")),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
}

const headerResolutionFailure = (error: unknown) => {
  assert(error instanceof TypeError)
  assert.equal(error.message, "Failed to resolve OAuth HTTP headers")
  assert.equal(error.cause, undefined)
  assert(!String(error.stack).includes(service))
  return true
}

describe("origin-scoped OAuth fetch", () => {
  it("preserves SDK headers case-insensitively for URL and string inputs", async () => {
    const seen: Request[] = []
    const delegate: FetchLike = async (input, init) => { seen.push(new Request(input, init)); return json({}) }
    const fetchFn = createOAuthFetch(serverUrl, () => new Headers({
      "x-service-auth": service, AUTHORIZATION: "service-auth", "CONTENT-TYPE": "service/type",
    }), undefined, { delegate })
    for (const input of [serverUrl, new URL(serverUrl)]) {
      await fetchFn(input, { method: "POST", headers: [["Authorization", "Basic sdk"], ["content-type", "application/x-www-form-urlencoded"]], body: "grant_type=refresh_token" })
    }
    for (const request of seen) {
      assert.equal(request.headers.get("x-service-auth"), service)
      assert.equal(request.headers.get("authorization"), "Basic sdk")
      assert.equal(request.headers.get("content-type"), "application/x-www-form-urlencoded")
      assert.equal(request.redirect, "error")
      assert.equal(await request.text(), "grant_type=refresh_token")
    }
  })

  it("never forwards service headers to other schemes, hosts, ports, or callbacks", async () => {
    let resolutions = 0
    const fetchFn = createOAuthFetch(serverUrl, () => { resolutions++; return new Headers({ "x-service-auth": service }) }, undefined, {
      delegate: async (input, init) => {
        assert.equal(new Headers(init?.headers).get("x-service-auth"), null)
        return json({})
      },
    })
    for (const target of ["http://service.example.test/token", "https://other.example.test/token", "https://service.example.test:444/token", "http://127.0.0.1:19876/callback"]) await fetchFn(target)
    assert.equal(resolutions, 0)
  })

  it("resolves env and escaped literals, rejects missing/empty/invalid secrets without values", () => {
    process.env.MCP_TEST_SERVICE_HEADER = service
    try {
      assert.equal(resolveOAuthHeaders({ x: "${MCP_TEST_SERVICE_HEADER}" }).get("x"), service)
      assert.equal(resolveOAuthHeaders({ x: "$env:MCP_TEST_SERVICE_HEADER" }).get("x"), service)
      assert.equal(resolveOAuthHeaders({ x: "!!${MCP_TEST_SERVICE_HEADER}" }).get("x"), `!${service}`)
      for (const value of ["${MCP_TEST_MISSING_HEADER}", "Bearer $env:MCP_TEST_MISSING_HEADER", "", `${service}\ninvalid`, `!printf '${service}'; exit 1`]) {
        assert.throws(() => resolveOAuthHeaders({ x: value }), error => {
          assert(!String(error).includes(service))
          return true
        })
      }
      assert.equal(resolveOAuthHeaders({ x: "!exit 1" }, false).has("x"), false)
    } finally {
      delete process.env.MCP_TEST_SERVICE_HEADER
    }
  })

  it("resolves command output once per resolver and never reinterprets returned markers", () => {
    const getHeaders = oauthHeaderResolver({ x: "!printf '!literal-${NOT_INTERPOLATED}'" })
    assert.equal(getHeaders(), getHeaders())
    assert.equal(getHeaders().get("x"), "!literal-${NOT_INTERPOLATED}")
  })

  it("memoizes failed command resolution until a separately owned resolver retries", (t) => {
    const command = failingOnceHeaderCommand()
    t.after(command.cleanup)
    const values = { "x-service-auth": command.value }
    const getHeaders = oauthHeaderResolver(values)
    assert.throws(getHeaders, headerResolutionFailure)
    assert.throws(getHeaders, headerResolutionFailure)
    assert.equal(command.invocations(), 1)
    const retry = oauthHeaderResolver(values)
    assert.equal(retry().get("x-service-auth"), service)
    assert.equal(retry(), retry())
    assert.equal(command.invocations(), 2)
  })

  it("does not misdiagnose protected DNS, TLS, or connection failures as redirects", async () => {
    for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED", "ECONNREFUSED"]) {
      const cause = Object.assign(new Error(`${code}: ${service}`), { code })
      const fetchFn = createOAuthFetch(serverUrl, () => new Headers({ "x-service-auth": service }), undefined, {
        delegate: async () => { throw new TypeError("fetch failed", { cause }) },
      })
      await assert.rejects(fetchFn(serverUrl), error => {
        assert(error instanceof TypeError)
        assert.equal(error.message, "OAuth HTTP request failed")
        assert.equal(error.cause, undefined)
        assert(!String(error.stack).includes(service))
        assert(!error.message.toLowerCase().includes("redirect"))
        return true
      })
    }
  })

  it("redacts delegate failures and honors caller and request cancellation", async () => {
    const failure = createOAuthFetch(serverUrl, () => new Headers({ x: service }), undefined, {
      delegate: async () => { throw new Error(service) },
    })
    await assert.rejects(failure(serverUrl), error => !String(error).includes(service))
    for (const requestSignal of [false, true]) {
      const controller = new AbortController()
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const fetchFn = createOAuthFetch(serverUrl, () => new Headers({ x: service }), requestSignal ? undefined : controller.signal, {
        delegate: async (_input, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
          entered()
        }),
      })
      const pending = fetchFn(serverUrl, requestSignal ? { signal: controller.signal } : undefined)
      await started
      controller.abort(new Error("synthetic cancellation"))
      await assert.rejects(pending, /synthetic cancellation/)
    }
  })

  it("fails closed on same-origin and cross-origin redirects with zero requests to redirect targets", async () => {
    let targetHits = 0
    const target = createServer((_request, response) => { targetHits++; response.end() })
    await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve))
    const targetPort = (target.address() as import("node:net").AddressInfo).port
    const source = createServer((request, response) => {
      if (request.url === "/target") { targetHits++; response.end(); return }
      assert.equal(request.headers["x-service-auth"], service)
      response.writeHead(307, { location: request.url === "/same" ? "/target" : `http://127.0.0.1:${targetPort}/target` })
      response.end()
    })
    await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve))
    const localOrigin = `http://127.0.0.1:${(source.address() as import("node:net").AddressInfo).port}`
    try {
      const fetchFn = createOAuthFetch(localOrigin, () => new Headers({ "x-service-auth": service }))
      await assert.rejects(fetchFn(`${localOrigin}/same`), { name: "TypeError", message: "OAuth HTTP request failed" })
      await assert.rejects(fetchFn(`${localOrigin}/cross`), { name: "TypeError", message: "OAuth HTTP request failed" })
      assert.equal(targetHits, 0)
    } finally {
      source.closeAllConnections(); target.closeAllConnections()
      await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))])
    }
  })
})

describe("native SDK OAuth service headers", () => {
  const originalFetch = globalThis.fetch
  let runtime = createOAuthRuntime()
  let seen: Request[] = []
  let issuer = origin
  let requireService = true
  beforeEach(() => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory"
    resetTestAuthSecretStore()
    runtime = createOAuthRuntime()
    seen = []
    issuer = origin
    requireService = true
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init)
      seen.push(request)
      const url = new URL(request.url)
      if (url.pathname === "/mcp") {
        if (requireService && !request.headers.has("x-service-auth")) return new Response("gateway login", { headers: { "content-type": "text/html" } })
        return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } })
      }
      assert.equal(request.headers.get("x-service-auth"), requireService && url.origin === origin ? service : null)
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: serverUrl, authorization_servers: [issuer] })
      if (url.pathname.startsWith("/.well-known/")) return json(metadata(issuer))
      if (url.pathname === "/register") {
        assert.equal(request.headers.get("content-type"), "application/json")
        const body = await request.clone().json() as { redirect_uris: string[] }
        return json({ client_id: "dynamic-client", redirect_uris: body.redirect_uris }, 201)
      }
      if (url.pathname === "/token") {
        assert.equal(request.headers.get("content-type"), "application/x-www-form-urlencoded")
        return json({ access_token: "oauth-token", refresh_token: "refresh-token", token_type: "Bearer", expires_in: 3600 })
      }
      throw new Error("Unexpected synthetic request")
    }) as typeof fetch
  })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    await shutdownOAuth(runtime)
    resetTestAuthSecretStore()
  })
  const definition = (): ServerEntry => ({ url: serverUrl, auth: "oauth", headers: { "x-service-auth": service }, oauth: { redirectUri: "https://callback.example.test/callback" } })

  it("covers protected metadata, DCR, exchange, and public refresh without storing headers", async () => {
    const config = definition()
    const { authorizationUrl } = await startAuth("scoped", serverUrl, config, { runtime })
    assert.equal(new URL(authorizationUrl).origin, origin)
    await completeAuth("scoped", "synthetic-code", { runtime })
    const tokens = getAuthForUrl("scoped", serverUrl)!.tokens!
    updateTokens("scoped", { ...tokens, expiresAt: Date.now() / 1000 - 3600 }, serverUrl)
    assert.equal((await getMcpOAuthTokensForUrl("scoped", serverUrl, { definition: config }))?.accessToken, "oauth-token")
    assert.equal(new URL(seen.find(request => request.url.endsWith("/register"))!.url).origin, origin)
    const grants = await Promise.all(seen.filter(request => request.url.endsWith("/token")).map(async request => new URLSearchParams(await request.text()).get("grant_type")))
    assert.deepEqual(grants, ["authorization_code", "refresh_token"])
    assert(!JSON.stringify(getTestAuthSecretStoreEntries()).includes(service))
    assert(!seen.some(request => request.url.includes("/authorize") || request.url.includes("/callback")))
  })

  it("command-protected gateway HTML probe does not block authenticated SDK discovery", async () => {
    const config = definition()
    config.headers = { "x-service-auth": `!printf '${service}'` }
    await startAuth("command", serverUrl, config, { runtime })
    assert.equal(seen[0]?.headers.has("x-service-auth"), false)
    await completeAuth("command", "synthetic-code", { runtime })
    assert.equal(getAuthForUrl("command", serverUrl)?.tokens?.accessToken, "oauth-token")
    assert(seen.some(request => request.url.endsWith("/register")))
  })

  it("stops fresh SDK discovery after the first failed command; a new auth leg may retry", async (t) => {
    const command = failingOnceHeaderCommand()
    t.after(command.cleanup)
    const config = definition()
    config.headers = { "x-service-auth": command.value }
    await assert.rejects(startAuth("command-failure", serverUrl, config, { runtime }), headerResolutionFailure)
    assert.equal(command.invocations(), 1)
    // Only the command-free preliminary probe ran: no fallback metadata, DCR,
    // token request, or browser navigation followed the failed resolution.
    assert.deepEqual(seen.map(request => request.url), [serverUrl])
    assert.equal(getAuthForUrl("command-failure", serverUrl)?.tokens, undefined)

    await startAuth("command-failure", serverUrl, config, { runtime })
    assert.equal(command.invocations(), 2)
    assert(seen.some(request => request.url.endsWith("/register")))
  })

  it("does not swallow failed headers in cached discovery and continue to a cross-origin token endpoint", async (t) => {
    const command = failingOnceHeaderCommand()
    t.after(command.cleanup)
    issuer = "https://identity.example.test"
    const provider = new McpOAuthProvider("cached-command-failure", serverUrl, {
      grantType: "client_credentials", clientId: "configured-client",
    }, { onRedirect: async () => { assert.fail("Unexpected browser navigation") } })
    t.after(() => provider.deactivate())
    // Missing resourceMetadata triggers the SDK's cached-state PRM catch. If
    // that catch swallows the error, the cross-origin token call won't resolve
    // headers at all, so failure memoization alone cannot stop authentication.
    await provider.saveDiscoveryState({
      authorizationServerUrl: issuer,
      authorizationServerMetadata: metadata(issuer),
    })
    const fetchFn = createOAuthFetch(serverUrl, oauthHeaderResolver({ "x-service-auth": command.value }))
    await assert.rejects(runSdkAuth(provider, { serverUrl, fetchFn }), headerResolutionFailure)
    assert.equal(command.invocations(), 1)
    assert.equal(seen.length, 0)
    assert.equal(getAuthForUrl("cached-command-failure", serverUrl)?.tokens, undefined)
  })

  it("blocks SDK refresh-to-browser fallback after failed service credentials but allows a fresh leg", async (t) => {
    const command = failingOnceHeaderCommand()
    t.after(command.cleanup)
    issuer = "https://identity.example.test"
    const metadataUrl = `${issuer}/.well-known/openid-configuration`
    const delegate = globalThis.fetch
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url !== metadataUrl) return delegate(input, init)
      seen.push(request)
      assert.equal(request.headers.get("x-service-auth"), null)
      return json({ ...metadata(issuer), token_endpoint: `${origin}/token` })
    }) as typeof fetch
    const config = {
      clientId: "configured-client", redirectUri: "https://callback.example.test/callback",
      authServerMetadataUrl: metadataUrl,
    }
    updateTokens("refresh-command-failure", {
      accessToken: "expired-token", refreshToken: "refresh-token", expiresAt: Date.now() / 1000 - 3600, issuer,
    }, serverUrl)
    let redirects = 0
    const provider = new McpOAuthProvider("refresh-command-failure", serverUrl, config, {
      onRedirect: async () => { redirects++ },
    }, {}, undefined, "synthetic-state")
    t.after(() => provider.deactivate())
    const fetchFn = createOAuthFetch(serverUrl, oauthHeaderResolver({ "x-service-auth": command.value }))
    provider.setAuthFetch(fetchFn)

    await assert.rejects(runSdkAuth(provider, { serverUrl, fetchFn }), headerResolutionFailure)
    assert.equal(command.invocations(), 1)
    assert.equal(redirects, 0)
    assert.deepEqual(seen.map(request => request.url), [metadataUrl])
    assert.equal(getAuthForUrl("refresh-command-failure", serverUrl)?.tokens?.accessToken, "expired-token")
    assert(!JSON.stringify(getTestAuthSecretStoreEntries()).includes(service))
    // Even a cross-origin request on the failed leg must not escape a swallowed
    // SDK error; it cannot trigger command execution or network continuation.
    await assert.rejects(fetchFn(`${issuer}/token`), headerResolutionFailure)
    assert.equal(seen.length, 1)
    assert.equal(command.invocations(), 1)

    const result = await startAuth("refresh-command-failure", serverUrl, {
      url: serverUrl, auth: "oauth", headers: { "x-service-auth": command.value }, oauth: config,
    }, { runtime })
    assert.equal(result.authorizationUrl, "")
    assert.equal(command.invocations(), 2)
    assert.equal(getAuthForUrl("refresh-command-failure", serverUrl)?.tokens?.accessToken, "oauth-token")
    assert.equal(seen.filter(request => request.url.endsWith("/token")).length, 1)
  })

  it("preserves browser reauthorization after ordinary OAuth refresh failures with or without service headers", async () => {
    const delegate = globalThis.fetch
    let oauthError = "server_error"
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init)
      if (!request.url.endsWith("/token")) return delegate(input, init)
      seen.push(request)
      assert.equal(request.headers.get("x-service-auth"), requireService ? service : null)
      return json({ error: oauthError }, oauthError === "server_error" ? 503 : 400)
    }) as typeof fetch
    for (const withHeaders of [false, true]) {
      requireService = withHeaders
      for (const error of ["server_error", "invalid_grant"]) {
        oauthError = error
        const name = `refresh-recovery-${withHeaders}-${error}`
        const config = definition()
        if (!withHeaders) delete config.headers
        config.oauth = { ...config.oauth as object, clientId: "configured-client" }
        updateTokens(name, {
          accessToken: "expired-token", refreshToken: "refresh-token", expiresAt: Date.now() / 1000 - 3600, issuer: origin,
        }, serverUrl)
        const result = await startAuth(name, serverUrl, config, { runtime })
        assert.equal(new URL(result.authorizationUrl).pathname, "/authorize")
      }
    }
    assert.equal(seen.filter(request => request.url.endsWith("/token")).length, 4)
  })

  it("uses explicit metadata with headers and preserves SDK Basic authentication/content type", async () => {
    const config = definition()
    config.headers = { ...config.headers, AUTHORIZATION: "service-authorization", "Content-Type": "service/type" }
    config.oauth = { clientId: "configured-client", clientSecret: "configured-secret", grantType: "client_credentials", authServerMetadataUrl: `${origin}/.well-known/openid-configuration` }
    await startAuth("explicit", serverUrl, config, { runtime })
    assert(!seen.some(request => request.url.includes("oauth-protected-resource")))
    assert.equal(seen.find(request => request.url.endsWith("/token"))?.headers.get("authorization"), `Basic ${Buffer.from("configured-client:configured-secret").toString("base64")}`)
    const tokens = getAuthForUrl("explicit", serverUrl)!.tokens!
    updateTokens("explicit", { ...tokens, expiresAt: Date.now() / 1000 - 3600 }, serverUrl)
    assert.equal((await getMcpOAuthTokensForUrl("explicit", serverUrl, { definition: config }))?.accessToken, "oauth-token")
  })

  it("keeps cross-origin discovered and explicitly configured AS endpoints credential-free", async () => {
    issuer = "https://identity.example.test"
    for (const explicit of [false, true]) {
      const config = definition()
      if (explicit) config.oauth = { ...config.oauth as object, authServerMetadataUrl: `${issuer}/.well-known/openid-configuration` }
      const name = explicit ? "cross-explicit" : "cross-discovered"
      await startAuth(name, serverUrl, config, { runtime })
      await completeAuth(name, "synthetic-code", { runtime })
    }
    assert(seen.some(request => request.url === `${issuer}/register`))
    for (const request of seen.filter(request => new URL(request.url).origin === issuer)) assert.equal(request.headers.has("x-service-auth"), false)
  })

  it("preserves ordinary OAuth and public refresh with no custom-header option", async () => {
    requireService = false
    const config = definition()
    delete config.headers
    await startAuth("ordinary", serverUrl, config, { runtime })
    await completeAuth("ordinary", "synthetic-code", { runtime })
    updateTokens("ordinary", { ...getAuthForUrl("ordinary", serverUrl)!.tokens!, expiresAt: Date.now() / 1000 - 3600 }, serverUrl)
    assert.equal((await getMcpOAuthTokensForUrl("ordinary", serverUrl))?.accessToken, "oauth-token")
  })

  it("fails before any request for missing header credentials", async () => {
    const config = definition()
    config.headers = { "x-service-auth": "Bearer ${MCP_TEST_MISSING_HEADER}" }
    await assert.rejects(startAuth("missing", serverUrl, config, { runtime }), /Missing environment credential/)
    assert.equal(seen.length, 0)
  })

  it("cancels explicit metadata fetches with the caller signal and request timeout", async () => {
    for (const timeout of [false, true]) {
      const controller = new AbortController()
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const priorTimeout = process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS
      if (timeout) process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS = "25"
      globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input).endsWith("/mcp")) return new Response(null, { status: 401 })
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
          entered()
        })
      }) as typeof fetch
      const keepAlive = setInterval(() => {}, 100)
      try {
        const config = definition()
        config.oauth = { grantType: "client_credentials", clientId: "client", authServerMetadataUrl: `${origin}/.well-known/openid-configuration` }
        const pending = startAuth("cancel", serverUrl, config, { runtime, signal: controller.signal })
        await started
        if (!timeout) controller.abort(new Error("synthetic cancellation"))
        await assert.rejects(pending, timeout ? /timeout/i : /synthetic cancellation/)
        assert.equal(getAuthForUrl("cancel", serverUrl)?.tokens, undefined)
      } finally {
        clearInterval(keepAlive)
        if (priorTimeout === undefined) delete process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS
        else process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS = priorTimeout
      }
    }
  })
})
