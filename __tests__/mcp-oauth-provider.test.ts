import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { getAuthForUrl, saveAuthEntry } from "../mcp-auth.ts";

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

  it("does not mutate token request credentials after deactivation", async () => {
    const provider = new McpOAuthProvider(
      "auth-inactive",
      serverUrl,
      { clientId: "my-client", clientSecret: "my-secret", scope: "api://res/.default" },
      { onRedirect: async () => {} },
    );
    const headers = new Headers();
    const params = new URLSearchParams({ grant_type: "authorization_code" });
    provider.deactivate();

    await expect(provider.addClientAuthentication(headers, params, new URL("https://auth.example.com/token")))
      .rejects.toThrow("OAuth flow is no longer active");
    expect([...params.entries()]).toEqual([["grant_type", "authorization_code"]]);
    expect([...headers.entries()]).toEqual([]);
  });

  it("does not persist a pre-registered issuer stub after deactivation", async () => {
    const provider = new McpOAuthProvider(
      "inactive-client-info",
      serverUrl,
      { clientId: "my-client", clientSecret: "my-secret" },
      { onRedirect: async () => {} },
    );
    provider.deactivate();

    await expect(provider.saveClientInformation({
      client_id: "my-client",
      issuer: "https://auth.example.com",
    })).rejects.toThrow("OAuth flow is no longer active");

    const { getAuthForUrl } = await import("../mcp-auth.ts");
    expect(getAuthForUrl("inactive-client-info", serverUrl)).toBeUndefined();
  });
});

describe("McpOAuthProvider discovery state", () => {
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  const serverUrl = "https://api.example.com/mcp";
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-discovery-"));
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

  it("back-stamps legacy client information and tokens with the discovered issuer", async () => {
    saveAuthEntry("legacy-binding", {
      clientInfo: {
        clientId: "legacy-client",
        clientSecret: "legacy-secret",
        redirectUris: ["http://localhost:19876/callback"],
      },
      tokens: {
        accessToken: "legacy-access",
        refreshToken: "legacy-refresh",
      },
      serverUrl,
    }, serverUrl);
    const provider = new McpOAuthProvider(
      "legacy-binding",
      serverUrl,
      {},
      { onRedirect: async () => {} },
    );

    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
    });

    expect(await provider.clientInformation()).toMatchObject({
      client_id: "legacy-client",
      issuer: "https://auth.example.com",
    });
    expect(await provider.tokens()).toMatchObject({
      access_token: "legacy-access",
      issuer: "https://auth.example.com",
    });
    expect(getAuthForUrl("legacy-binding", serverUrl)).toMatchObject({
      clientInfo: { issuer: "https://auth.example.com" },
      tokens: { issuer: "https://auth.example.com" },
    });
  });

  it("rejects stored credentials when the issuer changes before refresh", async () => {
    saveAuthEntry("changed-issuer", {
      clientInfo: {
        clientId: "bound-client",
        clientSecret: "bound-secret",
        redirectUris: ["http://localhost:19876/callback"],
        issuer: "https://old-auth.example.com",
      },
      tokens: {
        accessToken: "bound-access",
        refreshToken: "bound-refresh",
        issuer: "https://old-auth.example.com",
      },
      serverUrl,
    }, serverUrl);
    const provider = new McpOAuthProvider(
      "changed-issuer",
      serverUrl,
      {},
      { onRedirect: async () => {} },
    );

    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://new-auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://new-auth.example.com",
        authorization_endpoint: "https://new-auth.example.com/authorize",
        token_endpoint: "https://new-auth.example.com/token",
        response_types_supported: ["code"],
      },
    });

    await expect(provider.clientInformation()).rejects.toThrow(
      "clear credentials before authenticating again",
    );
    await expect(provider.tokens()).rejects.toThrow(
      "clear credentials before authenticating again",
    );
  });

  it("does not stamp unbound tokens when client information has a different issuer", async () => {
    saveAuthEntry("partial-client-binding", {
      clientInfo: {
        clientId: "bound-client",
        clientSecret: "bound-secret",
        redirectUris: ["http://localhost:19876/callback"],
        issuer: "https://old-auth.example.com",
      },
      tokens: { accessToken: "legacy-access", refreshToken: "legacy-refresh" },
      serverUrl,
    }, serverUrl);
    const provider = new McpOAuthProvider(
      "partial-client-binding",
      serverUrl,
      {},
      { onRedirect: async () => {} },
    );
    await provider.saveDiscoveryState({ authorizationServerUrl: "https://new-auth.example.com" });

    await expect(provider.tokens()).rejects.toThrow("clear credentials before authenticating again");
    expect(getAuthForUrl("partial-client-binding", serverUrl)?.tokens?.issuer).toBeUndefined();
  });

  it("does not stamp unbound client information when tokens have a different issuer", async () => {
    saveAuthEntry("partial-token-binding", {
      clientInfo: {
        clientId: "legacy-client",
        clientSecret: "legacy-secret",
        redirectUris: ["http://localhost:19876/callback"],
      },
      tokens: {
        accessToken: "bound-access",
        refreshToken: "bound-refresh",
        issuer: "https://old-auth.example.com",
      },
      serverUrl,
    }, serverUrl);
    const provider = new McpOAuthProvider(
      "partial-token-binding",
      serverUrl,
      {},
      { onRedirect: async () => {} },
    );
    await provider.saveDiscoveryState({ authorizationServerUrl: "https://new-auth.example.com" });

    await expect(provider.clientInformation()).rejects.toThrow("clear credentials before authenticating again");
    expect(getAuthForUrl("partial-token-binding", serverUrl)?.clientInfo?.issuer).toBeUndefined();
  });

  it("persists a pre-registered issuer binding without the config secret", async () => {
    const provider = new McpOAuthProvider(
      "pre-registered-binding",
      serverUrl,
      { clientId: "config-client", clientSecret: "config-secret" },
      { onRedirect: async () => {} },
    );
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
    });

    expect(await provider.clientInformation()).toMatchObject({
      client_id: "config-client",
      client_secret: "config-secret",
      issuer: "https://auth.example.com",
    });
    expect(getAuthForUrl("pre-registered-binding", serverUrl)?.clientInfo).toEqual({
      clientId: "config-client",
      issuer: "https://auth.example.com",
      configPreRegistered: true,
    });
  });

  it("fails closed when a pre-registered client issuer changes", async () => {
    saveAuthEntry("pre-registered-issuer-change", {
      clientInfo: {
        clientId: "config-client",
        issuer: "https://old-auth.example.com",
        configPreRegistered: true,
      },
      serverUrl,
    }, serverUrl);
    const provider = new McpOAuthProvider(
      "pre-registered-issuer-change",
      serverUrl,
      { clientId: "config-client", clientSecret: "config-secret" },
      { onRedirect: async () => {} },
    );
    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://new-auth.example.com",
      authorizationServerMetadata: {
        issuer: "https://new-auth.example.com",
        authorization_endpoint: "https://new-auth.example.com/authorize",
        token_endpoint: "https://new-auth.example.com/token",
        response_types_supported: ["code"],
      },
    });

    await expect(provider.clientInformation()).rejects.toThrow(
      "clear credentials before authenticating again",
    );
    expect(getAuthForUrl("pre-registered-issuer-change", serverUrl)?.clientInfo?.issuer)
      .toBe("https://old-auth.example.com");
  });

  it("round-trips callback-leg discovery state and invalidates it independently", async () => {
    const provider = new McpOAuthProvider(
      "discovery-state",
      serverUrl,
      {},
      { onRedirect: async () => {} },
    );
    const discoveryState = {
      authorizationServerUrl: "https://auth.example.com",
      resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource/mcp",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        response_types_supported: ["code"],
      },
    };

    await provider.saveDiscoveryState(discoveryState);
    expect(await provider.discoveryState()).toEqual(discoveryState);

    const otherRuntimeProvider = new McpOAuthProvider(
      "discovery-state",
      serverUrl,
      {},
      { onRedirect: async () => {} },
    );
    expect(await otherRuntimeProvider.discoveryState()).toBeUndefined();

    await provider.saveTokens({
      access_token: "access-token",
      token_type: "Bearer",
      issuer: "https://auth.example.com",
    });
    expect(await provider.discoveryState()).toBeUndefined();

    await provider.saveDiscoveryState(discoveryState);
    await provider.invalidateCredentials("discovery");

    expect(await provider.discoveryState()).toBeUndefined();
    expect((await provider.tokens())?.access_token).toBe("access-token");
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

  it("redirects when the active provider owns OAuth state", async () => {
    const authUrl = new URL("https://auth.example.com/authorize");
    let redirected: URL | undefined;
    const provider = new McpOAuthProvider("redirect-active", serverUrl, {}, {
      onRedirect: async (url) => {
        redirected = url;
      },
    }, {}, undefined, "state-abc");

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
