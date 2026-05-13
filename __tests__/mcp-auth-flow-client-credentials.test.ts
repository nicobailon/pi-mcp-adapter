import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({
  ensureCallbackServer: vi.fn(),
  waitForCallback: vi.fn(),
  cancelPendingCallback: vi.fn(),
  stopCallbackServer: vi.fn(),
  open: vi.fn(),
  sdkAuth: vi.fn(),
  finishAuth: vi.fn(),
  transportClose: vi.fn(),
}));

class MockUnauthorizedError extends Error {}

class MockStreamableHTTPClientTransport {
  constructor(_url: URL, _options: unknown) {}

  close = mocks.transportClose;
  finishAuth = mocks.finishAuth;
}

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: mocks.sdkAuth,
  UnauthorizedError: MockUnauthorizedError,
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
}));

vi.mock("../mcp-callback-server.ts", () => ({
  ensureCallbackServer: mocks.ensureCallbackServer,
  waitForCallback: mocks.waitForCallback,
  cancelPendingCallback: mocks.cancelPendingCallback,
  stopCallbackServer: mocks.stopCallbackServer,
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
    mocks.open.mockReset();
    mocks.sdkAuth.mockReset().mockResolvedValue("AUTHORIZED");
    mocks.finishAuth.mockReset().mockResolvedValue(undefined);
    mocks.transportClose.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (originalOAuthDir === undefined) {
      delete process.env.MCP_OAUTH_DIR;
    } else {
      process.env.MCP_OAUTH_DIR = originalOAuthDir;
    }
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
    expect(mocks.transportClose).not.toHaveBeenCalled();
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

    updateClientInfo("expired", {
      clientId: "client",
      redirectUris: ["http://localhost:19876/callback"],
    }, "https://api.example.com/mcp");
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
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith({ strictPort: false });
    expect(getOAuthState("expired")).toBeUndefined();
  });

  it("re-registers instead of reusing stale dynamic client info during browser auth", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await expect(provider.clientInformation()).resolves.toBeUndefined();
      await expect(provider.tokens()).resolves.toBeUndefined();
      await provider.saveClientInformation({
        client_id: "fresh-client",
        client_secret: "fresh-secret",
        redirect_uris: [provider.redirectUrl],
      });
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");
    const { getAuthForUrl, getOAuthState, updateClientInfo, updateCodeVerifier, updateOAuthState, updateTokens } = await import("../mcp-auth.ts");

    updateClientInfo("expired-stale-redirect", {
      clientId: "old-client",
      redirectUris: ["http://localhost:19877/callback"],
    }, "https://api.example.com/mcp");
    updateTokens("expired-stale-redirect", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() / 1000 - 60,
    }, "https://api.example.com/mcp");
    updateCodeVerifier("expired-stale-redirect", "old-verifier", "https://api.example.com/mcp");
    updateOAuthState("expired-stale-redirect", "old-state", "https://api.example.com/mcp");

    const result = await startAuth("expired-stale-redirect", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    });

    const stored = getAuthForUrl("expired-stale-redirect", "https://api.example.com/mcp");
    expect(result.authorizationUrl).toBe("https://auth.example.com/authorize");
    expect(stored?.clientInfo?.clientId).toBe("fresh-client");
    expect(stored?.clientInfo?.redirectUris).toEqual(["http://localhost:19876/callback"]);
    expect(stored?.tokens).toBeUndefined();
    expect(stored?.codeVerifier).toBeUndefined();
    expect(getOAuthState("expired-stale-redirect")).not.toBe("old-state");
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

    updateClientInfo("refresh", {
      clientId: "client",
      redirectUris: ["http://localhost:19876/callback"],
    }, "https://api.example.com/mcp");
    updateTokens("refresh", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() / 1000 - 60,
    }, "https://api.example.com/mcp");

    const token = await getValidToken("refresh", "https://api.example.com/mcp");

    expect(token?.accessToken).toBe("new-access");
    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
  });

  it("refreshes expired tokens when the cached dynamic client has a stale redirect URI", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await expect(provider.clientInformation()).resolves.toEqual({
        client_id: "client",
        client_secret: undefined,
      });
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

    updateClientInfo("refresh-stale-redirect", {
      clientId: "client",
      redirectUris: ["http://localhost:19877/callback"],
    }, "https://api.example.com/mcp");
    updateTokens("refresh-stale-redirect", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() / 1000 - 60,
    }, "https://api.example.com/mcp");

    const token = await getValidToken("refresh-stale-redirect", "https://api.example.com/mcp");

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
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith({ strictPort: true });
  });

  it("cleans up pending auth when the browser cannot open", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    mocks.open.mockRejectedValueOnce(new Error("no browser"));
    const { authenticate } = await import("../mcp-auth-flow.ts");
    const { getOAuthState } = await import("../mcp-auth.ts");

    await expect(authenticate("browser-fail", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
    })).rejects.toThrow("Could not open browser");

    expect(mocks.cancelPendingCallback).toHaveBeenCalledTimes(1);
    expect(mocks.transportClose).toHaveBeenCalledTimes(1);
    expect(getOAuthState("browser-fail")).toBeUndefined();
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
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith({ strictPort: true });
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
    expect(mocks.ensureCallbackServer).toHaveBeenCalledWith({ strictPort: false });
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
