import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({
  ensureCallbackServer: vi.fn(),
  waitForCallback: vi.fn(),
  cancelPendingCallback: vi.fn(),
  stopCallbackServer: vi.fn(),
  reserveCallbackServer: vi.fn(),
  releaseCallbackServer: vi.fn(),
  open: vi.fn(),
  sdkAuth: vi.fn(),
  fetch: vi.fn(),
}));

class MockUnauthorizedError extends Error {}

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: mocks.sdkAuth,
  extractWWWAuthenticateParams: (response: Response) => {
    const header = response.headers.get("www-authenticate") ?? "";
    const resourceMetadata = /resource_metadata="([^"]+)"/.exec(header)?.[1];
    const scope = /scope="([^"]+)"/.exec(header)?.[1];
    return {
      ...(resourceMetadata ? { resourceMetadataUrl: new URL(resourceMetadata) } : {}),
      ...(scope ? { scope } : {}),
    };
  },
  UnauthorizedError: MockUnauthorizedError,
}));

vi.mock("../mcp-callback-server.ts", () => ({
  ensureCallbackServer: mocks.ensureCallbackServer,
  waitForCallback: mocks.waitForCallback,
  cancelPendingCallback: mocks.cancelPendingCallback,
  stopCallbackServer: mocks.stopCallbackServer,
  reserveCallbackServer: mocks.reserveCallbackServer,
  releaseCallbackServer: mocks.releaseCallbackServer,
}));

vi.mock("open", () => ({
  default: mocks.open,
}));

describe("mcp-auth-flow explicit auth", () => {
  const originalOAuthDir = process.env.MCP_OAUTH_DIR;
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), "pi-mcp-auth-flow-"));
    process.env.MCP_OAUTH_DIR = authDir;
    vi.resetModules();
    mocks.ensureCallbackServer.mockReset();
    mocks.waitForCallback.mockReset();
    mocks.cancelPendingCallback.mockReset();
    mocks.stopCallbackServer.mockReset();
    mocks.reserveCallbackServer.mockReset();
    mocks.releaseCallbackServer.mockReset();
    mocks.open.mockReset();
    mocks.sdkAuth.mockReset().mockResolvedValue("AUTHORIZED");
    mocks.fetch.mockReset().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(authDir, { recursive: true, force: true });
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
  });

  it("parses manual OAuth redirect URL and code input", async () => {
    const { parseAuthorizationCodeInput } = await import("../mcp-auth-flow.ts");

    expect(parseAuthorizationCodeInput(
      "http://localhost:19876/callback?code=abc123&state=state123",
      "state123",
    )).toBe("abc123");
    expect(parseAuthorizationCodeInput("code=abc123&state=state123", "state123")).toBe("abc123");
    expect(parseAuthorizationCodeInput(
      "http://localhost:19876/callback#code=abc123&state=state123",
      "state123",
    )).toBe("abc123");
    expect(parseAuthorizationCodeInput("abc123")).toBe("abc123");
  });

  it("rejects invalid manual OAuth redirect input", async () => {
    const { parseAuthorizationCodeInput } = await import("../mcp-auth-flow.ts");

    expect(() => parseAuthorizationCodeInput(
      "http://localhost:19876/callback?error=access_denied&error_description=Denied&state=state123",
      "state123",
    )).toThrow("access_denied: Denied");
    expect(() => parseAuthorizationCodeInput(
      "http://localhost:19876/callback?code=abc123",
      "state123",
    )).toThrow("state missing");
    expect(() => parseAuthorizationCodeInput(
      "http://localhost:19876/callback?code=abc123&state=wrong",
      "state123",
    )).toThrow("state mismatch");
  });

  it("does not start the callback server during OAuth initialization", async () => {
    const { initializeOAuth } = await import("../mcp-auth-flow.ts");

    await initializeOAuth();

    expect(mocks.ensureCallbackServer).not.toHaveBeenCalled();
  });

  it("authenticates client_credentials non-interactively without callback server or browser", async () => {
    const { authenticate } = await import("../mcp-auth-flow.ts");

    const status = await authenticate("svc", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: {
        grantType: "client_credentials",
        clientId: "service-client",
        clientSecret: "service-secret",
      },
    });

    expect(status).toBe("authenticated");
    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCallbackServer).not.toHaveBeenCalled();
    expect(mocks.waitForCallback).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("clears stale dynamic client info before client_credentials auth", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(await provider.clientInformation()).toBeUndefined();
      await provider.saveClientInformation({
        client_id: "fresh-service-client",
        client_secret: "fresh-service-secret",
      });
      await provider.saveTokens({
        access_token: "service-access",
        token_type: "Bearer",
        expires_in: 3600,
      });
      return "AUTHORIZED";
    });
    const { authenticate } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, updateClientInfo, updateCodeVerifier, updateOAuthState } = await import("../mcp-auth.ts");

    updateClientInfo("stale-client-credentials", { clientId: "stale-client" }, "https://api.example.com/mcp");
    updateCodeVerifier("stale-client-credentials", "stale-verifier");
    updateOAuthState("stale-client-credentials", "stale-state");

    const status = await authenticate("stale-client-credentials", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: { grantType: "client_credentials" },
    });

    expect(status).toBe("authenticated");
    const stored = getAuthForUrl("stale-client-credentials", "https://api.example.com/mcp");
    expect(stored?.clientInfo?.clientId).toBe("fresh-service-client");
    expect(stored?.tokens?.accessToken).toBe("service-access");
    expect(stored?.codeVerifier).toBeUndefined();
    expect(stored?.oauthState).toBeUndefined();
    expect(mocks.ensureCallbackServer).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent authentication attempts for the same server", async () => {
    const { authenticate } = await import("../mcp-auth-flow.ts");

    const [first, second] = await Promise.all([
      authenticate("svc", "https://api.example.com/mcp", {
        url: "https://api.example.com/mcp",
        auth: "oauth",
        oauth: {
          grantType: "client_credentials",
          clientId: "service-client",
          clientSecret: "service-secret",
        },
      }),
      authenticate("svc", "https://api.example.com/mcp", {
        url: "https://api.example.com/mcp",
        auth: "oauth",
        oauth: {
          grantType: "client_credentials",
          clientId: "service-client",
          clientSecret: "service-secret",
        },
      }),
    ]);

    expect(first).toBe("authenticated");
    expect(second).toBe("authenticated");
    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
  });

  it("runs SDK auth before reporting expired tokens as re-authenticated", async () => {
    const { authenticate } = await import("../mcp-auth-flow.ts");
    const { getOAuthState, updateClientInfo, updateTokens } = await import("../mcp-auth.ts");

    updateClientInfo("expired", { clientId: "client", redirectUris: ["http://localhost:19876/callback"] }, "https://api.example.com/mcp");
    updateTokens("expired", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() / 1000 - 60,
    }, "https://api.example.com/mcp");

    const status = await authenticate("expired", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    });

    expect(status).toBe("authenticated");
    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith(expect.objectContaining({
      strictPort: false,
      reserveState: true,
      oauthState: expect.any(String),
    }));
    expect(getOAuthState("expired")).toBeUndefined();
  });

  it("refreshes expired tokens through SDK auth before returning them", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.saveTokens({
        access_token: "new-access",
        token_type: "Bearer",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
      return "AUTHORIZED";
    });
    const { getValidToken } = await import("../mcp-auth-flow.ts");
    const { updateClientInfo, updateTokens } = await import("../mcp-auth.ts");

    updateClientInfo("refresh", { clientId: "client", redirectUris: ["http://localhost:19876/callback"] }, "https://api.example.com/mcp");
    updateTokens("refresh", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() / 1000 - 60,
    }, "https://api.example.com/mcp");

    const token = await getValidToken("refresh", "https://api.example.com/mcp");

    expect(token?.accessToken).toBe("new-access");
    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
  });

  it("re-registers dynamic OAuth clients when only stale client info is stored", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(await provider.clientInformation()).toBeUndefined();
      await provider.saveClientInformation({
        client_id: "fresh-client",
        client_secret: "fresh-secret",
      });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, getOAuthState, updateClientInfo, updateCodeVerifier, updateOAuthState } = await import("../mcp-auth.ts");

    updateClientInfo("stale", { clientId: "stale-client" }, "https://api.example.com/mcp");
    updateCodeVerifier("stale", "old-verifier");
    updateOAuthState("stale", "old-state");

    const result = await startAuth("stale", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    });

    expect(result.authorizationUrl).toBe("https://auth.example.com/authorize");
    const stored = getAuthForUrl("stale", "https://api.example.com/mcp");
    expect(stored?.clientInfo?.clientId).toBe("fresh-client");
    expect(stored?.codeVerifier).toBeUndefined();
    expect(getOAuthState("stale")).not.toBe("old-state");
  });

  it("keeps same-name pending OAuth flows isolated by auth storage", async () => {
    delete process.env.MCP_OAUTH_DIR;
    const projectA = mkdtempSync(join(tmpdir(), "pi-mcp-auth-flow-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "pi-mcp-auth-flow-b-"));
    const authStorageOptionsA = { baseDir: join(projectA, ".pi", "oauth") };
    const authStorageOptionsB = { baseDir: join(projectB, ".pi", "oauth") };
    let call = 0;
    mocks.sdkAuth.mockImplementation(async (provider) => {
      call++;
      if (call <= 2) {
        await provider.saveClientInformation({ client_id: `client-${call}` });
        await provider.redirectToAuthorization(new URL(`https://auth.example.com/authorize-${call}`));
        return "REDIRECT";
      }
      await provider.saveTokens({ access_token: "token-b", token_type: "Bearer" });
      return "AUTHORIZED";
    });
    const { startAuth, completeAuthFromInput, shutdownOAuth } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, getOAuthState } = await import("../mcp-auth.ts");

    await startAuth("shared", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    }, { authStorageOptions: authStorageOptionsA });
    await startAuth("shared", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    }, { authStorageOptions: authStorageOptionsB });

    expect(getOAuthState("shared", authStorageOptionsA)).toBeDefined();
    expect(getOAuthState("shared", authStorageOptionsB)).toBeDefined();

    await completeAuthFromInput("shared", "code-b", { authStorageOptions: authStorageOptionsB });

    expect(getAuthForUrl("shared", "https://api.example.com/mcp", authStorageOptionsA)?.tokens).toBeUndefined();
    expect(getAuthForUrl("shared", "https://api.example.com/mcp", authStorageOptionsB)?.tokens?.accessToken).toBe("token-b");
    await shutdownOAuth();
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("preserves stored dynamic client info when tokens exist", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(await provider.clientInformation()).toEqual({ client_id: "stored-client", client_secret: "stored-secret" });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, updateClientInfo, updateTokens } = await import("../mcp-auth.ts");

    updateClientInfo("tokened", {
      clientId: "stored-client",
      clientSecret: "stored-secret",
      redirectUris: ["http://localhost:19876/callback"],
    }, "https://api.example.com/mcp");
    updateTokens("tokened", { accessToken: "access", refreshToken: "refresh" }, "https://api.example.com/mcp");

    await startAuth("tokened", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    });

    expect(getAuthForUrl("tokened", "https://api.example.com/mcp")?.clientInfo?.clientId).toBe("stored-client");
  });

  it("does not return tokens from the previous URL after dynamic client info is saved for a new URL", async () => {
    const { getValidToken } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, updateClientInfo, updateTokens } = await import("../mcp-auth.ts");

    updateClientInfo("url-change", { clientId: "old-client" }, "https://old.example.com/mcp");
    updateTokens("url-change", { accessToken: "old-access", refreshToken: "old-refresh" }, "https://old.example.com/mcp");
    updateClientInfo("url-change", { clientId: "new-client" }, "https://new.example.com/mcp");

    await expect(getValidToken("url-change", "https://new.example.com/mcp")).resolves.toBeNull();
    expect(getAuthForUrl("url-change", "https://old.example.com/mcp")).toBeUndefined();
    expect(getAuthForUrl("url-change", "https://new.example.com/mcp")?.tokens).toBeUndefined();
  });

  it("re-registers dynamic OAuth clients when cached redirect URIs are stale", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(await provider.clientInformation()).toBeUndefined();
      await provider.saveClientInformation({
        client_id: "fresh-client",
        client_secret: "fresh-secret",
      });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, updateClientInfo, updateCodeVerifier, updateOAuthState, updateTokens } = await import("../mcp-auth.ts");

    updateClientInfo("stale-redirect", {
      clientId: "stale-client",
      clientSecret: "stale-secret",
      redirectUris: ["http://localhost:19876/callback"],
    }, "https://api.example.com/mcp");
    updateTokens("stale-redirect", { accessToken: "old-access", refreshToken: "old-refresh" }, "https://api.example.com/mcp");
    updateCodeVerifier("stale-redirect", "old-verifier");
    updateOAuthState("stale-redirect", "old-state");

    const result = await startAuth("stale-redirect", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: { redirectUri: "http://localhost:3118/callback" },
    });

    expect(result.authorizationUrl).toBe("https://auth.example.com/authorize");
    const stored = getAuthForUrl("stale-redirect", "https://api.example.com/mcp");
    expect(stored?.clientInfo?.clientId).toBe("fresh-client");
    expect(stored?.clientInfo?.redirectUris).toEqual(["http://localhost:3118/callback"]);
    expect(stored?.tokens).toBeUndefined();
    expect(stored?.codeVerifier).toBeUndefined();
    expect(stored?.oauthState).not.toBe("old-state");
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith(expect.objectContaining({
      strictPort: true,
      port: 3118,
      callbackHost: "localhost",
      callbackPath: "/callback",
      reserveState: true,
      oauthState: expect.any(String),
    }));
  });

  it("re-registers dynamic OAuth clients when cached redirect URI metadata is missing", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(await provider.clientInformation()).toBeUndefined();
      await provider.saveClientInformation({
        client_id: "fresh-client",
        client_secret: "fresh-secret",
      });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, updateClientInfo, updateTokens } = await import("../mcp-auth.ts");

    updateClientInfo("missing-redirect-metadata", {
      clientId: "legacy-client",
      clientSecret: "legacy-secret",
    }, "https://api.example.com/mcp");
    updateTokens("missing-redirect-metadata", { accessToken: "old-access", refreshToken: "old-refresh" }, "https://api.example.com/mcp");

    const result = await startAuth("missing-redirect-metadata", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    });

    expect(result.authorizationUrl).toBe("https://auth.example.com/authorize");
    const stored = getAuthForUrl("missing-redirect-metadata", "https://api.example.com/mcp");
    expect(stored?.clientInfo?.clientId).toBe("fresh-client");
    expect(stored?.clientInfo?.redirectUris).toEqual(["http://localhost:19876/callback"]);
    expect(stored?.tokens).toBeUndefined();
  });

  it("re-registers dynamic OAuth clients when cached redirect URI metadata is malformed", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(await provider.clientInformation()).toBeUndefined();
      await provider.saveClientInformation({
        client_id: "fresh-client",
        client_secret: "fresh-secret",
      });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, saveAuthEntry } = await import("../mcp-auth.ts");

    saveAuthEntry("malformed-redirect-metadata", {
      clientInfo: {
        clientId: "legacy-client",
        clientSecret: "legacy-secret",
        redirectUris: "http://localhost:19876/callback" as unknown as string[],
      },
      tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
    }, "https://api.example.com/mcp");

    const result = await startAuth("malformed-redirect-metadata", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    });

    expect(result.authorizationUrl).toBe("https://auth.example.com/authorize");
    const stored = getAuthForUrl("malformed-redirect-metadata", "https://api.example.com/mcp");
    expect(stored?.clientInfo?.clientId).toBe("fresh-client");
    expect(stored?.clientInfo?.redirectUris).toEqual(["http://localhost:19876/callback"]);
    expect(stored?.tokens).toBeUndefined();
  });

  it("refreshes expired tokens even when cached dynamic redirect URIs are stale", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(await provider.clientInformation()).toEqual({ client_id: "refresh-client", client_secret: "refresh-secret" });
      await provider.saveTokens({
        access_token: "new-access",
        token_type: "Bearer",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
      return "AUTHORIZED";
    });
    const { getValidToken } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, updateClientInfo, updateTokens } = await import("../mcp-auth.ts");

    updateClientInfo("refresh-stale-redirect", {
      clientId: "refresh-client",
      clientSecret: "refresh-secret",
      redirectUris: ["http://localhost:19876/callback"],
    }, "https://api.example.com/mcp");
    updateTokens("refresh-stale-redirect", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() / 1000 - 60,
    }, "https://api.example.com/mcp");

    const token = await getValidToken("refresh-stale-redirect", "https://api.example.com/mcp");

    expect(token?.accessToken).toBe("new-access");
    expect(getAuthForUrl("refresh-stale-redirect", "https://api.example.com/mcp")?.clientInfo?.clientId).toBe("refresh-client");
    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
  });

  it("preserves pre-registered OAuth client behavior", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(await provider.clientInformation()).toEqual({ client_id: "registered-client", client_secret: undefined });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, updateClientInfo } = await import("../mcp-auth.ts");

    updateClientInfo("registered", { clientId: "stored-dynamic-client" }, "https://api.example.com/mcp");

    await startAuth("registered", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: { clientId: "registered-client" },
    });

    expect(getAuthForUrl("registered", "https://api.example.com/mcp")?.clientInfo?.clientId).toBe("stored-dynamic-client");
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith(expect.objectContaining({
      strictPort: true,
      reserveState: true,
      oauthState: expect.any(String),
    }));
  });

  it("continues waiting for the OAuth callback when the browser cannot open", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    mocks.open.mockRejectedValueOnce(new Error("no browser"));
    mocks.waitForCallback.mockResolvedValueOnce("manual-code");
    const { authenticate } = await import("../mcp-auth-flow.ts");
    const { getOAuthState } = await import("../mcp-auth.ts");

    await expect(authenticate("browser-fail", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    })).resolves.toBe("authenticated");

    expect(mocks.sdkAuth).toHaveBeenNthCalledWith(2, expect.anything(), {
      serverUrl: "https://api.example.com/mcp",
      authorizationCode: "manual-code",
    });
    expect(mocks.cancelPendingCallback).not.toHaveBeenCalled();
    expect(getOAuthState("browser-fail")).toBeUndefined();
  });

  it("uses a custom authorization URL handler instead of raw console output", async () => {
    const authorizationUrl = "https://auth.example.com/authorize?resource=https%3A%2F%2Fmcp.sentry.dev%2Fmcp";
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL(authorizationUrl));
      return "REDIRECT";
    });
    mocks.waitForCallback.mockResolvedValueOnce("manual-code");
    const onAuthorizationUrl = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { authenticate } = await import("../mcp-auth-flow.ts");

    try {
      await expect(authenticate("ui-auth", "https://api.example.com/mcp", {
        url: "https://api.example.com/mcp",
        auth: "oauth",
      }, { onAuthorizationUrl })).resolves.toBe("authenticated");
    } finally {
      consoleLog.mockRestore();
    }

    expect(onAuthorizationUrl).toHaveBeenCalledWith(authorizationUrl);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith(authorizationUrl);
  });

  it("releases reserved callback state after direct completeAuth", async () => {
    const resourceMetadataUrl = "https://api.example.com/.well-known/oauth-protected-resource";
    mocks.fetch.mockResolvedValueOnce(new Response(null, {
      headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp:read"` },
    }));
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { completeAuth, startAuth } = await import("../mcp-auth-flow.ts");
    const { getOAuthState } = await import("../mcp-auth.ts");

    await startAuth("direct-complete", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      headers: { "X-Tenant": "tenant-a" },
    });
    const oauthState = getOAuthState("direct-complete");

    await expect(completeAuth("direct-complete", "auth-code")).resolves.toBe("authenticated");

    const probeInit = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(probeInit.headers).get("x-tenant")).toBe("tenant-a");
    expect(JSON.parse(String(probeInit.body)).params.clientInfo.name).toBe("pi-mcp-adapter");
    expect(mocks.sdkAuth).toHaveBeenNthCalledWith(1, expect.anything(), {
      serverUrl: "https://api.example.com/mcp",
      resourceMetadataUrl: new URL(resourceMetadataUrl),
      scope: "mcp:read",
    });
    expect(mocks.sdkAuth).toHaveBeenNthCalledWith(2, expect.anything(), {
      serverUrl: "https://api.example.com/mcp",
      authorizationCode: "auth-code",
      resourceMetadataUrl: new URL(resourceMetadataUrl),
      scope: "mcp:read",
    });
    expect(mocks.releaseCallbackServer).toHaveBeenCalledWith(oauthState);
    expect(getOAuthState("direct-complete")).toBeUndefined();
  });

  it("uses an explicit OAuth redirect URI for callback binding and metadata", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(provider.redirectUrl).toBe("http://127.0.0.1:3118/callback");
      expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:3118/callback"]);
      expect(provider.clientMetadata.client_name).toBe("Custom MCP");
      expect(provider.clientMetadata.client_uri).toBe("https://example.com/custom-mcp");
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");

    const result = await startAuth("explicit-redirect", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: {
        redirectUri: "http://127.0.0.1:3118/callback",
        clientName: "Custom MCP",
        clientUri: "https://example.com/custom-mcp",
      },
    });

    expect(result.authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith(expect.objectContaining({
      strictPort: true,
      port: 3118,
      callbackHost: "127.0.0.1",
      callbackPath: "/callback",
      reserveState: true,
      oauthState: expect.any(String),
    }));
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("enforces strict callback port for pre-registered OAuth clients", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");

    const result = await startAuth("svc", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: {
        clientId: "registered-client",
      },
    });

    expect(result.authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith(expect.objectContaining({
      strictPort: true,
      reserveState: true,
      oauthState: expect.any(String),
    }));
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("allows callback port fallback for dynamic registration", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");

    const result = await startAuth("svc", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    });

    expect(result.authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith(expect.objectContaining({
      strictPort: false,
      reserveState: true,
      oauthState: expect.any(String),
    }));
    expect(mocks.reserveCallbackServer).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
