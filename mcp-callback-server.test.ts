/**
 * Tests for mcp-callback-server.ts - OAuth callback server
 */

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { createServer } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  stopCallbackServer,
  isCallbackServerRunning,
  getPendingAuthCount,
  releaseCallbackServer,
} from "./mcp-callback-server.ts"
import { getConfiguredOAuthCallbackPort, getOAuthCallbackPath, getOAuthCallbackPort } from "./mcp-oauth-provider.ts"

async function getFreePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "localhost", resolve)
  })
  const address = probe.address()
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a free test port")
  }
  return address.port
}

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

    it("should reserve callback state atomically with the initial bind", async () => {
      await ensureCallbackServer({ oauthState: "reserved-initial-state", reserveState: true })

      await assert.rejects(
        async () => await ensureCallbackServer({ callbackHost: "127.0.0.1" }),
        /cannot be switched while authorizations are pending/
      )

      releaseCallbackServer("reserved-initial-state")
    })

    it("should not switch callback hosts while callback state is reserved", async () => {
      await ensureCallbackServer({ oauthState: "reserved-host-state", reserveState: true })

      await assert.rejects(
        async () => await ensureCallbackServer({ callbackHost: "127.0.0.1" }),
        /cannot be switched while authorizations are pending/
      )

      releaseCallbackServer("reserved-host-state")
    })

    it("should not switch callback paths while callback state is reserved", async () => {
      await ensureCallbackServer({ callbackPath: "/first/callback", oauthState: "reserved-path-state", reserveState: true })

      await assert.rejects(
        async () => await ensureCallbackServer({ callbackPath: "/second/callback" }),
        /cannot be switched while authorizations are pending/
      )
      assert.strictEqual(getOAuthCallbackPath(), "/first/callback")

      releaseCallbackServer("reserved-path-state")
    })

    it("should release reserved callback state when strict binding fails", async () => {
      const port = await getFreePort()
      const blocker = createServer((_req, res) => {
        res.writeHead(200)
        res.end("blocked")
      })

      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject)
        blocker.listen(port, "localhost", resolve)
      })

      try {
        await assert.rejects(
          async () => await ensureCallbackServer({ strictPort: true, port, oauthState: "failed-bind-state", reserveState: true }),
          /already in use/
        )
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }

      await ensureCallbackServer({ callbackPath: "/after-failure" })
      await ensureCallbackServer({ callbackPath: "/after-failure-switch" })
      assert.strictEqual(getOAuthCallbackPath(), "/after-failure-switch")
    })

    it("should bind an explicit strict host, port, and custom callback path", async () => {
      const port = await getFreePort()

      await ensureCallbackServer({ strictPort: true, port, callbackHost: "127.0.0.1", callbackPath: "/custom/callback" })

      assert.strictEqual(getOAuthCallbackPort(), port)
      assert.strictEqual(getOAuthCallbackPath(), "/custom/callback")
      assert.strictEqual((await fetch(`http://127.0.0.1:${port}/callback?code=nope&state=custom-state`)).status, 404)

      const callbackPromise = waitForCallback("custom-state")
      const response = await fetch(`http://127.0.0.1:${port}/custom/callback?code=ok&state=custom-state`)
      assert.strictEqual(response.status, 200)
      assert.strictEqual((await callbackPromise).code, "ok")
    })

    it("should reject an occupied explicit strict port", async () => {
      const port = await getFreePort()
      const blocker = createServer((_req, res) => {
        res.writeHead(200)
        res.end("blocked")
      })

      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject)
        blocker.listen(port, "localhost", resolve)
      })

      try {
        await assert.rejects(
          async () => await ensureCallbackServer({ strictPort: true, port }),
          /already in use/
        )
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }
    })

    it("should use an OS-assigned port when the configured non-strict port is occupied", async () => {
      const configuredPort = getConfiguredOAuthCallbackPort()
      const blocker = createServer((_req, res) => {
        res.writeHead(200)
        res.end("blocked")
      })

      try {
        await new Promise<void>((resolve, reject) => {
          blocker.once("error", reject)
          blocker.listen(configuredPort, "localhost", resolve)
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return
        throw error
      }

      try {
        await ensureCallbackServer()
        const callbackPort = getOAuthCallbackPort()
        assert.notStrictEqual(callbackPort, configuredPort)

        const state = "occupied-port-state"
        const callbackPromise = waitForCallback(state)
        const response = await fetch(`http://localhost:${callbackPort}/callback?code=ok&state=${state}`)
        assert.strictEqual(response.status, 200)
        assert.strictEqual((await callbackPromise).code, "ok")

        await assert.rejects(
          async () => await ensureCallbackServer({ strictPort: true }),
          /already in use/
        )
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }
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
        `http://localhost:${callbackPort}/callback?code=${expectedCode}&state=${state}`
      )

      // Should get HTML success response
      assert.strictEqual(response.status, 200)
      const html = await response.text()
      assert.ok(html.includes("Authorization Successful"))

      // Callback promise should resolve
      const result = await callbackPromise
      assert.strictEqual(result.code, expectedCode)
      assert.strictEqual(result.iss, undefined)
    })

    it("should propagate the RFC 9207 iss parameter when present", async () => {
      await ensureCallbackServer()

      const state = "test-state-iss"
      const expectedCode = "auth-code-iss"
      const expectedIss = "https://auth.example.com"

      const callbackPromise = waitForCallback(state)

      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://localhost:${callbackPort}/callback?code=${expectedCode}&state=${state}&iss=${encodeURIComponent(expectedIss)}`
      )
      assert.strictEqual(response.status, 200)
      await response.text()

      const result = await callbackPromise
      assert.strictEqual(result.code, expectedCode)
      assert.strictEqual(result.iss, expectedIss)
    })

    it("should reject on error parameter", async () => {
      await ensureCallbackServer()

      const state = "test-state-error"
      const errorMsg = "access_denied"

      const callbackPromise = waitForCallback(state)
      const rejection = assert.rejects(callbackPromise, /access_denied/)

      // Simulate error callback
      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://localhost:${callbackPort}/callback?error=${errorMsg}&state=${state}`
      )

      assert.strictEqual(response.status, 200)
      const html = await response.text()
      assert.ok(html.includes("Authorization Failed"))

      // Callback promise should reject
      await rejection
    })

    it("should escape provider-controlled OAuth error details", async () => {
      await ensureCallbackServer()

      const state = "test-state-error-escaping"
      const callbackPromise = waitForCallback(state)
      const rejection = assert.rejects(callbackPromise, /<script>alert\("x"\)<\/script>&reason=bad/)
      const callbackPort = getOAuthCallbackPort()
      const description = `<script>alert("x")</script>&reason=bad`
      const response = await fetch(
        `http://localhost:${callbackPort}/callback?error=access_denied&error_description=${encodeURIComponent(description)}&state=${state}`
      )

      assert.strictEqual(response.status, 200)
      const html = await response.text()
      assert.ok(!html.includes("<script>"))
      assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;reason=bad"))
      await rejection
    })

    it("should not reflect OAuth error details for invalid state", async () => {
      await ensureCallbackServer()

      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://localhost:${callbackPort}/callback?error=access_denied&error_description=${encodeURIComponent("<script>bad()</script>")}&state=invalid-state`
      )

      assert.strictEqual(response.status, 400)
      const html = await response.text()
      assert.ok(html.includes("Invalid or expired state parameter"))
      assert.ok(!html.includes("<script>"))
      assert.ok(!html.includes("bad()"))
    })

    it("should return 400 for missing state", async () => {
      await ensureCallbackServer()

      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://localhost:${callbackPort}/callback?code=abc123`
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
        `http://localhost:${callbackPort}/callback?code=abc123&state=invalid-state`
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
        `http://localhost:${callbackPort}/callback?state=${state}`
      )

      assert.strictEqual(response.status, 400)
      const html = await response.text()
      assert.ok(html.includes("No authorization code provided"))

      cancelPendingCallback(state)
      await assert.rejects(pendingCallback, /Authorization cancelled/)
    })

    it("should not switch callback paths while callbacks are pending", async () => {
      await ensureCallbackServer({ callbackPath: "/first/callback" })

      const state = "pending-path-state"
      const callbackPromise = waitForCallback(state)

      await assert.rejects(
        async () => await ensureCallbackServer({ callbackPath: "/second/callback" }),
        /cannot be switched while authorizations are pending/
      )
      assert.strictEqual(getOAuthCallbackPath(), "/first/callback")

      cancelPendingCallback(state)
      await assert.rejects(callbackPromise, /Authorization cancelled/)
    })

    it("should return 404 for wrong path", async () => {
      await ensureCallbackServer()

      const callbackPort = getOAuthCallbackPort()
      const response = await fetch(
        `http://localhost:${callbackPort}/wrong/path`
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

describe("callback page branding", () => {
  const originalPackageDir = process.env.PI_PACKAGE_DIR
  const packageDirs: string[] = []

  function brandedPackageDir(name?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mcp-callback-brand-"))
    packageDirs.push(dir)
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(name ? { name: "pi", piConfig: { name } } : { name: "pi" }),
    )
    return dir
  }

  /** Drive a real callback request and read the HTML the browser would get. */
  async function fetchCallbackHtml(): Promise<string> {
    await ensureCallbackServer()
    const state = "brandingteststate"
    const pending = waitForCallback(state)
    const url = `http://localhost:${getOAuthCallbackPort()}${getOAuthCallbackPath()}?state=${state}&code=abc123`
    const response = await fetch(url)
    const html = await response.text()
    await pending
    return html
  }

  afterEach(async () => {
    if (originalPackageDir === undefined) delete process.env.PI_PACKAGE_DIR
    else process.env.PI_PACKAGE_DIR = originalPackageDir
    for (const dir of packageDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    await stopCallbackServer()
  })

  it("names the host app rather than hardcoding Pi", async () => {
    process.env.PI_PACKAGE_DIR = brandedPackageDir("arc")
    const html = await fetchCallbackHtml()
    assert.match(html, /return to <span class="app">arc<\/span>/)
    assert.match(html, /<title>arc — Authorization Successful<\/title>/)
    assert.doesNotMatch(html, /return to <span class="app">Pi<\/span>/)
  })

  it("falls back to pi when the host is not rebranded", async () => {
    process.env.PI_PACKAGE_DIR = brandedPackageDir()
    const html = await fetchCallbackHtml()
    assert.match(html, /return to <span class="app">pi<\/span>/)
  })

  it("serves a self-contained page — no external assets", async () => {
    delete process.env.PI_PACKAGE_DIR
    const html = await fetchCallbackHtml()
    assert.doesNotMatch(html, /https?:\/\//)
  })
})
