import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../mcp-callback-server.js", () => ({
  ensureCallbackServer: mocks.ensureCallbackServer,
  waitForCallback: mocks.waitForCallback,
  cancelPendingCallback: mocks.cancelPendingCallback,
  stopCallbackServer: mocks.stopCallbackServer,
}));

vi.mock("open", () => ({
  default: mocks.open,
}));

describe("mcp-auth-flow explicit auth", () => {
  beforeEach(() => {
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

    updateClientInfo("expired", { clientId: "client" }, "https://api.example.com/mcp");
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

    updateClientInfo("refresh", { clientId: "client" }, "https://api.example.com/mcp");
    updateTokens("refresh", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() / 1000 - 60,
    }, "https://api.example.com/mcp");

    const token = await getValidToken("refresh", "https://api.example.com/mcp");

    expect(token?.accessToken).toBe("new-access");
    expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
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
      oauth: { openMode: "browser" },
    })).rejects.toThrow("Could not open browser");

    expect(mocks.cancelPendingCallback).toHaveBeenCalledTimes(1);
    expect(mocks.transportClose).toHaveBeenCalledTimes(1);
    expect(getOAuthState("browser-fail")).toBeUndefined();
  });

  it("supports manual authorization URL presentation", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    mocks.waitForCallback.mockResolvedValueOnce("code");
    const { authenticate } = await import("../mcp-auth-flow.ts");
    const seenUrls: string[] = [];

    const status = await authenticate("manual", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: { openMode: "manual" },
    }, {
      onAuthorizationUrl: (url) => seenUrls.push(url),
    });

    expect(status).toBe("authenticated");
    expect(seenUrls).toEqual(["https://auth.example.com/authorize"]);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.finishAuth).toHaveBeenCalledWith("code");
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

  it("enforces strict callback port when configured for dynamic registration", async () => {
    mocks.sdkAuth.mockImplementationOnce(async (provider) => {
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      return "REDIRECT";
    });
    const { startAuth } = await import("../mcp-auth-flow.ts");

    const result = await startAuth("svc", "https://api.example.com/mcp", {
      url: "https://api.example.com/mcp",
      auth: "oauth",
      oauth: {
        strictCallbackPort: true,
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
