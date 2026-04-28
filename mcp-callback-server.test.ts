/**
 * Tests for mcp-callback-server.ts - OAuth callback server
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  stopCallbackServer,
  isCallbackServerRunning,
  getPendingAuthCount,
} from "./mcp-callback-server.js"
import { getOAuthCallbackPort } from "./mcp-oauth-provider.js"

describe("mcp-callback-server", () => {
  beforeEach(async () => {
    // Stop any running server before each test
    await stopCallbackServer().catch(() => {})
  })

  afterEach(async () => {
    // Stop server after each test
    await stopCallbackServer().catch(() => {})
  })

  describe("ensureCallbackServer", () => {
    it("should start the callback server", async () => {
      await ensureCallbackServer()
      assert.strictEqual(isCallbackServerRunning(), true)
    })

    it("should be idempotent", async () => {
      await ensureCallbackServer()
      await ensureCallbackServer()
      await ensureCallbackServer()
      assert.strictEqual(isCallbackServerRunning(), true)
    })
  })

  describe("waitForCallback / callback handling", () => {
    it("should resolve with code on successful callback", async () => {
      await ensureCallbackServer()

      const state = "test-state-123"
      const expectedCode = "auth-code-abc"

      // Start waiting for callback
      const callbackPromise = waitForCallback(state)

      // Simulate callback by making HTTP request
      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://127.0.0.1:${callbackPort}/callback?code=${expectedCode}&state=${state}`
      )

      // Should get HTML success response
      assert.strictEqual(response.status, 200)
      const html = await response.text()
      assert.ok(html.includes("Authorization Successful"))

      // Callback promise should resolve
      const code = await callbackPromise
      assert.strictEqual(code, expectedCode)
    })

    it("should reject on error parameter", async () => {
      await ensureCallbackServer()

      const state = "test-state-error"
      const errorMsg = "access_denied"

      const callbackPromise = waitForCallback(state)

      // Simulate error callback
      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://127.0.0.1:${callbackPort}/callback?error=${errorMsg}&state=${state}`
      )

      assert.strictEqual(response.status, 200)
      const html = await response.text()
      assert.ok(html.includes("Authorization Failed"))

      // Callback promise should reject
      await assert.rejects(callbackPromise, /access_denied/)
    })

    it("should return 400 for missing state", async () => {
      await ensureCallbackServer()

      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://127.0.0.1:${callbackPort}/callback?code=abc123`
      )

      assert.strictEqual(response.status, 400)
      const html = await response.text()
      assert.ok(html.includes("Missing required state parameter"))
    })

    it("should return 400 for invalid state", async () => {
      await ensureCallbackServer()

      // Register a different state
      const pendingCallback = waitForCallback("valid-state")

      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://127.0.0.1:${callbackPort}/callback?code=abc123&state=invalid-state`
      )

      assert.strictEqual(response.status, 400)
      const html = await response.text()
      assert.ok(html.includes("Invalid or expired state parameter"))

      cancelPendingCallback("valid-state")
      await assert.rejects(pendingCallback, /Authorization cancelled/)
    })

    it("should return 400 for missing code", async () => {
      await ensureCallbackServer()

      const state = "test-state-no-code"
      const pendingCallback = waitForCallback(state)

      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://127.0.0.1:${callbackPort}/callback?state=${state}`
      )

      assert.strictEqual(response.status, 400)
      const html = await response.text()
      assert.ok(html.includes("No authorization code provided"))

      cancelPendingCallback(state)
      await assert.rejects(pendingCallback, /Authorization cancelled/)
    })

    it("should return 404 for wrong path", async () => {
      await ensureCallbackServer()

      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://127.0.0.1:${callbackPort}/wrong/path`
      )

      assert.strictEqual(response.status, 404)
    })
  })

  describe("cancelPendingCallback", () => {
    it("should reject pending callback", async () => {
      await ensureCallbackServer()

      const state = "test-state-cancel"
      const callbackPromise = waitForCallback(state)

      cancelPendingCallback(state)

      await assert.rejects(callbackPromise, /Authorization cancelled/)
    })
  })

  describe("stopCallbackServer", () => {
    it("should stop the server", async () => {
      await ensureCallbackServer()
      assert.strictEqual(isCallbackServerRunning(), true)

      await stopCallbackServer()
      assert.strictEqual(isCallbackServerRunning(), false)
    })

    it("should reject all pending callbacks", async () => {
      await ensureCallbackServer()

      const state1 = "state-1"
      const state2 = "state-2"

      const promise1 = waitForCallback(state1)
      const promise2 = waitForCallback(state2)

      await stopCallbackServer()

      await assert.rejects(promise1, /OAuth callback server stopped/)
      await assert.rejects(promise2, /OAuth callback server stopped/)
    })
  })

  describe("getPendingAuthCount", () => {
    it("should return 0 when no pending auths", async () => {
      await ensureCallbackServer()
      assert.strictEqual(getPendingAuthCount(), 0)
    })

    it("should return count of pending auths", async () => {
      await ensureCallbackServer()

      const promise1 = waitForCallback("state-1")
      assert.strictEqual(getPendingAuthCount(), 1)

      const promise2 = waitForCallback("state-2")
      assert.strictEqual(getPendingAuthCount(), 2)

      const promise3 = waitForCallback("state-3")
      assert.strictEqual(getPendingAuthCount(), 3)

      cancelPendingCallback("state-1")
      cancelPendingCallback("state-2")
      cancelPendingCallback("state-3")
      await assert.rejects(promise1, /Authorization cancelled/)
      await assert.rejects(promise2, /Authorization cancelled/)
      await assert.rejects(promise3, /Authorization cancelled/)
    })
  })
})
