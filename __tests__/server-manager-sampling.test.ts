import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  transports: [] as any[],
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
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any, options: unknown) {
    this.options = options;
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

vi.mock("../npx-resolver.js", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager sampling", () => {
  const originalMcpTestCwd = process.env.MCP_TEST_CWD;

  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.transports.length = 0;
  });

  afterEach(() => {
    if (originalMcpTestCwd === undefined) {
      delete process.env.MCP_TEST_CWD;
    } else {
      process.env.MCP_TEST_CWD = originalMcpTestCwd;
    }
  });

  it("advertises sampling and registers the handler before connecting", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setSamplingConfig({
      autoApprove: true,
      modelRegistry: {} as any,
      getCurrentModel: () => undefined,
      getSignal: () => undefined,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toMatchObject({ capabilities: { sampling: {} } });
    expect(client.options.listChanged.tools.onChanged).toBeTypeOf("function");
    expect(client.options.listChanged.resources.onChanged).toBeTypeOf("function");
    expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
    expect(client.setRequestHandler.mock.invocationCallOrder[0]).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
  });

  it("does not advertise sampling when no sampling config is set", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options.capabilities).toBeUndefined();
    expect(client.options.listChanged.tools.onChanged).toBeTypeOf("function");
    expect(client.options.listChanged.resources.onChanged).toBeTypeOf("function");
    expect(client.setRequestHandler).not.toHaveBeenCalled();
  });

  it("updates cached server lists when MCP list_changed callbacks refresh", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const metadataChanged = vi.fn();
    manager.setMetadataListChangedListener(metadataChanged);

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    const tools = [{ name: "new_tool", description: "New tool" }];
    const resources = [{ uri: "file://demo", name: "Demo resource" }];

    client.options.listChanged.tools.onChanged(null, tools);
    client.options.listChanged.resources.onChanged(null, resources);

    expect(manager.getConnection("demo")?.tools).toEqual(tools);
    expect(manager.getConnection("demo")?.resources).toEqual(resources);
    expect(metadataChanged).toHaveBeenCalledWith("demo", "tools-list-changed");
    expect(metadataChanged).toHaveBeenCalledWith("demo", "resources-list-changed");
  });

  it("expands environment variables and tilde in stdio cwd", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    process.env.MCP_TEST_CWD = "/tmp/pi-mcp-cwd";

    const envManager = new McpServerManager();
    await envManager.connect("env-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "${MCP_TEST_CWD}/nested",
    });

    const homeManager = new McpServerManager();
    await homeManager.connect("home-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "~/nested",
    });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/pi-mcp-cwd/nested" });
    expect(mocks.transports[1].options).toMatchObject({ cwd: join(homedir(), "nested") });
  });
});
