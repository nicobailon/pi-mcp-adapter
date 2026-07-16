import { describe, expect, it, vi } from "vitest";
import { updateStatusBar } from "../init.ts";
import type { McpExtensionState } from "../state.ts";

function makeUi() {
  return {
    setStatus: vi.fn(),
    theme: {
      fg: vi.fn((color: string, text: string) => `[${color}]${text}`),
    },
  };
}

function makeState(overrides: {
  servers?: string[];
  connections?: Record<string, { status: "connected" | "needs-auth" | "closed" }>;
  failures?: Record<string, number>;
  ui?: ReturnType<typeof makeUi> | null;
}): McpExtensionState {
  const servers = overrides.servers ?? [];
  const connections = overrides.connections ?? {};
  const failures = overrides.failures ?? {};
  const ui = "ui" in overrides ? overrides.ui ?? undefined : makeUi();

  return {
    manager: {
      getConnection: (name: string) => connections[name],
      getAllConnections: () => new Map(Object.entries(connections)),
    },
    config: {
      mcpServers: Object.fromEntries(servers.map((name) => [name, { command: "true" }])),
    },
    failureTracker: new Map(Object.entries(failures)),
    toolMetadata: new Map(),
    lifecycle: {} as any,
    uiResourceHandler: {} as any,
    consentManager: {} as any,
    uiServer: null,
    completedUiSessions: [],
    openBrowser: async () => {},
    ui: ui as any,
  } as unknown as McpExtensionState;
}

describe("updateStatusBar", () => {
  it("clears status when no servers are configured", () => {
    const ui = makeUi();
    updateStatusBar(makeState({ servers: [], ui }));
    expect(ui.setStatus).toHaveBeenCalledWith("mcp", undefined);
    expect(ui.theme.fg).not.toHaveBeenCalled();
  });

  it("stays silent for healthy idle lazy servers (0 connected, no errors)", () => {
    const ui = makeUi();
    updateStatusBar(makeState({ servers: ["figma", "playwright", "atlassian"], ui }));
    expect(ui.setStatus).toHaveBeenCalledWith("mcp", undefined);
    expect(ui.theme.fg).not.toHaveBeenCalled();
  });

  it("shows connected server names in dim (not a permanent inventory ratio)", () => {
    const ui = makeUi();
    updateStatusBar(
      makeState({
        servers: ["figma", "playwright", "atlassian"],
        connections: { playwright: { status: "connected" } },
        ui,
      }),
    );
    expect(ui.theme.fg).toHaveBeenCalledWith("dim", "MCP · playwright");
    expect(ui.setStatus).toHaveBeenCalledWith("mcp", "[dim]MCP · playwright");
  });

  it("shows multiple connected names, capped with +N", () => {
    const ui = makeUi();
    updateStatusBar(
      makeState({
        servers: ["a", "b", "c", "d", "e"],
        connections: {
          a: { status: "connected" },
          b: { status: "connected" },
          c: { status: "connected" },
          d: { status: "connected" },
        },
        ui,
      }),
    );
    expect(ui.theme.fg).toHaveBeenCalledWith("dim", "MCP · a, b, c +1");
  });

  it("surfaces needs-auth in warning color", () => {
    const ui = makeUi();
    updateStatusBar(
      makeState({
        servers: ["figma", "playwright"],
        connections: { figma: { status: "needs-auth" } },
        ui,
      }),
    );
    expect(ui.theme.fg).toHaveBeenCalledWith("warning", "MCP · auth: figma");
  });

  it("surfaces recent failures in error color", () => {
    const ui = makeUi();
    updateStatusBar(
      makeState({
        servers: ["playwright", "figma"],
        failures: { playwright: Date.now() },
        ui,
      }),
    );
    expect(ui.theme.fg).toHaveBeenCalledWith("error", "MCP · fail: playwright");
  });

  it("prioritizes fail > auth > connected and combines parts", () => {
    const ui = makeUi();
    updateStatusBar(
      makeState({
        servers: ["playwright", "figma", "atlassian"],
        connections: {
          figma: { status: "needs-auth" },
          atlassian: { status: "connected" },
        },
        failures: { playwright: Date.now() },
        ui,
      }),
    );
    expect(ui.theme.fg).toHaveBeenCalledWith(
      "error",
      "MCP · fail: playwright · auth: figma · atlassian",
    );
  });

  it("ignores expired failures (outside backoff window)", () => {
    const ui = makeUi();
    updateStatusBar(
      makeState({
        servers: ["playwright"],
        failures: { playwright: Date.now() - 120_000 },
        ui,
      }),
    );
    expect(ui.setStatus).toHaveBeenCalledWith("mcp", undefined);
  });

  it("is a no-op without UI", () => {
    expect(() =>
      updateStatusBar(
        makeState({
          servers: ["playwright"],
          connections: { playwright: { status: "connected" } },
          ui: null,
        }),
      ),
    ).not.toThrow();
  });
});
