import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { getAuthForUrl, saveAuthEntry, updateOAuthState } from "../mcp-auth.ts";

describe("McpOAuthProvider authorization fallback", () => {
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  const serverUrl = "https://api.example.com/mcp";
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-provider-"));
    process.env.MCP_OAUTH_DIR = authDir;
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
  });

  it("throws UnauthorizedError when state is requested outside a user-initiated flow", async () => {
    const provider = new McpOAuthProvider("state-missing", serverUrl, {}, { onRedirect: async () => {} });

    await expect(provider.state()).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(provider.state()).rejects.toThrow(/Re-authentication required/);
  });

  it("throws UnauthorizedError before redirecting when no OAuth flow is in progress", async () => {
    let redirected = false;
    const provider = new McpOAuthProvider("redirect-missing", serverUrl, {}, {
      onRedirect: async () => {
        redirected = true;
      },
    });

    await expect(provider.redirectToAuthorization(new URL("https://auth.example.com/authorize")))
      .rejects.toBeInstanceOf(UnauthorizedError);
    expect(redirected).toBe(false);
  });

  it("still redirects when startAuth has seeded OAuth state", async () => {
    const authUrl = new URL("https://auth.example.com/authorize");
    let redirected: URL | undefined;
    updateOAuthState("redirect-active", "state-abc", serverUrl);
    const provider = new McpOAuthProvider("redirect-active", serverUrl, {}, {
      onRedirect: async (url) => {
        redirected = url;
      },
    });

    await provider.redirectToAuthorization(authUrl);

    expect(redirected).toBe(authUrl);
  });

  it("throws before redirecting when only stale URL-bound state exists", async () => {
    let redirected = false;
    saveAuthEntry("redirect-stale-url", {
      oauthState: "state-abc",
      serverUrl: "https://old.example.com/mcp",
    }, "https://old.example.com/mcp");
    const provider = new McpOAuthProvider("redirect-stale-url", serverUrl, {}, {
      onRedirect: async () => {
        redirected = true;
      },
    });

    await expect(provider.redirectToAuthorization(new URL("https://auth.example.com/authorize")))
      .rejects.toBeInstanceOf(UnauthorizedError);
    expect(redirected).toBe(false);
  });

  it("returns stored dynamic client information even when redirect URI metadata is stale", async () => {
    const provider = new McpOAuthProvider("client-redirect-stale", serverUrl, {}, {
      onRedirect: async () => {},
    });
    saveAuthEntry("client-redirect-stale", {
      clientInfo: {
        clientId: "registered-client",
        redirectUris: ["http://localhost:19877/callback"],
      },
      serverUrl,
    }, serverUrl);

    await expect(provider.clientInformation()).resolves.toEqual({
      client_id: "registered-client",
      client_secret: undefined,
    });
  });

  it("stores redirect URIs with dynamic client information", async () => {
    const provider = new McpOAuthProvider("client-redirect-store", serverUrl, {}, {
      onRedirect: async () => {},
    });

    await provider.saveClientInformation({
      client_id: "registered-client",
      redirect_uris: [provider.redirectUrl!],
    });

    expect(getAuthForUrl("client-redirect-store", serverUrl)?.clientInfo?.redirectUris)
      .toEqual([provider.redirectUrl]);
    await expect(provider.clientInformation()).resolves.toEqual({
      client_id: "registered-client",
      client_secret: undefined,
    });
  });
});
