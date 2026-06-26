import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  transports: [] as any[],
  open: vi.fn(async () => undefined),
}));

vi.mock("open", () => ({ default: mocks.open }));

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

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager sampling", () => {
  const originalMcpTestCwd = process.env.MCP_TEST_CWD;

  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.transports.length = 0;
    mocks.open.mockClear();
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
    expect(client.options).toEqual({ capabilities: { sampling: {} } });
    expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
    expect(client.setRequestHandler.mock.invocationCallOrder[0]).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
  });

  it("advertises elicitation capabilities and registers the handler before connecting", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setElicitationConfig({
      allowUrl: true,
      ui: {} as any,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toEqual({
      capabilities: {
        elicitation: {
          form: {},
          url: {},
        },
      },
    });
    expect(client.setRequestHandler).toHaveBeenCalledTimes(1);
    expect(client.setRequestHandler.mock.invocationCallOrder[0]).toBeLessThan(
      client.connect.mock.invocationCallOrder[0],
    );
  });

  it("advertises form-only elicitation when URL navigation is unavailable", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: false, ui: {} as any });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(mocks.clients[0].options).toEqual({
      capabilities: { elicitation: { form: {} } },
    });
  });

  it("notifies only when a known URL elicitation completes", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const ui = {
      select: vi.fn().mockResolvedValue("Open"),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: true, ui: ui as any });
    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    const requestHandler = client.setRequestHandler.mock.calls[0][1];
    await requestHandler({
      method: "elicitation/create",
      params: {
        mode: "url",
        message: "Connect",
        elicitationId: "known-id",
        url: "https://example.com/connect",
      },
    });
    const completionHandler = client.setNotificationHandler.mock.calls[0][1];
    completionHandler({ params: { elicitationId: "unknown-id" } });
    completionHandler({ params: { elicitationId: "known-id" } });
    completionHandler({ params: { elicitationId: "known-id" } });

    expect(ui.notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
    expect(ui.notify).toHaveBeenCalledWith(
      "MCP browser interaction for demo completed. You can retry the tool now.",
      "info",
    );
    expect(ui.notify).toHaveBeenCalledTimes(2);
  });

  it("handles every URL in a URL-required error", async () => {
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/sdk/types.js");
    const { McpServerManager } = await import("../server-manager.ts");
    const ui = {
      select: vi.fn().mockResolvedValue("Open"),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const manager = new McpServerManager();
    manager.setElicitationConfig({ allowUrl: true, ui: ui as any });
    const result = await manager.handleUrlElicitationRequired("demo", new UrlElicitationRequiredError([
      { mode: "url", message: "First", elicitationId: "one", url: "https://example.com/one" },
      { mode: "url", message: "Second", elicitationId: "two", url: "https://example.com/two" },
    ]));

    expect(result).toBe("accept");
    expect(mocks.open).toHaveBeenNthCalledWith(1, "https://example.com/one");
    expect(mocks.open).toHaveBeenNthCalledWith(2, "https://example.com/two");
  });

  it("advertises sampling and elicitation together", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setSamplingConfig({
      autoApprove: true,
      modelRegistry: {} as any,
      getCurrentModel: () => undefined,
      getSignal: () => undefined,
    });
    manager.setElicitationConfig({
      allowUrl: true,
      ui: {} as any,
    });

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(mocks.clients[0].options).toEqual({
      capabilities: {
        sampling: {},
        elicitation: {
          form: {},
          url: {},
        },
      },
    });
    expect(mocks.clients[0].setRequestHandler).toHaveBeenCalledTimes(2);
  });

  it("does not advertise sampling when no sampling config is set", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.options).toBeUndefined();
    expect(client.setRequestHandler).not.toHaveBeenCalled();
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

  it("applies the global timeout to connect and discovery requests", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);

    await manager.connect("demo", { command: "node", args: ["server.js"] });

    const client = mocks.clients[0];
    expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 2500 });
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 2500 });
    expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 2500 });
  });

  it("prefers the per-server timeout for connect and discovery requests", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);

    await manager.connect("demo", { command: "node", args: ["server.js"], requestTimeoutMs: 5000 });

    const client = mocks.clients[0];
    expect(client.connect).toHaveBeenCalledWith(mocks.transports[0], { timeout: 5000 });
    expect(client.listTools).toHaveBeenCalledWith(undefined, { timeout: 5000 });
    expect(client.listResources).toHaveBeenCalledWith(undefined, { timeout: 5000 });
  });

  it("builds request options from global and per-server timeouts", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2500);

    await manager.connect("demo", { command: "node", args: ["server.js"], requestTimeoutMs: 5000 });
    await manager.connect("sdk-default", { command: "node", args: ["server.js"], requestTimeoutMs: 0 });

    const signal = new AbortController().signal;
    expect(manager.getRequestOptions("demo", signal)).toEqual({ signal, timeout: 5000 });
    expect(manager.getRequestOptions("missing", signal)).toEqual({ signal, timeout: 2500 });
    expect(manager.getRequestOptions("missing")).toEqual({ timeout: 2500 });
    expect(manager.getRequestOptions("sdk-default")).toBeUndefined();

    manager.setDefaultRequestTimeoutMs(0);
    expect(manager.getRequestOptions("missing")).toBeUndefined();
  });
});
