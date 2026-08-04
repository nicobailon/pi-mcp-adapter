import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OAuthProviderLike = {
  redirectUrl?: string;
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
  };

  beforeEach(() => {
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

  it("preserves OAuth redirect URI and client metadata for HTTP transports", async () => {
    const { McpServerManager } = await import("../server-manager.ts");

    const manager = new McpServerManager();
    await manager.connect("remote", {
      url: "https://example.test/mcp",
      auth: "oauth",
      oauth: {
        redirectUri: "http://127.0.0.1:3118/callback",
        clientName: "Custom MCP",
        clientUri: "https://example.com/custom-mcp",
      },
    });

    const authProvider = mocks.httpTransports.at(-1)!.options.authProvider;
    expect(authProvider?.redirectUrl).toBe("http://127.0.0.1:3118/callback");
    expect(authProvider?.clientMetadata?.redirect_uris).toEqual(["http://127.0.0.1:3118/callback"]);
    expect(authProvider?.clientMetadata?.client_name).toBe("Custom MCP");
    expect(authProvider?.clientMetadata?.client_uri).toBe("https://example.com/custom-mcp");
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
