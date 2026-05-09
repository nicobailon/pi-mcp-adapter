import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TransportOptions = {
  requestInit?: {
    headers?: Record<string, string>;
  };
  authProvider?: unknown;
};

type HttpTransportMock = {
  url: URL;
  options: TransportOptions;
  close: () => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  httpTransports: [] as HttpTransportMock[],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation((info: unknown, options: unknown) => ({
    info,
    options,
    setRequestHandler: vi.fn(),
    setNotificationHandler: vi.fn(),
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [] })),
    listResources: vi.fn(async () => ({ resources: [] })),
    close: vi.fn(async () => undefined),
  })),
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
  SSEClientTransport: vi.fn(),
}));

vi.mock("../npx-resolver.js", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager HTTP bearer auth", () => {
  const originalEnv = {
    MCP_TEST_BEARER_TOKEN: process.env.MCP_TEST_BEARER_TOKEN,
    MCP_TEST_BEARER_TOKEN_ENV: process.env.MCP_TEST_BEARER_TOKEN_ENV,
  };

  beforeEach(() => {
    mocks.httpTransports.length = 0;
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
});
