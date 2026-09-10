import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  completeAuthFromInput: vi.fn(),
  getAuthStatus: vi.fn(),
  startAuth: vi.fn(),
  supportsOAuth: vi.fn(),
  lazyConnect: vi.fn(),
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  markKeepAliveAfterConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  updateStatusBar: vi.fn(),
  clearFailure: vi.fn(),
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: mocks.authenticate,
  completeAuthFromInput: mocks.completeAuthFromInput,
  getAuthStatus: mocks.getAuthStatus,
  startAuth: mocks.startAuth,
  supportsOAuth: mocks.supportsOAuth,
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  updateServerMetadata: mocks.updateServerMetadata,
  updateMetadataCache: mocks.updateMetadataCache,
  markKeepAliveAfterConnect: mocks.markKeepAliveAfterConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateStatusBar: mocks.updateStatusBar,
  clearFailure: mocks.clearFailure,
}));

function createState(overrides: Record<string, unknown> = {}) {
  const ownerController = new AbortController();
  return {
    config: {
      settings: {},
      mcpServers: {
        demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        bearer: { url: "https://api.example.com/mcp", auth: "bearer" },
      },
    },
    manager: { close: vi.fn(async () => {}) },
    owner: { signal: ownerController.signal, isActive: () => true },
    oauthRuntime: { signal: new AbortController().signal },
    authStorageOptions: {},
    openBrowser: vi.fn(async () => {}),
    sendMessage: vi.fn(),
    toolMetadata: new Map(),
    failureTracker: new Map([["demo", Date.now()]]),
    failureMessages: new Map([["demo", "stale failure"]]),
    ...overrides,
  } as any;
}

describe("manual OAuth proxy actions", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.authenticate.mockReset().mockImplementation(() => new Promise(() => {}));
    mocks.completeAuthFromInput.mockReset().mockResolvedValue("authenticated");
    mocks.getAuthStatus.mockReset().mockResolvedValue("not_authenticated");
    mocks.startAuth.mockReset().mockResolvedValue({
      authorizationUrl: "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A19876%2Fcallback",
    });
    mocks.supportsOAuth.mockReset().mockImplementation((definition) => definition.auth === "oauth");
    mocks.updateStatusBar.mockReset();
    mocks.clearFailure.mockReset().mockImplementation((state: any, serverName: string) => {
      state.failureTracker.delete(serverName);
      state.failureMessages?.delete(serverName);
    });
  });

  it("returns copyable instructions and authorization URL", async () => {
    const { executeAuthStart } = await import("../proxy-modes.ts");
    const state = createState();

    const result = await executeAuthStart(state, "demo");

    expect(mocks.startAuth).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
      { authStorageOptions: state.authStorageOptions, signal: state.owner.signal, runtime: state.oauthRuntime },
    );
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
      { authStorageOptions: state.authStorageOptions, runtime: state.oauthRuntime, openAuthorizationUrl: state.openBrowser },
    );
    expect(result.content[0].text).toContain("attempting to open this authorization URL");
    expect(result.content[0].text).toContain("watching for its callback");
    expect(result.content[0].text).toContain("https://auth.example.com/authorize");
    expect(result.content[0].text).toContain("auth-complete");
    expect(result.content[0].text).toContain('args: { redirectUrl: "PASTE_REDIRECT_URL_HERE" }');
    expect(result.content[0].text).toContain('args: { code: "PASTE_CODE_HERE" }');
    expect(result.content[0].text).toContain("JSON-string args remain supported");
    expect(result.details).toMatchObject({ mode: "auth-start", server: "demo" });
  });

  it("reports background callback completion and resets connection state", async () => {
    mocks.authenticate.mockResolvedValueOnce("authenticated");
    const { executeAuthStart } = await import("../proxy-modes.ts");
    const state = createState();

    await executeAuthStart(state, "demo");

    await vi.waitFor(() => expect(state.manager.close).toHaveBeenCalledWith("demo"));
    expect(state.failureTracker.has("demo")).toBe(false);
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(state);
    expect(state.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "mcp-oauth-status",
        details: expect.objectContaining({ server: "demo", status: "authenticated" }),
      }),
      { triggerTurn: true },
    );
  });

  it.each(["before-close", "during-close"])("does not publish background completion after owner cancellation %s", async (boundary) => {
    const controller = new AbortController();
    let finishAuth!: (status: string) => void;
    mocks.authenticate.mockImplementationOnce(() => new Promise<string>((resolve) => { finishAuth = resolve; }));
    const { executeAuthStart } = await import("../proxy-modes.ts");
    const state = createState({ owner: { signal: controller.signal } });
    if (boundary === "during-close") state.manager.close.mockImplementation(async () => { controller.abort(); });

    await executeAuthStart(state, "demo");
    if (boundary === "before-close") controller.abort();
    finishAuth("authenticated");
    await new Promise(resolve => setTimeout(resolve, 0));

    if (boundary === "before-close") expect(state.manager.close).not.toHaveBeenCalled();
    expect(mocks.clearFailure).not.toHaveBeenCalled();
    expect(mocks.updateStatusBar).not.toHaveBeenCalled();
    expect(state.sendMessage).not.toHaveBeenCalled();
  });

  it("does not publish failure when the owner stops during the credential recheck", async () => {
    const controller = new AbortController();
    mocks.authenticate.mockRejectedValueOnce(new Error("authentication failed"));
    mocks.getAuthStatus.mockImplementationOnce(async () => {
      controller.abort();
      return "not_authenticated";
    });
    const { executeAuthStart } = await import("../proxy-modes.ts");
    const state = createState({ owner: { signal: controller.signal } });
    await executeAuthStart(state, "demo");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.getAuthStatus).toHaveBeenCalled();
    expect(state.sendMessage).not.toHaveBeenCalled();
  });

  it("deduplicates repeated background callback watchers", async () => {
    const { executeAuthStart } = await import("../proxy-modes.ts");
    const state = createState();

    await executeAuthStart(state, "demo");
    await executeAuthStart(state, "demo");

    expect(mocks.startAuth).toHaveBeenCalledTimes(2);
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
  });

  it("explains manual completion for pre-registered HTTPS callbacks", async () => {
    mocks.startAuth.mockResolvedValueOnce({
      authorizationUrl: "https://auth.example.com/authorize?redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback",
    });
    const { executeAuthStart } = await import("../proxy-modes.ts");

    const state = createState();
    const result = await executeAuthStart(state, "demo");

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(state.openBrowser).toHaveBeenCalledWith(expect.stringContaining("https://auth.example.com/authorize"));
    expect(result.content[0].text).toContain("pre-registered HTTPS callback");
    expect(result.content[0].text).toContain("even if the destination page reports an error");
    expect(result.content[0].text).toContain("Remote HTTPS callbacks must include the full callback URL");
    expect(result.content[0].text).not.toContain('args: { code: "PASTE_CODE_HERE" }');
    expect(result.content[0].text).not.toContain("redirected localhost URL");
  });

  it("rejects auth-start for non-OAuth servers", async () => {
    const { executeAuthStart } = await import("../proxy-modes.ts");

    const result = await executeAuthStart(createState(), "bearer");

    expect(mocks.startAuth).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("not configured for OAuth");
    expect(result.details).toMatchObject({ error: "oauth_not_supported" });
  });

  it("completes auth from a copied redirect URL and resets connection state", async () => {
    const { executeAuthComplete } = await import("../proxy-modes.ts");
    const state = createState();

    const result = await executeAuthComplete(state, "demo", "http://localhost:19876/callback?code=abc&state=state");

    expect(mocks.completeAuthFromInput).toHaveBeenCalledWith(
      "demo",
      "http://localhost:19876/callback?code=abc&state=state",
      { authStorageOptions: state.authStorageOptions, signal: state.owner.signal, runtime: state.oauthRuntime },
    );
    expect(state.manager.close).toHaveBeenCalledWith("demo");
    expect(state.failureTracker.has("demo")).toBe(false);
    expect(mocks.updateStatusBar).toHaveBeenCalledWith(state);
    expect(result.content[0].text).toContain("OAuth authentication successful");
  });
});
