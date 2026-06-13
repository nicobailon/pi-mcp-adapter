import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { saveAuthEntry, updateOAuthState } from "../mcp-auth.ts";

describe("McpOAuthProvider clientMetadata scope", () => {
  it("includes configured scope in authorization_code client metadata", () => {
    const provider = new McpOAuthProvider(
      "scope-test",
      "https://api.example.com/mcp",
      { scope: "api://resource/.default openid" },
      { onRedirect: async () => {} },
    );

    expect(provider.clientMetadata.scope).toBe("api://resource/.default openid");
  });

  it("omits scope from client metadata when not configured", () => {
    const provider = new McpOAuthProvider(
      "no-scope-test",
      "https://api.example.com/mcp",
      {},
      { onRedirect: async () => {} },
    );

    expect(provider.clientMetadata).not.toHaveProperty("scope");
  });
});

describe("McpOAuthProvider addClientAuthentication", () => {
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  const serverUrl = "https://api.example.com/mcp";
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-auth-"));
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

  it("adds configured scope to authorization_code token params", async () => {
    const provider = new McpOAuthProvider(
      "auth-scope",
      serverUrl,
      { clientId: "my-client", scope: "api://res/.default" },
      { onRedirect: async () => {} },
    );
    const params = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });

    await provider.addClientAuthentication(new Headers(), params, new URL("https://auth.example.com/token"));

    expect(params.get("scope")).toBe("api://res/.default");
    expect(params.get("client_id")).toBe("my-client");
  });

  it("uses client_secret_basic when the token endpoint only supports basic auth", async () => {
    const provider = new McpOAuthProvider(
      "auth-basic",
      serverUrl,
      { clientId: "my-client", clientSecret: "my-secret", scope: "api://res/.default" },
      { onRedirect: async () => {} },
    );
    const headers = new Headers();
    const params = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });

    await provider.addClientAuthentication(headers, params, new URL("https://auth.example.com/token"), {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });

    expect(headers.get("Authorization")).toBe(`Basic ${Buffer.from("my-client:my-secret").toString("base64")}`);
    expect(params.get("scope")).toBe("api://res/.default");
    expect(params.has("client_id")).toBe(false);
    expect(params.has("client_secret")).toBe(false);
  });

  it("uses client_secret_post when metadata is absent", async () => {
    const provider = new McpOAuthProvider(
      "auth-post",
      serverUrl,
      { clientId: "my-client", clientSecret: "my-secret" },
      { onRedirect: async () => {} },
    );
    const headers = new Headers();
    const params = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });

    await provider.addClientAuthentication(headers, params, new URL("https://auth.example.com/token"));

    expect(headers.has("Authorization")).toBe(false);
    expect(params.get("client_id")).toBe("my-client");
    expect(params.get("client_secret")).toBe("my-secret");
  });

  it("does not overwrite token params that are already present", async () => {
    const provider = new McpOAuthProvider(
      "auth-no-overwrite",
      serverUrl,
      { clientId: "my-client", clientSecret: "my-secret", scope: "api://res/.default" },
      { onRedirect: async () => {} },
    );
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      scope: "already-set",
      client_id: "already-set-id",
      client_secret: "already-set-secret",
    });

    await provider.addClientAuthentication(new Headers(), params, new URL("https://auth.example.com/token"));

    expect(params.get("scope")).toBe("already-set");
    expect(params.get("client_id")).toBe("already-set-id");
    expect(params.get("client_secret")).toBe("already-set-secret");
  });

  it("does not add scope to refresh token requests", async () => {
    const provider = new McpOAuthProvider(
      "auth-refresh",
      serverUrl,
      { clientId: "my-client", scope: "api://res/.default" },
      { onRedirect: async () => {} },
    );
    const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: "refresh" });

    await provider.addClientAuthentication(new Headers(), params, new URL("https://auth.example.com/token"));

    expect(params.has("scope")).toBe(false);
    expect(params.get("client_id")).toBe("my-client");
  });
});

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
});
