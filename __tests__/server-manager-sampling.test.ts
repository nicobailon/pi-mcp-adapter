import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  transports: [] as any[],
  open: vi.fn(async () => undefined),
}));

vi.mock("open", () => ({ default: mocks.open }));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation(function (this: any, info: unknown, options: unknown) {
    this.info = info;
    this.options = options;
    this.setRequestHandler = vi.fn();
    this.setNotificationHandler = vi.fn();
    this.connect = vi.fn(async () => undefined);
    this.getServerCapabilities = vi.fn(() => ({ tools: {}, resources: {} }));
    this.listTools = vi.fn(async () => ({ tools: [] }));
    this.listResources = vi.fn(async () => ({ resources: [] }));
    this.close = vi.fn(async () => undefined);
    mocks.clients.push(this);
  }),
  StreamableHTTPClientTransport: vi.fn(),
  SSEClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: vi.fn().mockImplementation(function (this: any, options: unknown) {
    this.options = options;
    this.close = vi.fn(async () => undefined);
    mocks.transports.push(this);
  }),
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
    expect(client.options).toMatchObject({
      capabilities: { sampling: {} },
    });
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
    expect(client.options).toMatchObject({
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

    expect(mocks.clients[0].options).toMatchObject({
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
    const { UrlElicitationRequiredError } = await import("@modelcontextprotocol/client");
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

    expect(mocks.clients[0].options).toMatchObject({
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
    expect(client.options).not.toHaveProperty("capabilities");
    expect(client.options.listChanged.tools.onChanged).toBeTypeOf("function");
    expect(client.options.listChanged.resources.onChanged).toBeTypeOf("function");
    expect(client.setRequestHandler).not.toHaveBeenCalled();
  });

  it("refreshes cached lists and ignores notifications from replaced clients", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const metadataChanged = vi.fn();
    manager.setMetadataListChangedListener(metadataChanged);

    await manager.connect("demo", { command: "node", args: ["server.js"] });
    const oldClient = mocks.clients[0];
    await manager.close("demo");
    await manager.connect("demo", { command: "node", args: ["server.js"] });
    const freshClient = mocks.clients[1];
    const freshTools = [{ name: "fresh_tool", description: "Fresh tool" }];
    const freshResources = [{ uri: "file://fresh", name: "Fresh resource" }];

    oldClient.options.listChanged.tools.onChanged(null, [{ name: "stale_tool" }]);
    oldClient.options.listChanged.resources.onChanged(null, [{ uri: "file://stale", name: "Stale resource" }]);
    expect(manager.getConnection("demo")?.tools).toEqual([]);
    expect(manager.getConnection("demo")?.resources).toEqual([]);
    expect(metadataChanged).not.toHaveBeenCalled();

    freshClient.options.listChanged.tools.onChanged(null, freshTools);
    freshClient.options.listChanged.resources.onChanged(null, freshResources);
    expect(manager.getConnection("demo")?.tools).toEqual(freshTools);
    expect(manager.getConnection("demo")?.resources).toEqual(freshResources);
    expect(metadataChanged).toHaveBeenCalledWith("demo", "tools-list-changed");
    expect(metadataChanged).toHaveBeenCalledWith("demo", "resources-list-changed");
  });

  it("forces an authoritative tool refresh and publishes catalog changes", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const metadataChanged = vi.fn();
    manager.setMetadataListChangedListener(metadataChanged);

    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const freshTools = [{ name: "fresh_tool", description: "Fresh tool" }];
    client.listTools.mockResolvedValueOnce({ tools: freshTools });

    await expect(manager.refreshTools("demo", connection)).resolves.toBe("updated");

    expect(client.listTools).toHaveBeenLastCalledWith(undefined, expect.objectContaining({
      cacheMode: "refresh",
      timeout: 5_000,
    }));
    expect(connection.tools).toEqual(freshTools);
    expect(metadataChanged).toHaveBeenCalledWith("demo", "keep-alive-refresh");

    metadataChanged.mockClear();
    client.listTools.mockResolvedValueOnce({ tools: freshTools });
    await expect(manager.refreshTools("demo", connection)).resolves.toBe("unchanged");
    expect(metadataChanged).not.toHaveBeenCalled();
  });

  it("keeps every page of an authoritative tool refresh", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const initialListCalls = client.listTools.mock.calls.length;
    client.listTools
      .mockResolvedValueOnce({
        tools: [{ name: "first_page_tool" }],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({ tools: [{ name: "second_page_tool" }] });

    await expect(manager.refreshTools("demo", connection)).resolves.toBe("updated");

    expect(connection.tools.map(tool => tool.name)).toEqual([
      "first_page_tool",
      "second_page_tool",
    ]);
    expect(client.listTools).toHaveBeenNthCalledWith(
      initialListCalls + 1,
      undefined,
      expect.objectContaining({ cacheMode: "refresh", timeout: 5_000 }),
    );
    expect(client.listTools).toHaveBeenLastCalledWith(
      { cursor: "page-2" },
      expect.objectContaining({ cacheMode: "refresh", timeout: 5_000 }),
    );
  });

  it("retries publication when a refreshed catalog listener fails", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const publicationError = new Error("cache unavailable");
    const metadataChanged = vi.fn().mockImplementationOnce(() => { throw publicationError; });
    manager.setMetadataListChangedListener(metadataChanged);

    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const freshTools = [{ name: "fresh_tool", description: "Fresh tool" }];
    mocks.clients[0].listTools.mockResolvedValueOnce({ tools: freshTools });

    await expect(manager.refreshTools("demo", connection)).rejects.toBe(publicationError);
    expect(connection.tools).toEqual([]);

    mocks.clients[0].listTools.mockResolvedValueOnce({ tools: freshTools });
    await expect(manager.refreshTools("demo", connection)).resolves.toBe("updated");
    expect(connection.tools).toEqual(freshTools);
  });

  it("queues a failed session-reconnect publication for the next refresh", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const publicationError = new Error("cache unavailable");
    const metadataChanged = vi.fn()
      .mockImplementationOnce(() => { throw publicationError; })
      .mockImplementation(() => undefined);
    manager.setMetadataListChangedListener(metadataChanged);
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });

    expect(manager.publishMetadataChanged("demo", connection, "session-reconnect")).toBe(false);
    await expect(manager.refreshTools("demo", connection)).resolves.toBe("unchanged");

    expect(metadataChanged).toHaveBeenNthCalledWith(1, "demo", "session-reconnect");
    expect(metadataChanged).toHaveBeenNthCalledWith(2, "demo", "session-reconnect");
  });

  it("pings keep-alive connections whose negotiated server has no tools capability", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const initialListCalls = client.listTools.mock.calls.length;
    client.getServerCapabilities.mockReturnValue({ resources: {} });
    client.ping = vi.fn(async () => ({}));

    await expect(manager.refreshTools("demo", connection)).resolves.toBe("unchanged");

    expect(client.ping).toHaveBeenCalledWith(expect.objectContaining({ timeout: 5_000 }));
    expect(client.listTools).toHaveBeenCalledTimes(initialListCalls);
  });

  it("marks only tools/list keep-alive timeout errors as refresh timeouts", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const { SdkError, SdkErrorCode } = await import("@modelcontextprotocol/client");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const timeout = new SdkError(SdkErrorCode.RequestTimeout, "Request timed out");
    client.listTools.mockRejectedValueOnce(timeout);

    await expect(manager.refreshTools("demo", connection)).resolves.toBe("refresh-timeout");

    client.getServerCapabilities.mockReturnValue({ resources: {} });
    client.ping = vi.fn(async () => { throw timeout; });
    await expect(manager.refreshTools("demo", connection)).rejects.toBe(timeout);
  });

  it("retries queued metadata publication after a no-tools ping", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    client.getServerCapabilities.mockReturnValue({ resources: {} });
    client.ping = vi.fn(async () => ({}));
    const metadataChanged = vi.fn()
      .mockImplementationOnce(() => { throw new Error("cache unavailable"); })
      .mockImplementation(() => undefined);
    manager.setMetadataListChangedListener(metadataChanged);

    expect(manager.publishMetadataChanged("demo", connection, "session-reconnect")).toBe(false);
    await expect(manager.refreshTools("demo", connection)).resolves.toBe("unchanged");

    expect(metadataChanged).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a newer list-changed catalog with an older refresh response", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    let resolveRefresh!: (value: { tools: Array<{ name: string }> }) => void;
    client.listTools.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));

    const refresh = manager.refreshTools("demo", connection);
    await Promise.resolve();
    const notificationTools = [{ name: "notification_tool" }];
    client.options.listChanged.tools.onChanged(null, notificationTools);
    resolveRefresh({ tools: [{ name: "older_refresh_tool" }] });

    await expect(refresh).resolves.toBe("superseded");
    expect(connection.tools).toEqual(notificationTools);
  });

  it("logs list-change callback errors without replacing cached metadata", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    await manager.connect("demo", { command: "node", args: ["server.js"] });
    const client = mocks.clients[0];
    const error = new Error("refresh failed");

    client.options.listChanged.tools.onChanged(error, null);
    client.options.listChanged.resources.onChanged(error, null);

    expect(manager.getConnection("demo")?.tools).toEqual([]);
    expect(manager.getConnection("demo")?.resources).toEqual([]);
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

  it("uses the session cwd for stdio servers without an explicit cwd", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager("/tmp/pi-session-cwd");

    await manager.connect("session-cwd", { command: "node", args: ["server.js"] });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/pi-session-cwd" });
  });

  it("prefers an explicit stdio cwd over the session cwd", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager("/tmp/pi-session-cwd");

    await manager.connect("explicit-cwd", {
      command: "node",
      args: ["server.js"],
      cwd: "/tmp/server-cwd",
    });

    expect(mocks.transports[0].options).toMatchObject({ cwd: "/tmp/server-cwd" });
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
