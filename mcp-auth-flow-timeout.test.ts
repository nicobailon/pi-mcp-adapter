import assert from "node:assert"
import { createServer } from "node:http"
import { after, before, describe, it } from "node:test"

import {
  initializeOAuth,
  shutdownOAuth,
  startAuth,
} from "./mcp-auth-flow.ts"
import {
  clearAllCredentials,
  resetTestAuthSecretStore,
} from "./mcp-auth.ts"

// A stalling authorization server proves the OAuth flow's outbound requests are
// timeout-bounded. Without the bound, the metadata fetch below would hang until
// the OS TCP timeout.
describe("OAuth flow request timeout", () => {
  const serverName = "oauth-timeout"
  let origin = ""
  let serverUrl = ""
  const previousTimeoutMs = process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS

  const server = createServer((request, response) => {
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
      }))
      return
    }

    // Authorization-server metadata never responds; this is the stall the flow
    // must not wait on.
    if (request.method === "GET" && [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ].includes(requestUrl.pathname)) {
      return
    }

    response.writeHead(404)
    response.end()
  })

  before(async () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory"
    process.env.PI_MCP_ADAPTER_DISABLE_AUTH_CACHE = "1"
    process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS = "200"
    resetTestAuthSecretStore()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port")
    origin = `http://127.0.0.1:${address.port}`
    serverUrl = `${origin}/mcp`
    await initializeOAuth()
  })

  after(async () => {
    if (previousTimeoutMs === undefined) {
      delete process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS
    } else {
      process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS = previousTimeoutMs
    }
    await shutdownOAuth()
    clearAllCredentials(serverName)
    resetTestAuthSecretStore()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it("rejects when authorization-server metadata stalls, instead of hanging", async () => {
    const startedAt = Date.now()
    await assert.rejects(
      () => startAuth(serverName, serverUrl, { url: serverUrl, auth: "oauth" }),
    )
    const elapsedMs = Date.now() - startedAt
    assert.ok(
      elapsedMs < 5_000,
      `startAuth should have rejected at the request timeout, took ${elapsedMs}ms`,
    )
  })

  it("ignores malformed numeric-looking timeout overrides", async () => {
    process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS = "1e999"
    const originalTimeout = AbortSignal.timeout
    const observedTimeouts: number[] = []
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value(milliseconds: number) {
        observedTimeouts.push(milliseconds)
        return originalTimeout.call(AbortSignal, 50)
      },
    })

    try {
      await assert.rejects(
        () => startAuth(`${serverName}-malformed`, serverUrl, { url: serverUrl, auth: "oauth" }),
      )
    } finally {
      Object.defineProperty(AbortSignal, "timeout", {
        configurable: true,
        value: originalTimeout,
      })
      process.env.PI_MCP_OAUTH_REQUEST_TIMEOUT_MS = "200"
    }

    assert.equal(observedTimeouts[0], 30_000)
  })
})
