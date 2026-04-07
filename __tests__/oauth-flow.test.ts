import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCallbackServer, openBrowser } from "../oauth-flow.js";

describe("startCallbackServer", () => {
  it("binds an ephemeral port on 127.0.0.1 and exposes a /callback URI", async () => {
    const server = await startCallbackServer();
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
    } finally {
      server.close();
    }
  });

  it("resolves waitForCode() when the OAuth provider redirects with ?code=", async () => {
    const server = await startCallbackServer();
    try {
      const codePromise = server.waitForCode(2000);
      // Simulate the user agent landing on the redirect URI.
      const res = await fetch(`${server.redirectUri}?code=auth-code-1&state=xyz`);
      expect(res.ok).toBe(true);
      const result = await codePromise;
      expect(result.code).toBe("auth-code-1");
      expect(result.state).toBe("xyz");
    } finally {
      server.close();
    }
  });

  it("rejects waitForCode() when the OAuth provider redirects with ?error=", async () => {
    const server = await startCallbackServer();
    try {
      const codePromise = server.waitForCode(2000);
      const res = await fetch(
        `${server.redirectUri}?error=access_denied&error_description=user%20said%20no`,
      );
      expect(res.status).toBe(400);
      await expect(codePromise).rejects.toThrow(/access_denied/);
    } finally {
      server.close();
    }
  });

  it("rejects waitForCode() when no code arrives before the timeout", async () => {
    const server = await startCallbackServer();
    try {
      await expect(server.waitForCode(50)).rejects.toThrow(/timed out/);
    } finally {
      server.close();
    }
  });

  it("returns 404 for non-callback paths", async () => {
    const server = await startCallbackServer();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/not-a-callback`);
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("close() is idempotent", async () => {
    const server = await startCallbackServer();
    server.close();
    expect(() => server.close()).not.toThrow();
  });
});

describe("openBrowser", () => {
  const originalEnv = process.env.PI_MCP_BROWSER;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PI_MCP_BROWSER;
    } else {
      process.env.PI_MCP_BROWSER = originalEnv;
    }
  });

  it("is a no-op when PI_MCP_BROWSER=none (headless override)", async () => {
    process.env.PI_MCP_BROWSER = "none";
    // Should resolve without spawning anything; if it tried to spawn a real
    // browser, this test would either hang or have side effects.
    await expect(openBrowser("https://example.com/authorize")).resolves.toBeUndefined();
  });

  it("does not throw when PI_MCP_BROWSER points at a missing binary", async () => {
    // Spawn errors are intentionally swallowed so a misconfigured opener never
    // crashes the connect path. The OAuth flow still gets the URL via the log line.
    process.env.PI_MCP_BROWSER = "definitely-not-a-real-binary-xyz";
    await expect(openBrowser("https://example.com/authorize")).resolves.toBeUndefined();
  });
});
