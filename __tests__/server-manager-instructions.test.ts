import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  instructions: undefined as string | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (this: any, info: unknown, options: unknown) {
    this.info = info;
    this.options = options;
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn(async () => undefined);
    this.listTools = vi.fn(async () => ({ tools: [] }));
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.getInstructions = vi.fn(() => mocks.instructions);
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any, options: unknown) {
    this.options = options;
    this.close = vi.fn(async () => undefined);
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager instructions", () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.instructions = undefined;
  });

  it("captures server instructions from the initialize result at connect time", async () => {
    mocks.instructions = "Use read_skill to load a skill before answering.";
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(connection.instructions).toBe("Use read_skill to load a skill before answering.");
  });

  it("leaves instructions undefined when the server provides none", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(connection.instructions).toBeUndefined();
  });
});
