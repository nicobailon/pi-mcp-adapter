import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  transports: [] as any[],
  // Controls what Client.connect does; set per-test.
  connectImpl: null as null | ((transport: any) => Promise<void>),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function (this: any, info: unknown, options: unknown) {
    this.info = info;
    this.options = options;
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn(async (transport: any) => {
      if (mocks.connectImpl) return mocks.connectImpl(transport);
      return undefined;
    });
    this.listTools = vi.fn(async () => ({ tools: [] }));
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any, options: any) {
    this.options = options;
    // Mirror the SDK: a PassThrough is exposed as `stderr` when stderr === "pipe".
    this.stderr = options?.stderr === "pipe" || options?.stderr === "overlapped" ? new PassThrough() : null;
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
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

describe("McpServerManager stderr capture", () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.connectImpl = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("spawns stdio servers with piped stderr", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(mocks.transports[0].options.stderr).toBe("pipe");
  });

  it("inherits stderr for debug servers", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    await manager.connect("demo", { command: "node", args: ["server.js"], debug: true });

    expect(mocks.transports[0].options.stderr).toBe("inherit");
  });

  it("appends captured stderr to the connection error", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    mocks.connectImpl = async (transport: any) => {
      // Emit stderr like a failing child process, then reject as the SDK does.
      transport.stderr.write(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\nIs the docker daemon running?\n",
      );
      // Give the "data" listener a tick to buffer before the failure propagates.
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("MCP error -32000: Connection closed");
    };

    await expect(
      manager.connect("loki", { command: "docker", args: ["run", "-i", "loki:latest"] }),
    ).rejects.toThrow(/Cannot connect to the Docker daemon/);
  });

  it("preserves the original error when there is no stderr output", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    mocks.connectImpl = async () => {
      throw new Error("MCP error -32000: Connection closed");
    };

    await expect(
      manager.connect("demo", { command: "node", args: ["server.js"] }),
    ).rejects.toThrow(/^MCP error -32000: Connection closed$/);
  });

  it("keeps only the last few stderr lines in the error detail", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    mocks.connectImpl = async (transport: any) => {
      transport.stderr.write("line-1\nline-2\nline-3\nline-4\nline-5\n");
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("MCP error -32000: Connection closed");
    };

    let message = "";
    try {
      await manager.connect("demo", { command: "node", args: ["server.js"] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("line-3 — line-4 — line-5");
    expect(message).not.toContain("line-1");
    expect(message).not.toContain("line-2");
  });
});
