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
  completeAuth,
  getAuthStatus,
  removeAuth,
  supportsOAuth,
  initializeOAuth,
  shutdownOAuth,
  type AuthStatus,
} from "./mcp-auth-flow.ts"
import { isCallbackServerRunning } from "./mcp-callback-server.ts"
import { updateTokens, clearAllCredentials } from "./mcp-auth.ts"
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

  describe("initializeOAuth / shutdownOAuth", () => {
    it("should not eagerly start callback server on initialize", async () => {
      await initializeOAuth()
      assert.strictEqual(isCallbackServerRunning(), false)
    })

    it("shutdown should remain safe when no callback server was started", async () => {
      await initializeOAuth()
      await shutdownOAuth()
      assert.strictEqual(isCallbackServerRunning(), false)
    })
  })

  describe("authenticate / completeAuth", () => {
    it("should throw if no server URL provided", async () => {
      await assert.rejects(
        async () => await authenticate("no-url-test", ""),
        /Invalid URL/
      )
    })
  })
})
