import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stdioOptions: [] as Record<string, unknown>[],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    setRequestHandler: vi.fn(),
    setNotificationHandler: vi.fn(),
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [] })),
    listResources: vi.fn(async () => ({ resources: [] })),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation((options: Record<string, unknown>) => {
    mocks.stdioOptions.push(options);
    return { close: vi.fn(async () => undefined) };
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

describe("McpServerManager programmatic stdio values", () => {
  const previous = process.env.PROGRAMMATIC_PROCESS_CANARY;

  beforeEach(() => {
    mocks.stdioOptions.length = 0;
    process.env.PROGRAMMATIC_PROCESS_CANARY = "must-not-be-inherited";
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.PROGRAMMATIC_PROCESS_CANARY;
    else process.env.PROGRAMMATIC_PROCESS_CANARY = previous;
  });

  it("launches with only callback-resolved environment and retains only structural policy", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager("/session");
    const connection = await manager.connect("programmatic:qualified", {
      command: "/resolved/bin/server",
      args: ["--resolved"],
      cwd: "/resolved/cwd",
      env: { CALLBACK_ONLY: "resolved" },
    }, undefined, {
      values: "resolved",
      retainedDefinition: { requestTimeoutMs: 750 },
    });

    expect(mocks.stdioOptions).toEqual([{
      command: "/resolved/bin/server",
      args: ["--resolved"],
      cwd: "/resolved/cwd",
      env: { CALLBACK_ONLY: "resolved" },
      stderr: "ignore",
    }]);
    expect(JSON.stringify(mocks.stdioOptions)).not.toContain("PROGRAMMATIC_PROCESS_CANARY");
    expect(connection.definition).toEqual({ requestTimeoutMs: 750 });
  });
});
