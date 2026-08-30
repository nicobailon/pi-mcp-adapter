import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthEntryFilePath, resetTestAuthSecretStore, saveAuthEntry } from "../mcp-auth.ts";

type OAuthProviderLike = {
  redirectUrl?: string;
  tokens?: () => Promise<unknown>;
  clientMetadata?: {
    redirect_uris?: string[];
    client_name?: string;
    client_uri?: string;
  };
};

type ClientOptions = Record<string, unknown>;

type TransportOptions = {
  requestInit?: {
    headers?: Record<string, string>;
  };
  authProvider?: OAuthProviderLike;
  skipIssuerMetadataValidation?: boolean;
  fetch?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
};

type HttpTransportMock = {
  url: URL;
  options: TransportOptions;
  close: () => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  afterConnect: undefined as (() => void) | undefined,
  clients: [] as any[],
  connectErrors: [] as unknown[],
  httpTransports: [] as HttpTransportMock[],
  sseTransports: [] as HttpTransportMock[],
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation((info: unknown, options: ClientOptions) => {
    const client = {
      info,
      options,
      setRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      connect: vi.fn(async () => {
        const error = mocks.connectErrors.shift();
        if (error !== undefined) throw error;
        mocks.afterConnect?.();
      }),
      listTools: vi.fn(async () => ({ tools: [] })),
      listResources: vi.fn(async () => ({ resources: [] })),
      close: vi.fn(async () => undefined),
    };
    mocks.clients.push(client);
    return client;
  }),
  StreamableHTTPClientTransport: vi.fn().mockImplementation((url: URL, options: TransportOptions) => {
    const transport = { url, options, close: vi.fn(async () => undefined) };
    mocks.httpTransports.push(transport);
    return transport;
  }),
  SSEClientTransport: vi.fn().mockImplementation((url: URL, options: TransportOptions) => {
    const transport = { url, options, close: vi.fn(async () => undefined) };
    mocks.sseTransports.push(transport);
    return transport;
  }),
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager HTTP bearer auth", () => {
  const originalEnv = {
    MCP_TEST_BEARER_TOKEN: process.env.MCP_TEST_BEARER_TOKEN,
    MCP_TEST_BEARER_TOKEN_ENV: process.env.MCP_TEST_BEARER_TOKEN_ENV,
    MCP_TEST_URL: process.env.MCP_TEST_URL,
    MCP_OAUTH_DIR: process.env.MCP_OAUTH_DIR,
    PI_MCP_ADAPTER_TEST_AUTH_STORE: process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE,
  };

  beforeEach(() => {
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    resetTestAuthSecretStore();
    mocks.afterConnect = undefined;
    mocks.clients.length = 0;
    mocks.connectErrors.length = 0;
    mocks.httpTransports.length = 0;
    mocks.sseTransports.length = 0;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetTestAuthSecretStore();
  });



  it("interpolates ${VAR} URL placeholders", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_URL = "https://example.test/mcp";

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "${MCP_TEST_URL}",
    });

    expect(mocks.httpTransports.at(-1)!.url.href).toBe("https://example.test/mcp");
  });

  it("interpolates $env:VAR URL placeholders", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_URL = "https://example.test/mcp";

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "$env:MCP_TEST_URL",
    });

    expect(mocks.httpTransports.at(-1)!.url.href).toBe("https://example.test/mcp");
  });

  it("interpolates {env:VAR} URL and header placeholders", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_URL = "https://example.test/mcp";
    process.env.MCP_TEST_BEARER_TOKEN = "brace-token";

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "{env:MCP_TEST_URL}",
      headers: { Authorization: "Bearer {env:MCP_TEST_BEARER_TOKEN}" },
    });

    expect(mocks.httpTransports.at(-1)!.url.href).toBe("https://example.test/mcp");
    expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBe("Bearer brace-token");
  });

  it("fails closed when URL placeholders are missing", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    delete process.env.MCP_TEST_URL;

    const manager = new McpServerManager();
    await expect(manager.connect("remote", {
      url: "https://${MCP_TEST_URL}/mcp",
    })).rejects.toThrow("Missing environment variable in MCP server URL: MCP_TEST_URL");

    await expect(manager.connect("brace-remote", {
      url: "https://{env:MCP_TEST_URL}/mcp",
    })).rejects.toThrow("Missing environment variable in MCP server URL: MCP_TEST_URL");
    expect(mocks.httpTransports).toHaveLength(0);
  });

  it("interpolates ${VAR} bearerToken placeholders", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_BEARER_TOKEN = "placeholder-token";

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerToken: "${MCP_TEST_BEARER_TOKEN}",
    });

    expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBe("Bearer placeholder-token");
  });

  it("interpolates $env:VAR bearerToken placeholders", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_BEARER_TOKEN = "env-prefix-token";

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerToken: "$env:MCP_TEST_BEARER_TOKEN",
    });

    expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBe("Bearer env-prefix-token");
  });

  it("keeps bearerTokenEnv support", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_BEARER_TOKEN_ENV = "named-env-token";

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerTokenEnv: "MCP_TEST_BEARER_TOKEN_ENV",
    });

    expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBe("Bearer named-env-token");
  });

  it("uses an adapter-owned stored bearer token only when explicit sources are absent", async () => {
    const { resetTestBearerTokenStore, saveBearerTokenForUrl } = await import("../mcp-bearer-store.ts");
    const { McpServerManager } = await import("../server-manager.ts");
    resetTestBearerTokenStore();
    saveBearerTokenForUrl("remote", "stored-token", "https://example.test/mcp");

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerTokenStore: true,
    });

    expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBe("Bearer stored-token");
  });

  it("keeps literal and environment bearer tokens ahead of the stored token", async () => {
    const { resetTestBearerTokenStore, saveBearerTokenForUrl } = await import("../mcp-bearer-store.ts");
    const { McpServerManager } = await import("../server-manager.ts");
    resetTestBearerTokenStore();
    saveBearerTokenForUrl("literal", "stored-token", "https://example.test/mcp");
    saveBearerTokenForUrl("env", "stored-token", "https://example.test/mcp");
    process.env.MCP_TEST_BEARER_TOKEN_ENV = "env-token";

    const manager = new McpServerManager();
    await manager.connect("literal", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerToken: "literal-token",
      bearerTokenStore: true,
    });
    await manager.connect("env", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerTokenEnv: "MCP_TEST_BEARER_TOKEN_ENV",
      bearerTokenStore: true,
    });

    expect(mocks.httpTransports.at(-2)!.options.requestInit?.headers?.Authorization).toBe("Bearer literal-token");
    expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBe("Bearer env-token");
  });

  it("does not send Authorization when the stored bearer record is missing or URL-bound elsewhere", async () => {
    const { resetTestBearerTokenStore, saveBearerTokenForUrl } = await import("../mcp-bearer-store.ts");
    const { McpServerManager } = await import("../server-manager.ts");
    resetTestBearerTokenStore();
    saveBearerTokenForUrl("mismatch", "stored-token", "https://other.test/mcp");

    const manager = new McpServerManager();
    await manager.connect("missing", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerTokenStore: true,
    });
    await manager.connect("mismatch", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerTokenStore: true,
    });

    expect(mocks.httpTransports.at(-2)!.options.requestInit?.headers?.Authorization).toBeUndefined();
    expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.Authorization).toBeUndefined();
  });

  it("fails closed before transport when the bearer token store is unavailable", async () => {
    const { resetTestBearerTokenStore } = await import("../mcp-bearer-store.ts");
    const { McpServerManager } = await import("../server-manager.ts");
    resetTestBearerTokenStore();
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";

    const manager = new McpServerManager();
    await expect(manager.connect("remote", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerTokenStore: true,
    })).rejects.toThrow("Failed to read bearer token for remote");

    expect(mocks.httpTransports).toHaveLength(0);
  });

  it("uses configured headers without implicit OAuth", async () => {
    const { McpServerManager } = await import("../server-manager.ts");

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "https://example.test/mcp",
      headers: { "X-Goog-Api-Key": "api-key" },
    });

    expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers?.["X-Goog-Api-Key"]).toBe("api-key");
    expect(mocks.httpTransports.at(-1)!.options.authProvider).toBeUndefined();
  });

  it("uses URL-bound stored OAuth tokens before implicit authentication is challenged", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    saveAuthEntry("stored", { tokens: { accessToken: "stored-token" } }, "https://example.test/mcp");

    const manager = new McpServerManager();
    await manager.connect("stored", { url: "https://example.test/mcp" });

    const authProvider = mocks.httpTransports.at(-1)!.options.authProvider;
    expect(authProvider).toBeDefined();
    expect(await authProvider!.tokens?.()).toMatchObject({ access_token: "stored-token" });
  });

  it("keeps implicit OAuth deferred when the credential store is unavailable", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "unavailable";

    const manager = new McpServerManager();
    await manager.connect("anonymous", { url: "https://example.test/mcp" });

    expect(mocks.httpTransports.at(-1)!.options.authProvider).toBeUndefined();
  });

  it("keeps implicit OAuth deferred when stored credentials are malformed", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const authDir = mkdtempSync(join(tmpdir(), "pi-mcp-implicit-auth-"));
    const previousAuthDir = process.env.MCP_OAUTH_DIR;
    process.env.MCP_OAUTH_DIR = authDir;
    try {
      const filePath = getAuthEntryFilePath("malformed");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify({ tokens: { refreshToken: "missing-access-token" } }));

      const manager = new McpServerManager();
      await manager.connect("malformed", { url: "https://example.test/mcp" });

      expect(mocks.httpTransports.at(-1)!.options.authProvider).toBeUndefined();
    } finally {
      if (previousAuthDir === undefined) delete process.env.MCP_OAUTH_DIR;
      else process.env.MCP_OAUTH_DIR = previousAuthDir;
      rmSync(authDir, { recursive: true, force: true });
    }
  });

  it("passes the per-request header command fetch to Streamable HTTP and SSE", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.connectErrors.push(new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "POST is not supported",
      { status: 405 },
    ));

    const manager = new McpServerManager();
    await manager.connect("signed", {
      url: "https://example.test/mcp",
      requestHeadersCommand: { command: process.execPath, args: ["--version"] },
    });

    expect(mocks.httpTransports).toHaveLength(1);
    expect(mocks.sseTransports).toHaveLength(1);
    expect(mocks.httpTransports[0].options.fetch).toBeTypeOf("function");
    expect(mocks.sseTransports[0].options.fetch).toBe(mocks.httpTransports[0].options.fetch);
  });

  it("preserves OAuth redirect URI, client metadata, and issuer opt-out for HTTP transports", async () => {
    const { McpServerManager } = await import("../server-manager.ts");

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "https://example.test/mcp",
      auth: "oauth",
      oauth: {
        redirectUri: "http://127.0.0.1:3118/callback",
        clientName: "Custom MCP",
        clientUri: "https://example.com/custom-mcp",
        skipIssuerMetadataValidation: true,
      },
    });

    const authProvider = mocks.httpTransports.at(-1)!.options.authProvider;
    expect(authProvider?.redirectUrl).toBe("http://127.0.0.1:3118/callback");
    expect(authProvider?.clientMetadata?.redirect_uris).toEqual(["http://127.0.0.1:3118/callback"]);
    expect(authProvider?.clientMetadata?.client_name).toBe("Custom MCP");
    expect(authProvider?.clientMetadata?.client_uri).toBe("https://example.com/custom-mcp");
    expect(mocks.httpTransports.at(-1)!.options.skipIssuerMetadataValidation).toBe(true);
  });

  it("closes the HTTP transport when cancellation lands as connect resolves", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const controller = new AbortController();
    const reason = new Error("cancel after connect");
    mocks.afterConnect = () => controller.abort(reason);

    const manager = new McpServerManager();
    await expect(manager.connect("cancelled", {
      url: "https://example.test/mcp",
      auth: false,
    }, controller.signal)).rejects.toBe(reason);

    expect(mocks.clients).toHaveLength(1);
    expect(mocks.httpTransports[0].close).toHaveBeenCalledTimes(1);
  });

  it("falls back to SSE only for a definitive Streamable HTTP endpoint mismatch", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.connectErrors.push(new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "POST is not supported",
      { status: 405 },
    ));

    const manager = new McpServerManager();
    const connection = await manager.connect("legacy-sse", {
      url: "https://example.test/mcp",
    });

    expect(connection.status).toBe("connected");
    expect(mocks.httpTransports).toHaveLength(1);
    expect(mocks.sseTransports).toHaveLength(1);
    expect(mocks.clients).toHaveLength(2);
  });

  it.each([401, 403, 500])("does not fall back to SSE for HTTP %s", async status => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.connectErrors.push(new SdkHttpError(
      status === 401 ? SdkErrorCode.ClientHttpAuthentication : SdkErrorCode.ClientHttpNotImplemented,
      `HTTP ${status}`,
      { status },
    ));

    const manager = new McpServerManager();
    const pending = manager.connect(`http-${status}`, {
      url: "https://example.test/mcp",
      auth: false,
    });

    await expect(pending).rejects.toThrow(`HTTP ${status}`);
    expect(mocks.sseTransports).toHaveLength(0);
  });

  it("does not fall back to SSE when 2026-07-28 is pinned", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.connectErrors.push(new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "HTTP 405",
      { status: 405 },
    ));

    const manager = new McpServerManager();
    await expect(manager.connect("modern-pinned", {
      url: "https://example.test/mcp",
      auth: false,
      protocolVersion: "2026-07-28",
    })).rejects.toThrow("HTTP 405");
    expect(mocks.sseTransports).toHaveLength(0);
  });

  it("passes the configured protocol mode to the SDK client", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    await manager.connect("auto", {
      url: "https://example.test/mcp",
      protocolVersion: "auto",
    });
    await manager.connect("pin", {
      url: "https://example.test/mcp",
      protocolVersion: "2026-07-28",
    });

    expect(mocks.clients[0].options.versionNegotiation).toEqual({ mode: "auto" });
    expect(mocks.clients[1].options.versionNegotiation).toEqual({ mode: { pin: "2026-07-28" } });
  });

  it("applies the configured timeout to the HTTP connection", async () => {
    const { McpServerManager } = await import("../server-manager.ts");

    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);
    await manager.connect("remote", {
      url: "https://example.test/mcp",
      requestTimeoutMs: 5000,
    });

    expect(mocks.clients).toHaveLength(1);
    expect(mocks.httpTransports).toHaveLength(1);
    expect(mocks.clients[0].connect).toHaveBeenCalledWith(mocks.httpTransports[0], { timeout: 5000 });
  });
});
