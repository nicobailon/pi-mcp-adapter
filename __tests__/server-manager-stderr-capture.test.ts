import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

const mocks = vi.hoisted(() => ({
  transports: [] as any[],
  connectImpl: null as null | ((transport: any) => Promise<void>),
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation(function (this: any) {
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn(async (transport: any) => {
      if (mocks.connectImpl) return mocks.connectImpl(transport);
    });
    this.listTools = vi.fn(async () => ({ tools: [] }));
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.close = vi.fn(async () => undefined);
  }),
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function (this: any) {
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
  SSEClientTransport: vi.fn().mockImplementation(function (this: any) {
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any, options: any) {
    this.options = options;
    this.stderr = options?.stderr === "pipe" ? new PassThrough() : null;
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager stderr capture", () => {
  beforeEach(() => {
    mocks.transports.length = 0;
    mocks.connectImpl = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("pipes stderr for normal stdio servers and preserves inherit for debug", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    await manager.connect("demo", { command: "node", args: ["server.js"] });
    expect(mocks.transports[0].options.stderr).toBe("pipe");

    await manager.connect("debug", { command: "node", args: ["server.js"], debug: true });
    expect(mocks.transports[1].options.stderr).toBe("inherit");
  });

  it("appends captured stderr to the connection error", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    mocks.connectImpl = async (transport) => {
      transport.stderr.write("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n");
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("MCP error -32000: Connection closed");
    };

    await expect(manager.connect("loki", { command: "docker" })).rejects.toThrow(
      /MCP error -32000: Connection closed \(Cannot connect to the Docker daemon/,
    );
  });

  it("bounds oversized string stderr chunks before retaining their tail", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connectionError = new Error("connection failed");
    mocks.connectImpl = async (transport) => {
      transport.stderr.emit("data", "x".repeat(1_000_000));
      await new Promise((resolve) => setImmediate(resolve));
      throw connectionError;
    };

    let capturedError: Error | undefined;
    try {
      await manager.connect("demo", { command: "node" });
    } catch (error) {
      capturedError = error as Error;
    }
    expect(capturedError?.cause).toBe(connectionError);
    expect(Buffer.byteLength(capturedError?.message ?? "", "utf8")).toBeLessThanOrEqual(8_192 + 100);
  });

  it("keeps empty stdio stderr unchanged and enriches HTTP errors with a probe", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Not found</html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    })));
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    mocks.connectImpl = async () => {
      throw new Error("MCP error -32000: Connection closed");
    };

    await expect(manager.connect("stdio", { command: "node" })).rejects.toThrow(/^MCP error -32000: Connection closed$/);
    await expect(manager.connect("http", { url: "https://example.com/mcp" })).rejects.toThrow(
      /MCP error -32000: Connection closed — probe: endpoint returned HTML \(404\)/,
    );
  });

  it("bounds captured stderr and keeps only its final three lines", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connectionError = new Error("connection failed");
    mocks.connectImpl = async (transport) => {
      transport.stderr.write("x".repeat(8_192));
      transport.stderr.write("\nline-1\nline-2\nline-3\nline-4\n");
      await new Promise((resolve) => setImmediate(resolve));
      throw connectionError;
    };

    let capturedError: Error | undefined;
    try {
      await manager.connect("demo", { command: "node" });
    } catch (error) {
      capturedError = error as Error;
    }

    expect(Buffer.byteLength(capturedError?.message ?? "", "utf8")).toBeLessThan(8_192 + 200);
    expect(capturedError?.message).toContain("line-2 — line-3 — line-4");
    expect(capturedError?.message).not.toContain("line-1");
    expect(capturedError?.cause).toBe(connectionError);
  });
});
