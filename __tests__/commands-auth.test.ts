import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  removeAuth: vi.fn(),
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  authenticate: mocks.authenticate,
  removeAuth: mocks.removeAuth,
  supportsOAuth: (definition: { url?: string; auth?: string }) => Boolean(definition.url) && definition.auth !== "bearer",
}));

vi.mock("../init.ts", () => ({
  getFailureAgeSeconds: vi.fn(() => null),
  lazyConnect: vi.fn(),
  markKeepAliveAfterConnect: vi.fn(),
  updateMetadataCache: vi.fn(),
  updateStatusBar: vi.fn(),
}));

describe("authenticateServer", () => {
  it("does not open an empty auth panel for disabled-only OAuth config", async () => {
    const ui = { notify: vi.fn(), custom: vi.fn() };
    const { openMcpAuthPanel } = await import("../commands.ts");

    await openMcpAuthPanel({
      programmaticConfig: false,
      config: { mcpServers: { disabled: { url: "https://example.test/mcp", auth: "oauth", disabled: true } } },
    } as any, { getFlag: vi.fn() } as any, { hasUI: true, ui } as any);

    expect(ui.notify).toHaveBeenCalledWith("No OAuth-capable MCP servers are configured.", "warning");
    expect(ui.custom).not.toHaveBeenCalled();
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
      }, { hasUI: true, ui } as any);

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
      }, { hasUI: true, ui } as any);

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
    } as any, { hasUI: true, ui } as any);

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
    } as any, { hasUI: true, ui } as any);

    expect(result).toEqual({ ok: false, message: "close failed" });
    expect(ui.notify).toHaveBeenCalledWith(
      'OAuth credentials were cleared for "sentry", but its connection could not be closed: close failed',
      "error",
    );
  });

  it("surfaces the OAuth URL as one terminal hyperlink and accepts a pasted remote callback", async () => {
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
    }, { hasUI: true, ui } as any);

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
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(`\u001B]8;;${authorizationUrl}\u001B\\${authorizationUrl}\u001B]8;;\u001B\\`),
      "info",
    );
    expect(ui.confirm).toHaveBeenCalledWith(
      "Authorize sentry",
      expect.stringContaining(authorizationUrl),
      { signal: inputController.signal },
    );
    expect(ui.input).toHaveBeenCalledWith(
      "Complete sentry OAuth",
      "Paste the full callback URL",
      { signal: inputController.signal },
    );
    expect(ui.confirm.mock.invocationCallOrder[0]).toBeLessThan(ui.input.mock.invocationCallOrder[0]);
  });
});
