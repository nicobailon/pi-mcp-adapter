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
        { onAuthorizationUrl: expect.any(Function) },
      );
    } finally {
      if (originalUrl === undefined) delete process.env.MCP_AUTH_URL;
      else process.env.MCP_AUTH_URL = originalUrl;
    }
  });

  it("surfaces the exact OAuth URL through UI notification", async () => {
    const authorizationUrl = "https://auth.example.com/authorize?resource=https%3A%2F%2Fmcp.sentry.dev%2Fmcp";
    mocks.authenticate.mockImplementationOnce(async (_name, _url, _definition, options) => {
      await options.onAuthorizationUrl(authorizationUrl);
      return "authenticated";
    });
    const ui = { notify: vi.fn(), setStatus: vi.fn() };
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
      { onAuthorizationUrl: expect.any(Function) },
    );
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(authorizationUrl),
      "info",
    );
  });
});
