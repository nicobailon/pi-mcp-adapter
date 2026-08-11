import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TransportOptions = { authProvider?: unknown };
const mocks = vi.hoisted(() => ({
  connectErrors: [] as unknown[],
  listToolsErrors: [] as unknown[],
  listResourcesErrors: [] as unknown[],
  listPromptsErrors: [] as unknown[],
  capabilities: {} as { resources?: {}; prompts?: {} },
  invalidated: [] as string[],
  connectSteps: [] as (() => Promise<void> | void)[],
}));

vi.mock("@modelcontextprotocol/client", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation(() => ({
    setRequestHandler: vi.fn(), setNotificationHandler: vi.fn(),
    connect: vi.fn(async () => {
      const step = mocks.connectSteps.shift();
      if (step) return step();
      const error = mocks.connectErrors.shift();
      if (error) throw error;
    }),
    listTools: vi.fn(async () => { const error = mocks.listToolsErrors.shift(); if (error) throw error; return { tools: [] }; }),
    listResources: vi.fn(async () => { const error = mocks.listResourcesErrors.shift(); if (error) throw error; return { resources: [] }; }),
    listPrompts: vi.fn(async () => { const error = mocks.listPromptsErrors.shift(); if (error) throw error; return { prompts: [] }; }),
    getServerCapabilities: vi.fn(() => mocks.capabilities), getInstructions: vi.fn(() => undefined), close: vi.fn(async () => undefined),
  })),
  StreamableHTTPClientTransport: vi.fn().mockImplementation((url: URL, options: TransportOptions) => ({ url, options, close: vi.fn(async () => undefined) })),
  SSEClientTransport: vi.fn().mockImplementation((url: URL, options: TransportOptions) => ({ url, options, close: vi.fn(async () => undefined) })),
}));
vi.mock("@modelcontextprotocol/client/stdio", () => ({ StdioClientTransport: vi.fn() }));
vi.mock("../npx-resolver.ts", () => ({ resolveNpxBinary: vi.fn(async () => null) }));
vi.mock("../mcp-auth.ts", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidateAuthEntryCache: vi.fn((name: string) => mocks.invalidated.push(name)),
}));

function unauthorized(): SdkHttpError {
  return new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "HTTP 401", { status: 401 });
}
const OAUTH_SERVER = { url: "https://example.test/mcp", auth: "oauth" as const };

describe("auth cache recovery on 401", () => {
  beforeEach(() => {
    mocks.connectErrors.length = 0;
    mocks.listToolsErrors.length = 0;
    mocks.listResourcesErrors.length = 0;
    mocks.listPromptsErrors.length = 0;
    mocks.capabilities = {};
    mocks.invalidated.length = 0;
    mocks.connectSteps.length = 0;
  });
  afterEach(() => vi.clearAllMocks());

  it("invalidates once for terminal transport and post-handshake 401s", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.connectErrors.push(unauthorized());
    const manager = new McpServerManager();
    const transport = await manager.connect("transport", OAUTH_SERVER);
    expect(transport.status).toBe("needs-auth");
    expect(transport.credentialsInvalidated).toBe(true);

    mocks.listToolsErrors.push(unauthorized());
    const postHandshake = await manager.connect("post-handshake", OAUTH_SERVER);
    expect(postHandshake.status).toBe("needs-auth");
    expect(mocks.invalidated).toEqual(["transport", "post-handshake"]);
  });


  it("invalidates on capability-advertised resources and prompts 401s", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    mocks.capabilities = { resources: {} };
    mocks.listResourcesErrors.push(unauthorized());
    expect((await manager.connect("resources-401", OAUTH_SERVER)).status).toBe("needs-auth");

    mocks.capabilities = { prompts: {} };
    mocks.listPromptsErrors.push(unauthorized());
    expect((await manager.connect("prompts-401", OAUTH_SERVER)).status).toBe("needs-auth");

    expect(mocks.invalidated).toEqual(["resources-401", "prompts-401"]);
  });


  it("keeps non-401 optional discovery failures non-fatal", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    mocks.capabilities = { resources: {}, prompts: {} };
    mocks.listResourcesErrors.push(new Error("resources unavailable"));
    mocks.listPromptsErrors.push(new Error("prompts unavailable"));

    expect((await manager.connect("optional-failures", OAUTH_SERVER)).status).toBe("connected");
    expect(mocks.invalidated).toEqual([]);
  });

  it("does not invalidate on the initial implicit challenge", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.connectErrors.push(unauthorized());
    const connection = await new McpServerManager().connect("implicit", { url: "https://example.test/mcp" });
    expect(connection.status).toBe("connected");
    expect(mocks.invalidated).toEqual([]);
  });

  it("invalidates once on the terminal provider-backed implicit OAuth 401", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.connectErrors.push(unauthorized(), unauthorized());

    const connection = await new McpServerManager().connect("implicit-terminal", { url: "https://example.test/mcp" });

    expect(connection.status).toBe("needs-auth");
    expect(mocks.invalidated).toEqual(["implicit-terminal"]);
  });

  it("keeps concurrent terminal recovery connects single-flight", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
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
    const first = manager.connect("concurrent", OAUTH_SERVER);
    await started;
    const second = manager.connect("concurrent", OAUTH_SERVER);
    release();
    const [firstConnection, secondConnection] = await Promise.all([first, second]);

    expect(firstConnection).toBe(secondConnection);
    expect(firstConnection.status).toBe("needs-auth");
    expect(mocks.invalidated).toEqual(["concurrent"]);
  });

  it("bounds health-check reconnects and resets after explicit close", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    for (let pass = 0; pass < 3; pass++) {
      mocks.connectErrors.push(unauthorized());
      expect((await manager.connect("parked", OAUTH_SERVER)).status).toBe("needs-auth");
    }
    expect(mocks.invalidated).toEqual(["parked"]);
    await manager.close("parked");
    mocks.connectErrors.push(unauthorized());
    await manager.connect("parked", OAUTH_SERVER);
    expect(mocks.invalidated).toEqual(["parked", "parked"]);
  });

  it("does not invalidate non-OAuth servers", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    mocks.connectErrors.push(unauthorized());
    await expect(new McpServerManager().connect("plain", { url: "https://example.test/mcp", auth: false })).rejects.toThrow("HTTP 401");
    expect(mocks.invalidated).toEqual([]);
  });
});
