import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAuthEntry,
  getTestAuthSecretStoreReadCount,
  resetTestAuthSecretStore,
  saveAuthEntry,
} from "../mcp-auth.ts";

type TransportOptions = { authProvider?: { tokens: () => Promise<{ access_token?: string } | undefined> } };

const mocks = vi.hoisted(() => ({
  clients: [] as unknown[],
  transports: [] as { options: TransportOptions }[],
  connectSteps: [] as (() => Promise<void> | void)[],
}));

vi.mock("@modelcontextprotocol/client", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation(() => {
    const client = {
      setRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      connect: vi.fn(async () => { await mocks.connectSteps.shift()?.(); }),
      listTools: vi.fn(async () => ({ tools: [] })),
      listResources: vi.fn(async () => ({ resources: [] })),
      listPrompts: vi.fn(async () => ({ prompts: [] })),
      getServerCapabilities: vi.fn(() => ({})),
      getInstructions: vi.fn(() => undefined),
      close: vi.fn(async () => undefined),
    };
    mocks.clients.push(client);
    return client;
  }),
  StreamableHTTPClientTransport: vi.fn().mockImplementation((_url: URL, options: TransportOptions) => {
    const transport = { options, close: vi.fn(async () => undefined) };
    mocks.transports.push(transport);
    return transport;
  }),
  SSEClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/client/stdio", () => ({ StdioClientTransport: vi.fn() }));
vi.mock("../npx-resolver.ts", () => ({ resolveNpxBinary: vi.fn(async () => null) }));

const DISABLE_ENV = "PI_MCP_ADAPTER_DISABLE_AUTH_CACHE";
const SERVER_URL = "https://example.test/mcp";
const OAUTH_SERVER = { url: SERVER_URL, auth: "oauth" as const };

function unauthorized(): SdkHttpError {
  return new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "HTTP 401", { status: 401 });
}

function writeBehindTheCache(serverName: string, accessToken: string): void {
  const prior = process.env[DISABLE_ENV];
  process.env[DISABLE_ENV] = "1";
  saveAuthEntry(serverName, { tokens: { accessToken } }, SERVER_URL);
  if (prior === undefined) delete process.env[DISABLE_ENV];
  else process.env[DISABLE_ENV] = prior;
}

function capturedProvider() {
  const provider = mocks.transports.at(-1)?.options.authProvider;
  expect(provider).toBeDefined();
  return provider!;
}

async function expectProviderReloadsOnce(provider: NonNullable<ReturnType<typeof capturedProvider>>, accessToken: string): Promise<void> {
  const beforeReload = getTestAuthSecretStoreReadCount();
  expect((await provider.tokens())?.access_token).toBe(accessToken);
  expect(getTestAuthSecretStoreReadCount() - beforeReload).toBe(1);
  expect((await provider.tokens())?.access_token).toBe(accessToken);
  expect(getTestAuthSecretStoreReadCount() - beforeReload).toBe(1);
}

describe("auth cache recovery with the real OAuth provider", () => {
  const originalEnv = {
    [DISABLE_ENV]: process.env[DISABLE_ENV],
  };

  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.connectSteps.length = 0;
    delete process.env[DISABLE_ENV];
    resetTestAuthSecretStore();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetTestAuthSecretStore();
    vi.clearAllMocks();
  });

  it("evicts after an explicit OAuth 401 so the provider reloads an external rotation", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    saveAuthEntry("explicit", { tokens: { accessToken: "old" } }, SERVER_URL);
    expect(getAuthEntry("explicit")?.tokens?.accessToken).toBe("old");
    writeBehindTheCache("explicit", "new");
    mocks.connectSteps.push(() => { throw unauthorized(); });

    const connection = await new McpServerManager().connect("explicit", OAUTH_SERVER);
    expect(connection.status).toBe("needs-auth");
    await expectProviderReloadsOnce(capturedProvider(), "new");
  });

  it("evicts only after the second, provider-backed implicit OAuth 401", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    saveAuthEntry("implicit", { tokens: { accessToken: "old" } }, SERVER_URL);
    expect(getAuthEntry("implicit")?.tokens?.accessToken).toBe("old");
    writeBehindTheCache("implicit", "new");
    mocks.connectSteps.push(
      () => { throw unauthorized(); },
      () => { throw unauthorized(); },
    );

    const connection = await new McpServerManager().connect("implicit", { url: SERVER_URL });

    expect(connection.status).toBe("needs-auth");
    expect(mocks.transports).toHaveLength(2);
    expect(mocks.transports[0]?.options.authProvider).toBeUndefined();
    await expectProviderReloadsOnce(capturedProvider(), "new");
  });

  it("keeps concurrent recovery connects single-flight", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    saveAuthEntry("shared", { tokens: { accessToken: "old" } }, SERVER_URL);
    expect(getAuthEntry("shared")?.tokens?.accessToken).toBe("old");
    writeBehindTheCache("shared", "new");
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    mocks.connectSteps.push(async () => {
      entered();
      await blocked;
      throw unauthorized();
    });

    const manager = new McpServerManager();
    const first = manager.connect("shared", OAUTH_SERVER);
    await started;
    const second = manager.connect("shared", OAUTH_SERVER);
    release();
    const [firstConnection, secondConnection] = await Promise.all([first, second]);

    expect(firstConnection).toBe(secondConnection);
    expect(firstConnection.status).toBe("needs-auth");
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.transports).toHaveLength(1);
    await expectProviderReloadsOnce(capturedProvider(), "new");
  });
});
