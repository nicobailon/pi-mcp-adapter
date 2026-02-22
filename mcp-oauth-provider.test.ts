/**
 * Tests for mcp-oauth-provider.ts - OAuth provider implementation
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { existsSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { randomBytes } from "crypto"

// Set up isolated temp directory for tests
const TEST_DIR = join(tmpdir(), `mcp-oauth-test-${randomBytes(4).toString('hex')}`)
process.env.MCP_OAUTH_DIR = TEST_DIR

import { McpOAuthProvider } from "./mcp-oauth-provider.js"
import { saveAuthEntry } from "./mcp-auth.js"
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"

describe("McpOAuthProvider", () => {
  const serverName = "test-server"
  const serverUrl = "https://api.example.com"
  let redirectCaptured: URL | undefined

  before(() => {
    // Ensure clean state
    try {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true })
      }
      mkdirSync(TEST_DIR, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  after(() => {
    // Clean up temp directory
    try {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup errors
    }
    redirectCaptured = undefined
  })

  function createProvider(config: { clientId?: string; clientSecret?: string; scope?: string } = {}) {
    return new McpOAuthProvider(serverName, serverUrl, config, {
      onRedirect: async (url) => {
        redirectCaptured = url
      },
    })
  }

  describe("redirectUrl", () => {
    it("should return the correct redirect URL", () => {
      const provider = createProvider()
      assert.strictEqual(
        provider.redirectUrl,
        "http://127.0.0.1:19876/mcp/oauth/callback"
      )
    })
  })

  describe("clientMetadata", () => {
    it("should return correct metadata for public client", () => {
      const provider = createProvider()
      const metadata = provider.clientMetadata

      assert.deepStrictEqual(metadata.redirect_uris, ["http://127.0.0.1:19876/mcp/oauth/callback"])
      assert.strictEqual(metadata.client_name, "Pi Coding Agent")
      assert.strictEqual(metadata.client_uri, "https://github.com/nicobailon/pi-mcp-adapter")
      assert.deepStrictEqual(metadata.grant_types, ["authorization_code", "refresh_token"])
      assert.deepStrictEqual(metadata.response_types, ["code"])
      assert.strictEqual(metadata.token_endpoint_auth_method, "none")
    })

    it("should return correct metadata for confidential client", () => {
      const provider = createProvider({ clientSecret: "secret" })
      const metadata = provider.clientMetadata

      assert.strictEqual(metadata.token_endpoint_auth_method, "client_secret_post")
    })
  })

  describe("clientInformation", () => {
    it("should return config clientId when provided", async () => {
      const provider = createProvider({ clientId: "config-client", clientSecret: "config-secret" })
      const info = await provider.clientInformation()

      assert.strictEqual(info?.client_id, "config-client")
      assert.strictEqual(info?.client_secret, "config-secret")
    })

    it("should return stored client info when no config", async () => {
      const provider = createProvider()
      
      // Save client info directly
      saveAuthEntry(serverName, {
        clientInfo: {
          clientId: "stored-client",
          clientSecret: "stored-secret",
          clientIdIssuedAt: Math.floor(Date.now() / 1000),
          clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
        serverUrl,
      }, serverUrl)

      const info = await provider.clientInformation()
      assert.strictEqual(info?.client_id, "stored-client")
      assert.strictEqual(info?.client_secret, "stored-secret")
    })

    it("should return undefined when URL doesn't match", async () => {
      const provider = createProvider()
      
      // Save client info with different URL
      saveAuthEntry(serverName, {
        clientInfo: {
          clientId: "stored-client",
          clientSecret: "stored-secret",
        },
        serverUrl: "https://different.com",
      }, "https://different.com")

      const info = await provider.clientInformation()
      assert.strictEqual(info, undefined)
    })

    it("should return undefined when client secret expired", async () => {
      const provider = createProvider()
      
      // Save client info with expired secret
      saveAuthEntry(serverName, {
        clientInfo: {
          clientId: "stored-client",
          clientSecret: "stored-secret",
          clientSecretExpiresAt: 1, // Expired in 1970
        },
        serverUrl,
      }, serverUrl)

      const info = await provider.clientInformation()
      assert.strictEqual(info, undefined)
    })

    it("should prefer config over stored", async () => {
      const provider = createProvider({ clientId: "config-client" })
      
      // Save different client info
      saveAuthEntry(serverName, {
        clientInfo: {
          clientId: "stored-client",
          clientSecret: "stored-secret",
        },
        serverUrl,
      }, serverUrl)

      const info = await provider.clientInformation()
      assert.strictEqual(info?.client_id, "config-client")
    })
  })

  describe("saveClientInformation", () => {
    it("should save client information", async () => {
      const provider = createProvider()
      const futureTime = Math.floor(Date.now() / 1000) + 3600
      const info: OAuthClientInformationFull = {
        client_id: "new-client",
        client_secret: "new-secret",
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: futureTime,
      }

      await provider.saveClientInformation(info)

      const storedInfo = await provider.clientInformation()
      assert.strictEqual(storedInfo?.client_id, "new-client")
      assert.strictEqual(storedInfo?.client_secret, "new-secret")
    })
  })

  describe("tokens / saveTokens", () => {
    it("should save and retrieve tokens", async () => {
      const provider = createProvider()
      const tokens: OAuthTokens = {
        access_token: "access-123",
        token_type: "Bearer",
        refresh_token: "refresh-456",
        expires_in: 3600,
        scope: "read write",
      }

      await provider.saveTokens(tokens)
      const stored = await provider.tokens()

      assert.strictEqual(stored?.access_token, "access-123")
      assert.strictEqual(stored?.refresh_token, "refresh-456")
      assert.strictEqual(stored?.scope, "read write")
    })

    it("should calculate expires_in from stored expiresAt", async () => {
      const provider = createProvider()
      const futureTime = Math.floor(Date.now() / 1000) + 3600

      await provider.saveTokens({
        access_token: "access",
        token_type: "Bearer",
        expires_in: 3600,
      })

      const stored = await provider.tokens()
      assert.ok(stored?.expires_in !== undefined)
      assert.ok(stored!.expires_in! > 0)
      assert.ok(stored!.expires_in! <= 3600)
    })

    it("should return undefined when URL doesn't match", async () => {
      const provider = createProvider()
      
      // Save tokens with different URL
      saveAuthEntry(serverName, {
        tokens: {
          accessToken: "token",
        },
        serverUrl: "https://different.com",
      }, "https://different.com")

      const stored = await provider.tokens()
      assert.strictEqual(stored, undefined)
    })
  })

  describe("redirectToAuthorization", () => {
    it("should call onRedirect with URL", async () => {
      const provider = createProvider()
      const testUrl = new URL("https://example.com/auth")

      await provider.redirectToAuthorization(testUrl)

      assert.strictEqual(redirectCaptured, testUrl)
    })
  })

  describe("codeVerifier / saveCodeVerifier", () => {
    it("should save and retrieve code verifier", async () => {
      const provider = new McpOAuthProvider("code-verifier-test", serverUrl, {}, {
        onRedirect: async () => {},
      })

      await provider.saveCodeVerifier("verifier-abc-123")

      const verifier = await provider.codeVerifier()
      assert.strictEqual(verifier, "verifier-abc-123")
    })

    it("should throw when no code verifier", async () => {
      const provider = new McpOAuthProvider("code-verifier-throw", serverUrl, {}, {
        onRedirect: async () => {},
      })

      await assert.rejects(
        async () => provider.codeVerifier(),
        /No code verifier saved/
      )
    })
  })

  describe("state / saveState", () => {
    it("should save and retrieve state", async () => {
      const provider = new McpOAuthProvider("state-test-save", serverUrl, {}, {
        onRedirect: async () => {},
      })

      await provider.saveState("state-xyz-789")

      const state = await provider.state()
      assert.strictEqual(state, "state-xyz-789")
    })

    it("should throw when no state", async () => {
      const provider = new McpOAuthProvider("state-test-throw", serverUrl, {}, {
        onRedirect: async () => {},
      })

      await assert.rejects(
        async () => provider.state(),
        /No OAuth state saved/
      )
    })
  })

  describe("invalidateCredentials", () => {
    it("should remove all credentials when type is 'all'", async () => {
      const provider = createProvider()

      await provider.saveTokens({
        access_token: "token",
        token_type: "Bearer",
      })
      await provider.saveClientInformation({
        client_id: "client",
        client_secret: "secret",
        redirect_uris: ["http://localhost/callback"],
      })

      await provider.invalidateCredentials("all")

      assert.strictEqual(await provider.tokens(), undefined)
      assert.strictEqual(await provider.clientInformation(), undefined)
    })

    it("should only remove tokens when type is 'tokens'", async () => {
      const provider = createProvider()
      const futureTime = Math.floor(Date.now() / 1000) + 3600

      await provider.saveTokens({
        access_token: "token",
        token_type: "Bearer",
      })
      await provider.saveClientInformation({
        client_id: "client",
        client_secret: "secret",
        redirect_uris: ["http://localhost/callback"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: futureTime,
      })

      await provider.invalidateCredentials("tokens")

      assert.strictEqual(await provider.tokens(), undefined)
      const clientInfo = await provider.clientInformation()
      assert.strictEqual(clientInfo?.client_id, "client")
    })

    it("should only remove client info when type is 'client'", async () => {
      const provider = createProvider()
      const futureTime = Math.floor(Date.now() / 1000) + 3600

      await provider.saveTokens({
        access_token: "token",
        token_type: "Bearer",
      })
      await provider.saveClientInformation({
        client_id: "client",
        client_secret: "secret",
        redirect_uris: ["http://localhost/callback"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: futureTime,
      })

      await provider.invalidateCredentials("client")

      const tokens = await provider.tokens()
      assert.strictEqual(tokens?.access_token, "token")
      assert.strictEqual(await provider.clientInformation(), undefined)
    })
  })
})
