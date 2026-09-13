import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { openMcpAuthPanel, openMcpPanel } from "../commands.ts";
import type { createMcpPanel } from "../mcp-panel.ts";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  createMcpPanel: vi.fn(),
  removeAuth: vi.fn(),
}));

type PanelState = Parameters<typeof openMcpPanel>[0];
type PanelApi = Parameters<typeof openMcpPanel>[1];
type PanelContext = Parameters<typeof openMcpPanel>[2];
type CustomArgs = Parameters<ExtensionContext["ui"]["custom"]>;

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: mocks.authenticate,
  removeAuth: mocks.removeAuth,
  supportsOAuth: (definition: { url?: string; auth?: string }) => Boolean(definition.url) && definition.auth !== "bearer",
}));

vi.mock("../mcp-panel.ts", () => ({
  createMcpPanel: mocks.createMcpPanel,
}));

vi.mock("../init.ts", () => ({
  getFailureAgeSeconds: vi.fn(() => null),
  lazyConnect: vi.fn(),
  markKeepAliveAfterConnect: vi.fn(),
  updateMetadataCache: vi.fn(),
  updateStatusBar: vi.fn(),
}));

describe("authenticateServer", () => {
  const originalStore = process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;

  afterEach(() => {
    if (originalStore === undefined) delete process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE;
    else process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = originalStore;
  });

  it("does not open an empty auth panel for disabled-only OAuth config", async () => {
    const ui = { notify: vi.fn(), custom: vi.fn() };
    const { openMcpAuthPanel } = await import("../commands.ts");

    await openMcpAuthPanel({
      programmaticConfig: false,
      config: { mcpServers: { disabled: { url: "https://example.test/mcp", auth: "oauth", disabled: true } } },
    } as any, { getFlag: vi.fn() } as any, { hasUI: true, mode: "tui", ui } as any);

    expect(ui.notify).toHaveBeenCalledWith("No OAuth-capable MCP servers are configured.", "warning");
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it.each([
    ["openMcpPanel", "success"],
    ["openMcpAuthPanel", "success"],
    ["openMcpAuthPanel", "failure"],
  ] as const)("%s restores the hidden picker after OAuth %s", async (command, outcome) => {
    let finishAuthentication!: () => void;
    let markAuthenticationStarted!: () => void;
    const authenticationStarted = new Promise<void>((resolve) => { markAuthenticationStarted = resolve; });
    const hidden = vi.fn();
    const focus = vi.fn();
    mocks.authenticate.mockImplementationOnce(async () => {
      expect(hidden).toHaveBeenCalledWith(true);
      markAuthenticationStarted();
      await new Promise<void>((resolve) => { finishAuthentication = resolve; });
      if (outcome === "failure") throw new Error("authentication failed");
      return "authenticated";
    });
    mocks.createMcpPanel.mockImplementationOnce((...args: Parameters<typeof createMcpPanel>) => {
      const callbacks = args[3];
      const done = args[5];
      return {
        render: () => [],
        invalidate: () => {},
        handleInput: () => {
          void callbacks.authenticate("sentry").then(() => done({ cancelled: true, changes: new Map() }));
        },
      };
    });
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      custom: vi.fn((factory: CustomArgs[0], options: NonNullable<CustomArgs[1]>) => {
        const panel = factory({ requestRender: vi.fn() }, undefined, undefined, vi.fn());
        options.onHandle?.({ setHidden: hidden, focus } as OverlayHandle);
        panel.handleInput("\r");
      }),
    };
    const commands = await import("../commands.ts");
    const state = {
      programmaticConfig: false,
      config: { mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" } } },
      authStorageOptions: {},
      manager: { getConnection: () => undefined },
      failureTracker: new Map(),
      failureMessages: new Map(),
    } as PanelState;
    const pi = { getFlag: vi.fn() } as PanelApi;
    const ctx = { hasUI: true, mode: "tui", cwd: "/tmp", ui } as PanelContext;

    const panel = command === "openMcpPanel"
      ? commands.openMcpPanel(state, pi, ctx)
      : commands.openMcpAuthPanel(state, pi, ctx);

    await authenticationStarted;
    finishAuthentication();
    await panel;

    expect(hidden.mock.calls).toEqual([[true], [false]]);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("interpolates the server URL before OAuth authentication", async () => {
    const originalUrl = process.env.MCP_AUTH_URL;
    process.env.MCP_AUTH_URL = "https://mcp.sentry.dev/mcp";
    mocks.authenticate.mockResolvedValueOnce("authenticated");
    const ui = { notify: vi.fn(), setStatus: vi.fn() };
    const { authenticateServer } = await import("../commands.ts");

    try {
      const definition = { url: "${MCP_AUTH_URL}", auth: "oauth" as const };
      const result = await authenticateServer("sentry", {
        mcpServers: { sentry: definition },
      }, { hasUI: true, mode: "tui", ui } as any);

      expect(result.ok).toBe(true);
      expect(mocks.authenticate).toHaveBeenCalledWith(
        "sentry",
        "https://mcp.sentry.dev/mcp",
        definition,
        {
          onAuthorizationUrl: expect.any(Function),
          onAuthorizationInput: expect.any(Function),
        },
      );
    } finally {
      if (originalUrl === undefined) delete process.env.MCP_AUTH_URL;
      else process.env.MCP_AUTH_URL = originalUrl;
    }
  });

  it("fails OAuth authentication before requests when URL variables are missing", async () => {
    const originalUrl = process.env.MCP_AUTH_URL;
    delete process.env.MCP_AUTH_URL;
    mocks.authenticate.mockClear();
    const ui = { notify: vi.fn(), setStatus: vi.fn() };
    const { authenticateServer } = await import("../commands.ts");

    try {
      const result = await authenticateServer("sentry", {
        mcpServers: { sentry: { url: "https://${MCP_AUTH_URL}/mcp", auth: "oauth" } },
      }, { hasUI: true, mode: "tui", ui } as any);

      expect(result.ok).toBe(false);
      expect(result.message).toBe("Missing environment variable in MCP server URL: MCP_AUTH_URL");
      expect(mocks.authenticate).not.toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(
        'Failed to authenticate "sentry": Missing environment variable in MCP server URL: MCP_AUTH_URL',
        "error",
      );
    } finally {
      if (originalUrl === undefined) delete process.env.MCP_AUTH_URL;
      else process.env.MCP_AUTH_URL = originalUrl;
    }
  });

  it("reports credential removal failures without escaping the logout command boundary", async () => {
    mocks.removeAuth.mockRejectedValueOnce(new Error("simulated secure credential store unavailable"));
    const ui = { notify: vi.fn() };
    const { logoutServer } = await import("../commands.ts");

    const close = vi.fn();
    const result = await logoutServer("sentry", {
      config: { mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" } } },
      authStorageOptions: {},
      manager: { close },
    } as any, { hasUI: true, mode: "tui", ui } as any);

    expect(result).toEqual({ ok: false, message: "simulated secure credential store unavailable" });
    expect(close).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      'Failed to clear OAuth credentials for "sentry": simulated secure credential store unavailable',
      "error",
    );
  });

  it("reports a close failure accurately after credentials were removed", async () => {
    mocks.removeAuth.mockResolvedValueOnce(undefined);
    const ui = { notify: vi.fn() };
    const { logoutServer } = await import("../commands.ts");

    const result = await logoutServer("sentry", {
      config: { mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" } } },
      authStorageOptions: {},
      manager: { close: vi.fn(async () => { throw new Error("close failed"); }) },
    } as any, { hasUI: true, mode: "tui", ui } as any);

    expect(result).toEqual({ ok: false, message: "close failed" });
    expect(ui.notify).toHaveBeenCalledWith(
      'OAuth credentials were cleared for "sentry", but its connection could not be closed: close failed',
      "error",
    );
  });

  it("puts the OAuth link in the paste prompt without a confirmation", async () => {
    const authorizationUrl = "https://auth.example.com/authorize?resource=https%3A%2F%2Fmcp.sentry.dev%2Fmcp";
    const callbackUrl = "http://localhost:3118/callback?code=code&state=state";
    const inputController = new AbortController();
    mocks.authenticate.mockImplementationOnce(async (_name, _url, _definition, options) => {
      await options.onAuthorizationUrl(authorizationUrl);
      const input = await options.onAuthorizationInput(authorizationUrl, inputController.signal);
      expect(input).toBe(callbackUrl);
      return "authenticated";
    });
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => callbackUrl),
    };
    const { authenticateServer } = await import("../commands.ts");

    const result = await authenticateServer("sentry", {
      mcpServers: {
        sentry: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
      },
    }, { hasUI: true, mode: "tui", ui } as any);

    expect(result.ok).toBe(true);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      "sentry",
      "https://mcp.sentry.dev/mcp",
      { url: "https://mcp.sentry.dev/mcp", auth: "oauth" },
      {
        onAuthorizationUrl: expect.any(Function),
        onAuthorizationInput: expect.any(Function),
      },
    );
    expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining(authorizationUrl), "info");
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.input).toHaveBeenCalledWith(
      expect.stringContaining(
        `\u001B]8;;${authorizationUrl}\u001B\\Open authorization page\u001B]8;;\u001B\\\n${authorizationUrl}`,
      ),
      undefined,
      { signal: inputController.signal },
    );
  });

  it("does not open paste input when authorization was already cancelled", async () => {
    const inputController = new AbortController();
    inputController.abort();
    mocks.authenticate.mockImplementationOnce(async (_name, _url, _definition, options) => {
      expect(await options.onAuthorizationInput("https://auth.example.com/authorize", inputController.signal)).toBeUndefined();
      return "cancelled";
    });
    const ui = { notify: vi.fn(), setStatus: vi.fn(), confirm: vi.fn(), input: vi.fn() };
    const { authenticateServer } = await import("../commands.ts");

    await authenticateServer("sentry", {
      mcpServers: { sentry: { url: "https://mcp.sentry.dev/mcp", auth: "oauth" } },
    }, { hasUI: true, mode: "tui", ui } as any);

    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("blocks bearer token set because the extension UI has no masked secret input", async () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    const ui = { notify: vi.fn(), input: vi.fn() };
    const { manageBearerToken } = await import("../commands.ts");

    const result = await manageBearerToken("set", "remote", {
      config: { mcpServers: { remote: { url: "https://example.test/mcp", auth: "bearer", bearerTokenStore: true } } },
    } as any, { hasUI: true, mode: "tui", ui } as any);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("no masked secret input primitive");
    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("no masked secret input primitive"), "error");
  });

  it("redacts unresolvable server URLs from token command errors", async () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    delete process.env.PI_MCP_TEST_UNSET_SECRET;
    const ui = { notify: vi.fn() };
    const { manageBearerToken } = await import("../commands.ts");

    const result = await manageBearerToken("status", "remote", {
      config: { mcpServers: { remote: { url: "https://user:${PI_MCP_TEST_UNSET_SECRET}@example.test/mcp", auth: "bearer", bearerTokenStore: true } } },
    } as any, { hasUI: true, mode: "tui", ui } as any);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid or unresolvable URL");
    expect(result.message).not.toContain("example.test");
  });

  it("reports stored bearer token status without exposing the token", async () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    const { resetTestBearerTokenStore, saveBearerTokenForUrl } = await import("../mcp-bearer-store.ts");
    resetTestBearerTokenStore();
    saveBearerTokenForUrl("remote", "secret-token", "https://example.test/mcp");
    const ui = { notify: vi.fn() };
    const { manageBearerToken } = await import("../commands.ts");

    const result = await manageBearerToken("status", "remote", {
      config: { mcpServers: { remote: { url: "https://example.test/mcp", auth: "bearer", bearerTokenStore: true } } },
    } as any, { hasUI: true, mode: "tui", ui } as any);

    expect(result).toEqual({ ok: true, message: 'Bearer token is stored for "remote".' });
    expect(result.message).not.toContain("secret-token");
    expect(ui.notify).toHaveBeenCalledWith('Bearer token is stored for "remote".', "info");
  });

  it("removes stored bearer tokens without exposing the token", async () => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    const { getBearerTokenForUrl, resetTestBearerTokenStore, saveBearerTokenForUrl } = await import("../mcp-bearer-store.ts");
    resetTestBearerTokenStore();
    saveBearerTokenForUrl("remote", "secret-token", "https://example.test/mcp");
    const ui = { notify: vi.fn() };
    const { manageBearerToken } = await import("../commands.ts");

    const result = await manageBearerToken("remove", "remote", {
      config: { mcpServers: { remote: { url: "https://example.test/mcp", auth: "bearer", bearerTokenStore: true } } },
    } as any, { hasUI: true, mode: "tui", ui } as any);

    expect(result).toEqual({ ok: true, message: 'Bearer token removed for "remote".' });
    expect(getBearerTokenForUrl("remote", "https://example.test/mcp")).toBeUndefined();
    expect(result.message).not.toContain("secret-token");
  });
});
