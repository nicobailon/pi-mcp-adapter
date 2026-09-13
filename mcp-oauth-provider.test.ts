/**
 * Tests for mcp-oauth-provider.ts - OAuth provider implementation
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { randomBytes } from "crypto"

// Set up isolated temp directory for tests
const TEST_DIR = join(tmpdir(), `mcp-oauth-test-${randomBytes(4).toString('hex')}`)
process.env.MCP_OAUTH_DIR = TEST_DIR

import {
  getOAuthCallbackPath,
  getOAuthCallbackPort,
  McpOAuthProvider,
  setOAuthCallbackPath,
  setOAuthCallbackPort,
  type McpOAuthConfig,
} from "./mcp-oauth-provider.ts"
import { getAuthForUrl, saveAuthEntry } from "./mcp-auth.ts"
import { UnauthorizedError } from "@modelcontextprotocol/client"
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/client"

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

  function createProvider(config: McpOAuthConfig = {}) {
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
        "http://localhost:19876/callback"
      )
    })

    it("should use a configured redirect URI", () => {
      const provider = createProvider({ redirectUri: "http://localhost:3118/slack/callback" })
      assert.strictEqual(provider.redirectUrl, "http://localhost:3118/slack/callback")
    })

    it("should snapshot generated redirect URI at construction", () => {
      const originalPort = getOAuthCallbackPort()
      const originalPath = getOAuthCallbackPath()
      setOAuthCallbackPort(41234)
      setOAuthCallbackPath("/snapshot/callback")

      try {
        const provider = createProvider()
        setOAuthCallbackPort(52345)
        setOAuthCallbackPath("/changed/callback")

        assert.strictEqual(provider.redirectUrl, "http://localhost:41234/snapshot/callback")
        assert.deepStrictEqual(provider.clientMetadata.redirect_uris, ["http://localhost:41234/snapshot/callback"])
      } finally {
        setOAuthCallbackPort(originalPort)
        setOAuthCallbackPath(originalPath)
      }
    })
  })

  describe("clientMetadata", () => {
    // client_name now follows the host app, so these assertions must not read
    // whatever PI_PACKAGE_DIR the developer's shell happens to export.
    const inheritedPackageDir = process.env.PI_PACKAGE_DIR
    const packageDirs: string[] = []
    before(() => {
      delete process.env.PI_PACKAGE_DIR
    })
    after(() => {
      if (inheritedPackageDir !== undefined) process.env.PI_PACKAGE_DIR = inheritedPackageDir
      for (const dir of packageDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    })

    it("should return correct metadata for public client", () => {
      const provider = createProvider()
      const metadata = provider.clientMetadata

      assert.deepStrictEqual(metadata.redirect_uris, ["http://localhost:19876/callback"])
      assert.strictEqual(metadata.client_name, "Pi Coding Agent")
      assert.strictEqual(metadata.client_uri, "https://github.com/nicobailon/pi-mcp-adapter")
      assert.deepStrictEqual(metadata.grant_types, ["authorization_code", "refresh_token"])
      assert.deepStrictEqual(metadata.response_types, ["code"])
      assert.strictEqual(metadata.token_endpoint_auth_method, "none")
    })

    it("should register under the host app name when pi is rebranded", () => {
      const original = process.env.PI_PACKAGE_DIR
      const dir = mkdtempSync(join(tmpdir(), "oauth-brand-"))
      packageDirs.push(dir)
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi", piConfig: { name: "arc" } }))
      process.env.PI_PACKAGE_DIR = dir
      try {
        assert.strictEqual(createProvider().clientMetadata.client_name, "arc")
      } finally {
        if (original === undefined) delete process.env.PI_PACKAGE_DIR
        else process.env.PI_PACKAGE_DIR = original
      }
    })

    it("should keep the historical client name on stock pi", () => {
      const original = process.env.PI_PACKAGE_DIR
      delete process.env.PI_PACKAGE_DIR
      try {
        assert.strictEqual(createProvider().clientMetadata.client_name, "Pi Coding Agent")
      } finally {
        if (original !== undefined) process.env.PI_PACKAGE_DIR = original
      }
    })

    it("should omit client_uri under a rebranded host rather than name the adapter", () => {
      const original = process.env.PI_PACKAGE_DIR
      const dir = mkdtempSync(join(tmpdir(), "oauth-brand-uri-"))
      packageDirs.push(dir)
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi", piConfig: { name: "arc" } }))
      process.env.PI_PACKAGE_DIR = dir
      try {
        // The client is arc; advertising the adapter's repo would misidentify it.
        assert.ok(!("client_uri" in createProvider().clientMetadata))
        // A host that declares its own homepage gets it advertised.
        const declaring = mkdtempSync(join(tmpdir(), "oauth-brand-declared-"))
        packageDirs.push(declaring)
        writeFileSync(
          join(declaring, "package.json"),
          JSON.stringify({ name: "pi", piConfig: { name: "arc", clientUri: "https://arc.workos.tools" } }),
        )
        process.env.PI_PACKAGE_DIR = declaring
        assert.strictEqual(createProvider().clientMetadata.client_uri, "https://arc.workos.tools")
        process.env.PI_PACKAGE_DIR = dir

        // An explicit config still wins.
        assert.strictEqual(
          createProvider({ clientUri: "https://arc.example" }).clientMetadata.client_uri,
          "https://arc.example",
        )
      } finally {
        if (original === undefined) delete process.env.PI_PACKAGE_DIR
        else process.env.PI_PACKAGE_DIR = original
      }
    })

    it("should omit logo_uri when unset", () => {
      const provider = createProvider()
      assert.ok(!("logo_uri" in provider.clientMetadata))
    })

    it("should advertise logo_uri when configured", () => {
      const provider = createProvider({ logoUri: "https://example.com/logo.png" })
      assert.strictEqual(provider.clientMetadata.logo_uri, "https://example.com/logo.png")
    })

    it("should return correct metadata for confidential client", () => {
      const provider = createProvider({ clientSecret: "secret" })
      const metadata = provider.clientMetadata

      assert.strictEqual(metadata.token_endpoint_auth_method, "client_secret_post")
    })

    it("should use configured redirect URI and client metadata", () => {
      const provider = createProvider({
        redirectUri: "http://localhost:3118/slack/callback",
        clientName: "Slack MCP",
        clientUri: "https://example.com/slack-mcp",
      })
      const metadata = provider.clientMetadata

      assert.deepStrictEqual(metadata.redirect_uris, ["http://localhost:3118/slack/callback"])
      assert.strictEqual(metadata.client_name, "Slack MCP")
      assert.strictEqual(metadata.client_uri, "https://example.com/slack-mcp")
    })

    it("should use configured client name for client_credentials", () => {
      const provider = createProvider({
        grantType: "client_credentials",
        clientName: "Service MCP",
      })
      const metadata = provider.clientMetadata

      assert.strictEqual(metadata.client_name, "Service MCP")
      assert.deepStrictEqual(metadata.redirect_uris, [])
      assert.deepStrictEqual(metadata.grant_types, ["client_credentials"])
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

    it("should not serve a config-pre-registered stub when no config clientId is present", async () => {
      // Stub written by the config-clientId path of saveClientInformation
      // (SEP-2352 stamp-and-resave): {clientId, issuer} with the marker.
      const provider = createProvider()
      saveAuthEntry(serverName, {
        clientInfo: {
          clientId: "config-client",
          issuer: "https://auth.example.com",
          configPreRegistered: true,
        },
        serverUrl,
      }, serverUrl)

      assert.strictEqual(await provider.clientInformation(), undefined)
    })

    it("should not serve a legacy unmarked {clientId, issuer} stub when no config clientId is present", async () => {
      const provider = createProvider()
      saveAuthEntry(serverName, {
        clientInfo: {
          clientId: "config-client",
          issuer: "https://auth.example.com",
        },
        serverUrl,
      }, serverUrl)

      assert.strictEqual(await provider.clientInformation(), undefined)
    })

    it("should still serve a dynamically-registered public client (no secret) with registration metadata", async () => {
      const provider = createProvider()
      saveAuthEntry(serverName, {
        clientInfo: {
          clientId: "public-client",
          clientIdIssuedAt: Math.floor(Date.now() / 1000),
          redirectUris: ["http://localhost:19876/callback"],
        },
        serverUrl,
      }, serverUrl)

      const info = await provider.clientInformation()
      assert.strictEqual(info?.client_id, "public-client")
      assert.strictEqual(info?.client_secret, undefined)
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
        redirect_uris: ["http://localhost:3118/callback"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: futureTime,
      }

      await provider.saveClientInformation(info)

      const storedInfo = await provider.clientInformation()
      assert.strictEqual(storedInfo?.client_id, "new-client")
      assert.strictEqual(storedInfo?.client_secret, "new-secret")
      assert.deepStrictEqual(getAuthForUrl(serverName, serverUrl)?.clientInfo?.redirectUris, ["http://localhost:3118/callback"])
    })

    it("should save the current redirect URL when registration omits redirect_uris", async () => {
      const provider = new McpOAuthProvider("redirect-fallback", serverUrl, { redirectUri: "http://localhost:3118/custom" }, {
        onRedirect: async () => {},
      })

      await provider.saveClientInformation({
        client_id: "fallback-client",
        client_secret: "fallback-secret",
      } as OAuthClientInformationFull)

      assert.deepStrictEqual(getAuthForUrl("redirect-fallback", serverUrl)?.clientInfo?.redirectUris, ["http://localhost:3118/custom"])
    })

    it("should return stored dynamic client info even when redirect URIs are stale", async () => {
      const provider = new McpOAuthProvider("stale-redirect-client", serverUrl, { redirectUri: "http://localhost:3118/current" }, {
        onRedirect: async () => {},
      })
      saveAuthEntry("stale-redirect-client", {
        clientInfo: {
          clientId: "stored-client",
          clientSecret: "stored-secret",
          redirectUris: ["http://localhost:19876/callback"],
        },
        serverUrl,
      }, serverUrl)

      const info = await provider.clientInformation()
      assert.strictEqual(info?.client_id, "stored-client")
      assert.strictEqual(info?.client_secret, "stored-secret")
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
    it("should call onRedirect with URL when a flow is in progress", async () => {
      const provider = new McpOAuthProvider("redirect-with-state", serverUrl, {}, {
        onRedirect: async (url) => {
          redirectCaptured = url
        },
      }, {}, undefined, "state-abc")
      const testUrl = new URL("https://example.com/auth")

      await provider.redirectToAuthorization(testUrl)

      assert.strictEqual(redirectCaptured, testUrl)
    })

    it("should throw UnauthorizedError when no flow is in progress", async () => {
      const provider = new McpOAuthProvider("redirect-no-state", serverUrl, {}, {
        onRedirect: async () => {},
      })

      await assert.rejects(
        async () => provider.redirectToAuthorization(new URL("https://example.com/auth")),
        (err: unknown) => err instanceof UnauthorizedError && /Re-authentication required/.test((err as Error).message),
      )
    })

    it("should ignore OAuth state saved for a different server URL before redirecting", async () => {
      let redirected = false
      const provider = new McpOAuthProvider("redirect-url-bound", serverUrl, {}, {
        onRedirect: async () => {
          redirected = true
        },
      })
      saveAuthEntry("redirect-url-bound", {
        oauthState: "stale-state",
        serverUrl: "https://different.example.com",
      }, "https://different.example.com")

      await assert.rejects(
        async () => provider.redirectToAuthorization(new URL("https://example.com/auth")),
        (err: unknown) => err instanceof UnauthorizedError && /Re-authentication required/.test((err as Error).message),
      )
      assert.strictEqual(redirected, false)
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
      assert.strictEqual(getAuthForUrl("code-verifier-test", serverUrl), undefined)
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

    it("should ignore code verifiers saved for a different server URL", async () => {
      const provider = new McpOAuthProvider("code-verifier-url-bound", serverUrl, {}, {
        onRedirect: async () => {},
      })
      saveAuthEntry("code-verifier-url-bound", {
        codeVerifier: "stale-verifier",
        serverUrl: "https://different.example.com",
      }, "https://different.example.com")

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
      assert.strictEqual(getAuthForUrl("state-test-save", serverUrl), undefined)
    })

    it("should throw UnauthorizedError when no state is saved", async () => {
      const provider = new McpOAuthProvider("state-test-throw", serverUrl, {}, {
        onRedirect: async () => {},
      })

      await assert.rejects(
        async () => provider.state(),
        (err: unknown) => err instanceof UnauthorizedError && /Re-authentication required/.test((err as Error).message),
      )
    })

    it("should ignore OAuth state saved for a different server URL", async () => {
      const provider = new McpOAuthProvider("state-url-bound", serverUrl, {}, {
        onRedirect: async () => {},
      })
      saveAuthEntry("state-url-bound", {
        oauthState: "stale-state",
        serverUrl: "https://different.example.com",
      }, "https://different.example.com")

      await assert.rejects(
        async () => provider.state(),
        (err: unknown) => err instanceof UnauthorizedError && /Re-authentication required/.test((err as Error).message),
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

    it("should invalidate tokens only for the current provider", async () => {
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

      const otherProvider = createProvider()
      assert.strictEqual((await otherProvider.tokens())?.access_token, "token")
    })

    it("should adopt tokens replaced by another process", async () => {
      const staleProvider = createProvider()
      await staleProvider.saveTokens({
        access_token: "stale-token",
        token_type: "Bearer",
      })
      assert.strictEqual((await staleProvider.tokens())?.access_token, "stale-token")

      // A separate process completes re-authentication after this provider has
      // already observed and cached the old token.
      saveAuthEntry(serverName, {
        tokens: { accessToken: "replacement-token" },
        serverUrl,
      }, serverUrl)

      await staleProvider.invalidateCredentials("tokens")

      assert.strictEqual((await staleProvider.tokens())?.access_token, "replacement-token")
    })

    it("should not invalidate a token saved after the failing token was observed", async () => {
      const provider = createProvider()
      await provider.saveTokens({
        access_token: "old-token",
        token_type: "Bearer",
      })
      assert.strictEqual((await provider.tokens({ issuer: "https://issuer.example" }))?.access_token, "old-token")

      await provider.saveTokens({
        access_token: "new-token",
        token_type: "Bearer",
      })
      await provider.invalidateCredentials("tokens")

      assert.strictEqual((await provider.tokens())?.access_token, "new-token")
    })

    it("should invalidate the token observed by the latest auth read", async () => {
      const provider = createProvider()
      await provider.saveTokens({
        access_token: "first-token",
        token_type: "Bearer",
      })
      assert.strictEqual((await provider.tokens({ issuer: "https://issuer.example" }))?.access_token, "first-token")

      await provider.saveTokens({
        access_token: "second-token",
        token_type: "Bearer",
      })
      assert.strictEqual((await provider.tokens({ issuer: "https://issuer.example" }))?.access_token, "second-token")

      await provider.invalidateCredentials("tokens")

      assert.strictEqual(await provider.tokens(), undefined)
      const otherProvider = createProvider()
      assert.strictEqual((await otherProvider.tokens())?.access_token, "second-token")
    })

    it("should invalidate client info only for the current provider", async () => {
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

      const otherProvider = createProvider()
      assert.strictEqual((await otherProvider.clientInformation())?.client_id, "client")
    })

    it("should adopt client information replaced by another process", async () => {
      const staleProvider = createProvider()
      await staleProvider.saveTokens({
        access_token: "replacement-token",
        token_type: "Bearer",
      })
      await staleProvider.saveClientInformation({
        client_id: "stale-client",
        client_secret: "stale-secret",
        redirect_uris: ["http://localhost/callback"],
      })
      assert.strictEqual((await staleProvider.clientInformation())?.client_id, "stale-client")

      saveAuthEntry(serverName, {
        tokens: { accessToken: "replacement-token" },
        clientInfo: {
          clientId: "replacement-client",
          clientSecret: "replacement-secret",
          redirectUris: ["http://localhost/callback"],
        },
        serverUrl,
      }, serverUrl)

      await staleProvider.invalidateCredentials("client")

      assert.strictEqual((await staleProvider.clientInformation())?.client_id, "replacement-client")
      assert.strictEqual((await staleProvider.tokens())?.access_token, "replacement-token")
    })
  })
})
