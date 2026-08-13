import { describe, expect, it, vi } from "vitest";

vi.mock("../init.ts", () => ({
  getFailureAgeSeconds: vi.fn(() => 7),
  getFailureMessage: vi.fn(() => "stderr says\n\x1b]8;;https://secret.invalid/status\x07server failed\x1b]8;;\x07"),
  clearFailure: vi.fn(),
  lazyConnect: vi.fn(),
  markKeepAliveAfterConnect: vi.fn(),
  recordFailure: vi.fn(),
  updateMetadataCache: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
  updateStatusBar: vi.fn(),
}));

describe("MCP status failure reasons", () => {
  it("includes the bounded failure reason as a safe single-line status", async () => {
    const { showStatus } = await import("../commands.ts");
    const ui = { notify: vi.fn() };
    await showStatus({
      config: { mcpServers: { demo: { command: "node" } } },
      manager: { getConnection: () => undefined },
      toolMetadata: new Map(),
      failureTracker: new Map([["demo", Date.now()]]),
    } as any, { hasUI: true, ui } as any);

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("demo: failed 7s ago — stderr says server failed"),
      "info",
    );
    expect(ui.notify.mock.calls[0][0]).not.toContain("https://secret.invalid/status");
  });

  it("uses known metadata during reconnect filtering", async () => {
    const { reconnectServer } = await import("../commands.ts");
    const connection = {
      status: "connected",
      tools: [{ name: "search-records", description: "Search" }],
      resources: [],
      prompts: [],
    };
    const state = {
      config: {
        settings: { toolPrefix: "server" },
        mcpServers: {
          "my-server": { command: "hyphen", excludeTools: ["search_records"] },
          my_2d_server: { command: "escaped" },
        },
      },
      manager: { close: vi.fn(async () => {}), connect: vi.fn(async () => connection) },
      toolMetadata: new Map([["my_2d_server", [{ name: "my_2d_server_search_records", originalName: "search_records", description: "Other" }]]]),
      promptMetadata: new Map(),
      promptMetadataLive: new Set(),
      serverInstructions: new Map(),
      failureTracker: new Map(),
    } as any;

    await expect(reconnectServer(state, { hasUI: false } as any, "my-server")).resolves.toBe(true);
    expect(state.toolMetadata.get("my-server")?.map((tool: any) => tool.name)).toEqual(["my-server_search-records"]);
  });

  it("sanitizes captured diagnostics in reconnect notifications", async () => {
    const { reconnectServer } = await import("../commands.ts");
    const ui = { notify: vi.fn() };
    await reconnectServer({
      config: { settings: {}, mcpServers: { demo: { command: "node" } } },
      manager: {
        close: vi.fn(async () => {}),
        connect: vi.fn(async () => {
          throw new Error("stderr \x1b]52;c;clipboard-secret\x07server failed");
        }),
      },
    } as any, { hasUI: true, ui } as any, "demo");

    expect(ui.notify).toHaveBeenCalledWith("MCP: Failed to reconnect to demo: stderr server failed", "error");
    expect(ui.notify.mock.calls[0][0]).not.toContain("clipboard-secret");
  });
});
