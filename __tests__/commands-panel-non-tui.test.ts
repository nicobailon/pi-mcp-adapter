import { describe, expect, it, vi } from "vitest";

vi.mock("../init.ts", () => ({
  getFailureAgeSeconds: vi.fn(() => null),
  getFailureMessage: vi.fn(() => undefined),
  clearFailure: vi.fn(),
  lazyConnect: vi.fn(),
  markKeepAliveAfterConnect: vi.fn(),
  recordFailure: vi.fn(),
  updateMetadataCache: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
  updateStatusBar: vi.fn(),
}));

const state = () =>
  ({
    config: { mcpServers: { demo: { command: "node" } } },
    manager: { getConnection: () => undefined },
    toolMetadata: new Map(),
    promptMetadata: new Map(),
    failureTracker: new Map(),
  }) as any;

// In rpc/print mode `ctx.ui.custom()` is a headless stub: it resolves without
// invoking the factory, so anything that awaits `done` never settles. These
// tests pin the text fallbacks that keep `/mcp` from hanging in those modes.
// Failing them looks like a hung command, not a failed assertion, so the stub
// mirrors the real behaviour: it never calls back.
const nonTuiUi = () => {
  const notify = vi.fn();
  const custom = vi.fn(() => new Promise<never>(() => {}));
  return { notify, custom, ui: { notify, custom } };
};

const withTimeout = <T>(promise: Promise<T>, label: string) =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} hung waiting for a custom UI panel`)), 1000),
    ),
  ]);

describe("MCP panels outside the terminal UI", () => {
  it("/mcp falls back to the text status instead of hanging on an overlay", async () => {
    const { openMcpPanel } = await import("../commands.ts");
    const { ui, notify, custom } = nonTuiUi();

    const result = await withTimeout(
      openMcpPanel(state(), {} as any, { hasUI: true, mode: "rpc", cwd: "/repo", ui } as any),
      "openMcpPanel",
    );

    expect(custom).not.toHaveBeenCalled();
    expect(result).toEqual({ configChanged: false });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("MCP Server Status:"), "info");
  });

  it("/mcp setup explains where the panel is available", async () => {
    const { openMcpSetup } = await import("../commands.ts");
    const { ui, notify, custom } = nonTuiUi();

    const result = await withTimeout(
      openMcpSetup(state(), {} as any, { hasUI: true, mode: "rpc", cwd: "/repo", ui } as any),
      "openMcpSetup",
    );

    expect(custom).not.toHaveBeenCalled();
    expect(result).toEqual({ configChanged: false });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("terminal UI"), "info");
  });

  it("/mcp-auth points at the per-server command", async () => {
    const { openMcpAuthPanel } = await import("../commands.ts");
    const { ui, notify, custom } = nonTuiUi();

    const result = await withTimeout(
      openMcpAuthPanel(state(), {} as any, { hasUI: true, mode: "rpc", cwd: "/repo", ui } as any),
      "openMcpAuthPanel",
    );

    expect(custom).not.toHaveBeenCalled();
    expect(result).toEqual({ configChanged: false });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/mcp-auth <server>"), "info");
  });

  it("still renders the overlay in the terminal UI", async () => {
    const { openMcpSetup } = await import("../commands.ts");
    const { ui, custom } = nonTuiUi();

    // `custom` never settles, so poll for the call rather than awaiting the
    // panel or racing a fixed delay against the dynamic panel import.
    void openMcpSetup(state(), {} as any, { hasUI: true, mode: "tui", cwd: "/repo", ui } as any);
    const deadline = Date.now() + 5000;
    while (custom.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(custom).toHaveBeenCalled();
  });
});
