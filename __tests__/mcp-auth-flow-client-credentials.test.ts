import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({
  ensureCallbackServer: vi.fn(),
  waitForCallback: vi.fn(),
  cancelPendingCallback: vi.fn(),
  stopCallbackServer: vi.fn(),
  stopCallbackServerIfIdle: vi.fn(),
  reserveCallbackServer: vi.fn(),
  releaseCallbackServer: vi.fn(),
  open: vi.fn(),
  sdkAuth: vi.fn(),
  fetch: vi.fn(),
}));

class MockUnauthorizedError extends Error {}

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
  stopCallbackServerIfIdle: mocks.stopCallbackServerIfIdle,
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
    mocks.stopCallbackServerIfIdle.mockReset().mockResolvedValue(false);
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

  it("releases the idle callback server when startAuth is immediately authorized", async () => {
    const { startAuth } = await import("../mcp-auth-flow.ts");

    await expect(startAuth("cached", "https://api.example.com/mcp", { auth: "oauth" }))
      .resolves.toEqual({ authorizationUrl: "" });

    expect(mocks.releaseCallbackServer).toHaveBeenCalledOnce();
    expect(mocks.stopCallbackServerIfIdle).toHaveBeenCalledOnce();
  });

  it("releases the idle callback server when callback startup fails", async () => {
    mocks.ensureCallbackServer.mockRejectedValueOnce(new Error("callback bind failed"));
    const { startAuth } = await import("../mcp-auth-flow.ts");

    await expect(startAuth("bind-failure", "https://api.example.com/mcp", { auth: "oauth" }))
      .rejects.toThrow("callback bind failed");

    expect(mocks.releaseCallbackServer).toHaveBeenCalledOnce();
    expect(mocks.stopCallbackServerIfIdle).toHaveBeenCalledOnce();
    expect(mocks.sdkAuth).not.toHaveBeenCalled();
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

  it("passes the issuer metadata validation opt-out to SDK auth", async () => {
    const { startAuth } = await import("../mcp-auth-flow.ts");

    await startAuth("issuer-skip", "https://api.example.com/mcp", {
      auth: "oauth",
      oauth: { skipIssuerMetadataValidation: true },
    });

    expect(mocks.sdkAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverUrl: "https://api.example.com/mcp",
        skipIssuerMetadataValidation: true,
      }),
    );
  });

  it("keeps a pending flow when an advertised RFC 9207 issuer is missing", async () => {
    let oauthState = "";
    mocks.sdkAuth.mockImplementation(async (provider, options) => {
      if (options.authorizationCode) return "AUTHORIZED";
      oauthState = await provider.state();
      await provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
          authorization_response_iss_parameter_supported: true,
        },
      });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { completeAuthFromInput, hasPendingAuth, startAuth } = await import("../mcp-auth-flow.ts");

    await startAuth("rfc9207-missing", "https://api.example.com/mcp", { auth: "oauth" });
    await expect(completeAuthFromInput(
      "rfc9207-missing",
      `code=auth-code&state=${oauthState}`,
    )).rejects.toThrow('requires the RFC 9207 "iss" parameter');

    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
    expect(hasPendingAuth("rfc9207-missing")).toBe(true);

    await expect(completeAuthFromInput(
      "rfc9207-missing",
      `code=auth-code&state=${oauthState}&iss=${encodeURIComponent("https://auth.example.com")}`,
    )).resolves.toBe("authenticated");
    expect(mocks.sdkAuth).toHaveBeenCalledTimes(2);
    expect(mocks.sdkAuth).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        authorizationCode: "auth-code",
        iss: "https://auth.example.com",
      }),
    );
    expect(hasPendingAuth("rfc9207-missing")).toBe(false);
  });

  it("rejects a mismatched RFC 9207 issuer before token exchange", async () => {
    let oauthState = "";
    mocks.sdkAuth.mockImplementation(async (provider, options) => {
      if (options.authorizationCode) return "AUTHORIZED";
      oauthState = await provider.state();
      await provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
          authorization_response_iss_parameter_supported: true,
        },
      });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { completeAuthFromInput, hasPendingAuth, startAuth } = await import("../mcp-auth-flow.ts");

    await startAuth("rfc9207-mismatch", "https://api.example.com/mcp", { auth: "oauth" });
    await expect(completeAuthFromInput(
      "rfc9207-mismatch",
      `code=auth-code&state=${oauthState}&iss=${encodeURIComponent("https://attacker.example.com")}`,
    )).rejects.toThrow("does not match the discovered issuer");

    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
    expect(hasPendingAuth("rfc9207-mismatch")).toBe(false);
  });

  it("rejects a callback issuer mismatch when metadata is unavailable", async () => {
    let oauthState = "";
    mocks.sdkAuth.mockImplementation(async (provider, options) => {
      if (options.authorizationCode) return "AUTHORIZED";
      oauthState = await provider.state();
      await provider.saveDiscoveryState({
        authorizationServerUrl: "https://auth.example.com",
      });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { completeAuthFromInput, startAuth } = await import("../mcp-auth-flow.ts");

    await startAuth("issuer-without-metadata", "https://api.example.com/mcp", { auth: "oauth" });
    await expect(completeAuthFromInput(
      "issuer-without-metadata",
      `code=auth-code&state=${oauthState}&iss=${encodeURIComponent("https://attacker.example.com")}`,
    )).rejects.toThrow("does not match the discovered issuer");

    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
  });

  it("releases the idle callback server when stored-state cleanup fails", async () => {
    let oauthState = "";
    mocks.sdkAuth.mockImplementation(async (provider, options) => {
      if (options.authorizationCode) throw new Error("token exchange failed");
      oauthState = await provider.state();
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { completeAuthFromInput, startAuth } = await import("../mcp-auth-flow.ts");
    await startAuth("cleanup-storage-failure", "https://api.example.com/mcp", { auth: "oauth" });
    mocks.stopCallbackServerIfIdle.mockClear();
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";

    try {
      await expect(completeAuthFromInput(
        "cleanup-storage-failure",
        `code=auth-code&state=${oauthState}`,
      )).rejects.toThrow("OAuth completion cleanup failed");
    } finally {
      process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    }

    expect(mocks.cancelPendingCallback).toHaveBeenCalledWith(oauthState);
    expect(mocks.stopCallbackServerIfIdle).toHaveBeenCalledOnce();
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

  it("passes the issuer metadata validation opt-out during token refresh", async () => {
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

    updateClientInfo("refresh-skip-issuer", { clientId: "client", redirectUris: ["http://localhost:19876/callback"] }, "https://api.example.com/mcp");
    updateTokens("refresh-skip-issuer", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() / 1000 - 60,
    }, "https://api.example.com/mcp");

    await expect(getValidToken("refresh-skip-issuer", "https://api.example.com/mcp", {
      skipIssuerMetadataValidation: true,
    })).resolves.toMatchObject({ accessToken: "new-access" });
    expect(mocks.sdkAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skipIssuerMetadataValidation: true }),
    );
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

  it("keeps same-name pending OAuth flows isolated while sharing secure-store credentials by server name", async () => {
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
    const { createOAuthRuntime, startAuth, completeAuthFromInput, shutdownOAuth } = await import("../mcp-auth-flow.ts");
    const runtimeA = createOAuthRuntime();
    const runtimeB = createOAuthRuntime();
    const { getAuthForUrl, getOAuthState } = await import("../mcp-auth.ts");

    await startAuth("shared", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    }, { authStorageOptions: authStorageOptionsA, runtime: runtimeA });
    await startAuth("shared", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    }, { authStorageOptions: authStorageOptionsB, runtime: runtimeB });

    expect(getOAuthState("shared", authStorageOptionsA)).toBeUndefined();
    expect(getOAuthState("shared", authStorageOptionsB)).toBeUndefined();

    await completeAuthFromInput("shared", "code-b", { authStorageOptions: authStorageOptionsB, runtime: runtimeB });

    expect(getAuthForUrl("shared", "https://api.example.com/mcp", authStorageOptionsA)?.tokens?.accessToken).toBe("token-b");
    expect(getAuthForUrl("shared", "https://api.example.com/mcp", authStorageOptionsB)?.tokens?.accessToken).toBe("token-b");
    await shutdownOAuth(runtimeA);
    await shutdownOAuth(runtimeB);
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("preserves stored dynamic client info when tokens exist", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      expect(await provider.clientInformation()).toEqual({ client_id: "stored-client", client_secret: "stored-secret", redirect_uris: ["http://localhost:19876/callback"] });
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
      expect(await provider.clientInformation()).toEqual({ client_id: "refresh-client", client_secret: "refresh-secret", redirect_uris: ["http://localhost:19876/callback"] });
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
    expect(mocks.cancelPendingCallback).toHaveBeenCalledWith(mocks.waitForCallback.mock.calls[0][0]);
    expect(getOAuthState("browser-fail")).toBeUndefined();
  });

  it("completes from a pasted callback URL and clears the localhost waiter", async () => {
    let oauthState = "";
    mocks.sdkAuth
      .mockImplementationOnce(async (provider) => {
        oauthState = await provider.state();
        await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
        return "REDIRECT";
      })
      .mockImplementationOnce(async (_provider, options) => {
        expect(options).toEqual({
          serverUrl: "https://api.example.com/mcp",
          authorizationCode: "pasted-code",
        });
        return "AUTHORIZED";
      });
    mocks.waitForCallback.mockReturnValueOnce(new Promise(() => {}));
    mocks.open.mockResolvedValueOnce(undefined);
    const onAuthorizationInput = vi.fn(async () => (
      `http://localhost:19876/callback?code=pasted-code&state=${encodeURIComponent(oauthState)}`
    ));
    const { authenticate, hasPendingAuth } = await import("../mcp-auth-flow.ts");
    const { getOAuthState } = await import("../mcp-auth.ts");

    await expect(authenticate("remote-manual", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    }, { onAuthorizationInput })).resolves.toBe("authenticated");

    expect(onAuthorizationInput).toHaveBeenCalledWith(
      "https://auth.example.com/authorize",
      expect.any(AbortSignal),
    );
    expect(mocks.cancelPendingCallback).toHaveBeenCalledWith(oauthState);
    expect(hasPendingAuth("remote-manual")).toBe(false);
    expect(getOAuthState("remote-manual")).toBeUndefined();
  });

  it("clears a pending manual flow when cancellation happens after callback registration", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    mocks.waitForCallback.mockReturnValueOnce(new Promise<string>(() => {}));
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const { authenticate, hasPendingAuth } = await import("../mcp-auth-flow.ts");
    const { getOAuthState } = await import("../mcp-auth.ts");

    await expect(authenticate("cancel-manual", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    }, {
      signal: controller.signal,
      onAuthorizationUrl: () => controller.abort(reason),
    })).rejects.toBe(reason);

    expect(mocks.waitForCallback).toHaveBeenCalledTimes(1);
    expect(mocks.cancelPendingCallback).toHaveBeenCalledWith(expect.any(String));
    expect(hasPendingAuth("cancel-manual")).toBe(false);
    expect(getOAuthState("cancel-manual")).toBeUndefined();
  });

  it("blocks a detached SDK token write after authentication cancellation", async () => {
    let releaseTokenExchange!: () => void;
    const tokenExchange = new Promise<void>(resolve => {
      releaseTokenExchange = resolve;
    });
    let markTokenExchangeStarted!: () => void;
    const tokenExchangeStarted = new Promise<void>(resolve => {
      markTokenExchangeStarted = resolve;
    });
    mocks.sdkAuth
      .mockImplementationOnce(async (provider) => {
        await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
        return "REDIRECT";
      })
      .mockImplementationOnce(async (provider) => {
        markTokenExchangeStarted();
        await tokenExchange;
        await provider.saveTokens({ access_token: "late-token", token_type: "Bearer" });
        return "AUTHORIZED";
      });
    mocks.waitForCallback.mockResolvedValueOnce("manual-code");
    mocks.open.mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const { authenticate } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl } = await import("../mcp-auth.ts");

    const authentication = authenticate("cancel-token", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    }, { signal: controller.signal });
    await tokenExchangeStarted;
    controller.abort(reason);
    await expect(authentication).rejects.toBe(reason);

    releaseTokenExchange();
    await new Promise(resolve => setImmediate(resolve));
    expect(getAuthForUrl("cancel-token", "https://api.example.com/mcp")?.tokens).toBeUndefined();
  });

  it("adds configured authorization URL parameters", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?client_id=abc"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");

    const result = await startAuth("google", "https://gmailmcp.googleapis.com/mcp/v1", {
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      auth: "oauth",
      oauth: {
        authorizationParams: { access_type: "offline", prompt: "consent" },
      },
    });

    const url = new URL(result.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("abc");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("rejects authorization URL parameters that override the OAuth flow", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=flow-state"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");

    await expect(startAuth("bad-param", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: { authorizationParams: { state: "config-state" } },
    })).rejects.toThrow("OAuth authorizationParams.state cannot override an authorization flow parameter");
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

  it("reuses a pending manual OAuth flow instead of starting a new one", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?client_id=first"));
      return "REDIRECT";
    });
    const { hasPendingAuth, startAuth } = await import("../mcp-auth-flow.ts");

    const definition = {
      url: "https://api.example.com/mcp",
      auth: "oauth" as const,
    };
    const first = await startAuth("manual-repeat", "https://api.example.com/mcp", definition);
    const second = await startAuth("manual-repeat", "https://api.example.com/mcp", definition);

    expect(first.authorizationUrl).toBe("https://auth.example.com/authorize?client_id=first");
    expect(second).toEqual(first);
    expect(hasPendingAuth("manual-repeat")).toBe(true);
    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
  });

  it("isolates concurrent OAuth runtimes with the same server name and auth directory", async () => {
    const states: string[] = [];
    const verifiers: string[] = [];
    mocks.sdkAuth.mockImplementation(async (provider, options) => {
      if (options.authorizationCode) {
        verifiers.push(await provider.codeVerifier());
        return "AUTHORIZED";
      }
      const state = await provider.state();
      states.push(state);
      await provider.saveCodeVerifier(`verifier-${states.length}`);
      await provider.redirectToAuthorization(new URL(`https://auth.example.com/authorize?state=${state}`));
      return "REDIRECT";
    });
    const { completeAuthFromInput, createOAuthRuntime, hasPendingAuth, startAuth, shutdownOAuth } = await import("../mcp-auth-flow.ts");
    const runtimeA = createOAuthRuntime();
    const runtimeB = createOAuthRuntime();
    const definition = { auth: "oauth" as const };

    await startAuth("shared", "https://a.example.com/mcp", definition, { runtime: runtimeA });
    await startAuth("shared", "https://b.example.com/mcp", definition, { runtime: runtimeB });

    expect(states).toHaveLength(2);
    expect(states[0]).not.toBe(states[1]);
    expect(hasPendingAuth("shared", undefined, runtimeA)).toBe(true);
    expect(hasPendingAuth("shared", undefined, runtimeB)).toBe(true);

    await expect(completeAuthFromInput("shared", `code=code-a&state=${states[0]}`, { runtime: runtimeA })).resolves.toBe("authenticated");
    await expect(completeAuthFromInput("shared", `code=code-b&state=${states[1]}`, { runtime: runtimeB })).resolves.toBe("authenticated");
    expect(verifiers).toEqual(["verifier-1", "verifier-2"]);

    await shutdownOAuth(runtimeA);
    await shutdownOAuth(runtimeA);
    expect(hasPendingAuth("shared", undefined, runtimeA)).toBe(false);
    expect(mocks.stopCallbackServer).not.toHaveBeenCalled();

    await shutdownOAuth(runtimeB);
    expect(hasPendingAuth("shared", undefined, runtimeB)).toBe(false);
    expect(mocks.stopCallbackServer).toHaveBeenCalledTimes(1);
  });

  it("cancels only the stopped runtime's callback while another flow remains active", async () => {
    const states: string[] = [];
    mocks.sdkAuth.mockImplementation(async (provider, options) => {
      if (options.authorizationCode) return "AUTHORIZED";
      const state = await provider.state();
      states.push(state);
      await provider.saveCodeVerifier(`verifier-${states.length}`);
      await provider.redirectToAuthorization(new URL(`https://auth.example.com/authorize?state=${state}`));
      return "REDIRECT";
    });
    const { completeAuthFromInput, createOAuthRuntime, hasPendingAuth, startAuth, shutdownOAuth } = await import("../mcp-auth-flow.ts");
    const runtimeA = createOAuthRuntime();
    const runtimeB = createOAuthRuntime();
    const definition = { auth: "oauth" as const };

    await startAuth("shared", "https://a.example.com/mcp", definition, { runtime: runtimeA });
    await startAuth("shared", "https://b.example.com/mcp", definition, { runtime: runtimeB });
    await shutdownOAuth(runtimeA);

    expect(mocks.cancelPendingCallback).toHaveBeenCalledWith(states[0]);
    expect(hasPendingAuth("shared", undefined, runtimeB)).toBe(true);
    expect(mocks.stopCallbackServer).not.toHaveBeenCalled();
    await expect(completeAuthFromInput("shared", `code=code-b&state=${states[1]}`, { runtime: runtimeB })).resolves.toBe("authenticated");
    await shutdownOAuth(runtimeB);
  });

  it("does not reactivate a stopped runtime after a stale auth call", async () => {
    const { createOAuthRuntime, getAuthStatus, shutdownOAuth } = await import("../mcp-auth-flow.ts");
    const staleRuntime = createOAuthRuntime();
    await shutdownOAuth(staleRuntime);
    mocks.stopCallbackServer.mockClear();

    await expect(getAuthStatus("stale", { runtime: staleRuntime })).rejects.toThrow("OAuth runtime stopped");

    const liveRuntime = createOAuthRuntime();
    await shutdownOAuth(liveRuntime);
    expect(mocks.stopCallbackServer).toHaveBeenCalledTimes(1);
  });

  it("releases reserved callback state after direct completeAuth", async () => {
    const resourceMetadataUrl = "https://api.example.com/.well-known/oauth-protected-resource";
    mocks.fetch.mockResolvedValueOnce(new Response(null, {
      headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="mcp:read"` },
    }));
    let oauthState: string | undefined;
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      oauthState = await provider.state();
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
    expect(oauthState).toBeDefined();
    expect(getOAuthState("direct-complete")).toBeUndefined();

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
    expect(mocks.cancelPendingCallback).toHaveBeenCalledWith(oauthState);
    expect(getOAuthState("direct-complete")).toBeUndefined();
  });

  it("prefers a configured scope over discovery for start and completion", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, {
      headers: { "www-authenticate": 'Bearer scope="session:role:all"' },
    }));
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { completeAuth, startAuth } = await import("../mcp-auth-flow.ts");

    await startAuth("configured-scope", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: { scope: "session:role:MCP_ROLE" },
    });
    await expect(completeAuth("configured-scope", "auth-code")).resolves.toBe("authenticated");

    expect(mocks.sdkAuth).toHaveBeenNthCalledWith(1, expect.anything(), {
      serverUrl: "https://api.example.com/mcp",
      scope: "session:role:MCP_ROLE",
    });
    expect(mocks.sdkAuth).toHaveBeenNthCalledWith(2, expect.anything(), {
      serverUrl: "https://api.example.com/mcp",
      authorizationCode: "auth-code",
      scope: "session:role:MCP_ROLE",
    });
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
