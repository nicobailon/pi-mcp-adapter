/**
 * Tests for mcp-auth-flow.ts - OAuth flow using MCP SDK
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

import {
  authenticate,
  startAuth,
  getAuthStatus,
  getValidToken,
  removeAuth,
  supportsOAuth,
  extractOAuthConfig,
  initializeOAuth,
  shutdownOAuth,
  waitForAuthorizationResponse,
} from "./mcp-auth-flow.ts"
import { isCallbackServerRunning } from "./mcp-callback-server.ts"
import { updateTokens, updateClientInfo, getAuthForUrl, clearAllCredentials } from "./mcp-auth.ts"
import type { ServerEntry } from "./types.ts"

describe("mcp-auth-flow", () => {
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

  after(async () => {
    // Shutdown OAuth and clean up
    await shutdownOAuth()
    try {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true })
      }
    } catch {
      // Ignore cleanup errors
    }
  })

  describe("supportsOAuth", () => {
    it("should return true for OAuth HTTP server", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
      }
      assert.strictEqual(supportsOAuth(definition), true)
    })

    it("should return false for bearer auth", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
        auth: "bearer",
      }
      assert.strictEqual(supportsOAuth(definition), false)
    })

    it("should return false for implicit OAuth when custom headers are configured", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
        headers: { "X-Goog-Api-Key": "api-key" },
      }
      assert.strictEqual(supportsOAuth(definition), false)
    })

    it("should return true for explicit OAuth even when custom headers are configured", () => {
      const definition: ServerEntry = {
        url: "https://api.example.com/mcp",
        auth: "oauth",
        headers: { "X-Tenant": "tenant-id" },
      }
      assert.strictEqual(supportsOAuth(definition), true)
    })

    it("should return false for stdio server", () => {
      const definition: ServerEntry = {
        command: "npx",
        args: ["-y", "@example/mcp-server"],
      }
      assert.strictEqual(supportsOAuth(definition), false)
    })

    it("should return false when no URL", () => {
      const definition: ServerEntry = {}
      assert.strictEqual(supportsOAuth(definition), false)
    })
  })

  describe("getAuthStatus", () => {
    it("should return 'not_authenticated' when no tokens", async () => {
      const status = await getAuthStatus("status-test-none")
      assert.strictEqual(status, "not_authenticated")
    })

    it("should return 'authenticated' when tokens exist and not expired", async () => {
      await updateTokens("status-test-ok", {
        accessToken: "token",
        expiresAt: Date.now() / 1000 + 3600, // 1 hour from now
      })

      const status = await getAuthStatus("status-test-ok")
      assert.strictEqual(status, "authenticated")
    })

    it("should return 'expired' when tokens are expired", async () => {
      await updateTokens("status-test-expired", {
        accessToken: "token",
        expiresAt: Date.now() / 1000 - 3600, // 1 hour ago
      })

      const status = await getAuthStatus("status-test-expired")
      assert.strictEqual(status, "expired")
    })
  })

  describe("removeAuth", () => {
    it("should remove all credentials", async () => {
      await updateTokens("remove-test", { accessToken: "token" })

      await removeAuth("remove-test")

      const status = await getAuthStatus("remove-test")
      assert.strictEqual(status, "not_authenticated")
    })
  })

  describe("getValidToken", () => {
    it("should not attempt refresh or wipe credentials when stored client info is a config-pre-registered stub", async () => {
      const serverName = "stub-refresh-test"
      const serverUrl = "https://stub-refresh.example.com/mcp"

      // Expired tokens with a refresh token: normally getValidToken would
      // attempt an SDK refresh.
      await updateTokens(serverName, {
        accessToken: "expired-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() / 1000 - 3600,
      }, serverUrl)

      // Secretless SEP-2352 issuer stub written for a config-pre-registered
      // client. getValidToken builds its provider with an empty config, so
      // this stub must not be served as client information; otherwise a
      // refresh goes out without a client secret, the AS returns
      // invalid_client, and the SDK invalidates stored credentials.
      await updateClientInfo(serverName, {
        clientId: "config-client",
        issuer: "https://auth.example.com",
        configPreRegistered: true,
      }, serverUrl)

      const result = await getValidToken(serverName, serverUrl)

      // Bails via the "no client info" guard before any network refresh.
      assert.strictEqual(result, null)

      // Stored credentials must remain intact - nothing was invalidated.
      const entry = await getAuthForUrl(serverName, serverUrl)
      assert.strictEqual(entry?.tokens?.accessToken, "expired-token")
      assert.strictEqual(entry?.tokens?.refreshToken, "refresh-token")
      assert.strictEqual(entry?.clientInfo?.clientId, "config-client")

      clearAllCredentials(serverName)
    })
  })

  describe("initializeOAuth / shutdownOAuth", () => {
    it("should not start callback server on initialize", async () => {
      await shutdownOAuth()
      await initializeOAuth()
      assert.strictEqual(isCallbackServerRunning(), false)
    })

    it("should stop callback server on shutdown", async () => {
      await initializeOAuth()
      await shutdownOAuth()
      assert.strictEqual(isCallbackServerRunning(), false)
    })
  })

  describe("waitForAuthorizationResponse", () => {
    it("should accept a pasted callback URL and validate its state", async () => {
      let promptSignal: AbortSignal | undefined
      const result = await waitForAuthorizationResponse(
        new Promise(() => {}),
        "https://auth.example.com/authorize",
        "expected-state",
        async (_authorizationUrl, signal) => {
          promptSignal = signal
          return "http://localhost:3118/callback?code=manual-code&state=expected-state"
        },
      )

      assert.deepStrictEqual(result, {
        input: { code: "manual-code" },
        source: "manual",
      })
      assert.strictEqual(promptSignal?.aborted, true)
    })

    it("should dismiss manual input when the localhost callback wins", async () => {
      let promptSignal: AbortSignal | undefined
      const result = await waitForAuthorizationResponse(
        Promise.resolve({ code: "callback-code" }),
        "https://auth.example.com/authorize",
        "expected-state",
        async (_authorizationUrl, signal) => {
          promptSignal = signal
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
          return undefined
        },
      )

      assert.deepStrictEqual(result, {
        input: { code: "callback-code" },
        source: "callback",
      })
      assert.strictEqual(promptSignal?.aborted, true)
    })

    it("should reject a pasted callback URL with the wrong state", async () => {
      await assert.rejects(
        waitForAuthorizationResponse(
          new Promise(() => {}),
          "https://auth.example.com/authorize",
          "expected-state",
          async () => "http://localhost:3118/callback?code=manual-code&state=wrong-state",
        ),
        /OAuth state mismatch/,
      )
    })

    it("should reject a pasted callback URL without state", async () => {
      await assert.rejects(
        waitForAuthorizationResponse(
          new Promise(() => {}),
          "https://auth.example.com/authorize",
          "expected-state",
          async () => "http://localhost:3118/callback?code=manual-code",
        ),
        /OAuth state missing/,
      )
    })

    it("should reject a raw authorization code from manual input", async () => {
      await assert.rejects(
        waitForAuthorizationResponse(
          new Promise(() => {}),
          "https://auth.example.com/authorize",
          "expected-state",
          async () => "manual-code",
        ),
        /Paste the full OAuth callback URL/,
      )
    })

    it("should abort manual input when the OAuth operation is cancelled", async () => {
      const controller = new AbortController()
      const reason = new Error("request cancelled")
      let promptSignal: AbortSignal | undefined
      const response = waitForAuthorizationResponse(
        new Promise(() => {}),
        "https://auth.example.com/authorize",
        "expected-state",
        async (_authorizationUrl, signal) => {
          promptSignal = signal
          return new Promise(() => {})
        },
        controller.signal,
      )

      controller.abort(reason)
      await assert.rejects(response, (error) => error === reason)
      assert.strictEqual(promptSignal?.aborted, true)
    })

    it("should treat dismissing manual input as cancellation", async () => {
      await assert.rejects(
        waitForAuthorizationResponse(
          new Promise(() => {}),
          "https://auth.example.com/authorize",
          "expected-state",
          async () => undefined,
        ),
        /OAuth authentication cancelled/,
      )
    })
  })

  describe("authenticate / completeAuth", () => {
    it("should throw if no server URL provided", async () => {
      await assert.rejects(
        async () => await authenticate("no-url-test", ""),
        /Invalid URL/
      )
    })

    it("should reject malformed OAuth redirectUri values", async () => {
      await assert.rejects(
        async () => await startAuth("bad-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "not a url" },
        }),
        /Invalid OAuth redirectUri/
      )
    })

    it("should reject non-local OAuth redirectUri values", async () => {
      await assert.rejects(
        async () => await startAuth("remote-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "https://example.com:3118/callback" },
        }),
        /localhost or loopback/
      )
    })

    it("should reject OAuth redirectUri values without an explicit port", async () => {
      await assert.rejects(
        async () => await startAuth("no-port-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "http://localhost/callback" },
        }),
        /explicit numeric port/
      )
    })

    it("should reject blank OAuth redirectUri values", async () => {
      await assert.rejects(
        async () => await startAuth("blank-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "  " },
        }),
        /redirectUri must not be empty/
      )
    })

    it("should reject non-string OAuth redirectUri values", async () => {
      await assert.rejects(
        async () => await startAuth("typed-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: 3118 as unknown as string },
        }),
        /redirectUri must be a string/
      )
    })

    it("should reject OAuth redirectUri values with fragments", async () => {
      await assert.rejects(
        async () => await startAuth("fragment-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "http://localhost:3118/callback#fragment" },
        }),
        /redirectUri must not include a fragment/
      )
    })

    it("should reject OAuth redirectUri values with username or password", async () => {
      await assert.rejects(
        async () => await startAuth("credential-redirect", "https://api.example.com/mcp", {
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { redirectUri: "http://user:pass@localhost:3118/callback" },
        }),
        /redirectUri must not include username or password/
      )
    })

    it("should reject non-string OAuth clientName and clientUri values", () => {
      assert.throws(
        () => extractOAuthConfig({
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { clientName: 123 as unknown as string },
        }),
        /clientName must be a string/
      )
      assert.throws(
        () => extractOAuthConfig({
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { clientUri: 123 as unknown as string },
        }),
        /clientUri must be a string/
      )
    })

    it("should accept an absolute http(s) OAuth logoUri", () => {
      const config = extractOAuthConfig({
        url: "https://api.example.com/mcp",
        auth: "oauth",
        oauth: { logoUri: "https://example.com/logo.png" },
      })
      assert.strictEqual(config.logoUri, "https://example.com/logo.png")
    })

    it("should reject an OAuth logoUri that is not an absolute http(s) URL", () => {
      // Consent screens fetch the logo server-side, so a local path renders
      // nothing at all — failing here is the only place it can be explained.
      for (const logoUri of ["./logo.png", "/Users/me/logo.png", "file:///tmp/logo.png"]) {
        assert.throws(
          () => extractOAuthConfig({
            url: "https://api.example.com/mcp",
            auth: "oauth",
            oauth: { logoUri },
          }),
          /logoUri must be an absolute http\(s\) URL/
        )
      }
      assert.throws(
        () => extractOAuthConfig({
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { logoUri: 123 as unknown as string },
        }),
        /logoUri must be a string/
      )
    })

    it("should reject malformed OAuth authorizationParams", () => {
      assert.throws(
        () => extractOAuthConfig({
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { authorizationParams: [] as unknown as Record<string, string> },
        }),
        /authorizationParams must be an object/
      )
      assert.throws(
        () => extractOAuthConfig({
          url: "https://api.example.com/mcp",
          auth: "oauth",
          oauth: { authorizationParams: { prompt: 123 as unknown as string } },
        }),
        /authorizationParams\.prompt must be a string/
      )
    })

    it("should trim OAuth redirectUri and client metadata values", () => {
      const config = extractOAuthConfig({
        url: "https://api.example.com/mcp",
        auth: "oauth",
        oauth: {
          redirectUri: "  http://localhost:3118/callback  ",
          clientName: "  Custom MCP  ",
          clientUri: "  https://example.com/custom  ",
        },
      })

      assert.strictEqual(config.redirectUri, "http://localhost:3118/callback")
      assert.strictEqual(config.clientName, "Custom MCP")
      assert.strictEqual(config.clientUri, "https://example.com/custom")
    })
  })
})
