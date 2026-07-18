import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type OAuthProviderLike = {
  redirectUrl?: string;
  clientMetadata?: {
    redirect_uris?: string[];
    client_name?: string;
    client_uri?: string;
  };
};

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
  clients: [] as any[],
  httpTransports: [] as HttpTransportMock[],
  sseTransports: [] as HttpTransportMock[],
  failStreamableProbe: false,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation((info: unknown, options: unknown) => {
    const client = {
      info,
      options,
      setRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      connect: vi.fn(async () => {
        if ((info as { name?: string })?.name === "pi-mcp-probe" && mocks.failStreamableProbe) {
          throw new Error("streamable probe failed");
        }
      }),
      listTools: vi.fn(async () => ({ tools: [] })),
      listResources: vi.fn(async () => ({ resources: [] })),
      close: vi.fn(async () => undefined),
    };
    mocks.clients.push(client);
    return client;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation((url: URL, options: TransportOptions) => {
    const transport = { url, options, close: vi.fn(async () => undefined) };
    mocks.httpTransports.push(transport);
    return transport;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn().mockImplementation((url: URL, options: TransportOptions) => {
    const transport = { url, options, close: vi.fn(async () => undefined) };
    mocks.sseTransports.push(transport);
    return transport;
  }),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager HTTP bearer auth", () => {
  const originalEnv = {
    MCP_TEST_BEARER_TOKEN: process.env.MCP_TEST_BEARER_TOKEN,
    MCP_TEST_BEARER_TOKEN_ENV: process.env.MCP_TEST_BEARER_TOKEN_ENV,
  };

  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;
    mocks.sseTransports.length = 0;
    mocks.failStreamableProbe = false;
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

  it("applies the configured timeout to the HTTP probe connect", async () => {
    const { McpServerManager } = await import("../server-manager.ts");

    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);
    await manager.connect("remote", {
      url: "https://example.test/mcp",
      requestTimeoutMs: 5000,
    });

    expect(mocks.clients[1].connect).toHaveBeenCalledWith(mocks.httpTransports[0], { timeout: 5000 });
    expect(mocks.clients[0].connect).toHaveBeenCalledWith(mocks.httpTransports[1], { timeout: 5000 });
  });

  it("uses callback-resolved HTTP values without consulting process.env", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_BEARER_TOKEN = "PROCESS_GLOBAL_CANARY";

    const manager = new McpServerManager();
    await manager.connect("qualified-source-server", {
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerToken: "CALLBACK_TOKEN",
      headers: { "X-Source": "CALLBACK_HEADER" },
    }, undefined, {
      values: "resolved",
      allowLegacySseFallback: false,
      retainedDefinition: { requestTimeoutMs: 1000 },
    });

    expect(mocks.httpTransports.at(-1)!.options.requestInit?.headers).toEqual({
      "X-Source": "CALLBACK_HEADER",
      Authorization: "Bearer CALLBACK_TOKEN",
    });
    expect(JSON.stringify(mocks.httpTransports.at(-1)!.options)).not.toContain("PROCESS_GLOBAL_CANARY");
  });

  it("does not silently turn exact Streamable HTTP into legacy SSE", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.failStreamableProbe = true;

    const manager = new McpServerManager();
    await expect(manager.connect("qualified-source-server", {
      url: "https://example.test/mcp",
    }, undefined, {
      values: "resolved",
      allowLegacySseFallback: false,
    })).rejects.toThrow("streamable probe failed");

    expect(mocks.sseTransports).toHaveLength(0);
  });

  it("preserves legacy SSE fallback for ordinary file configuration", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.failStreamableProbe = true;

    const manager = new McpServerManager();
    await manager.connect("file-server", { url: "https://example.test/mcp" });

    expect(mocks.sseTransports).toHaveLength(1);
  });
});
