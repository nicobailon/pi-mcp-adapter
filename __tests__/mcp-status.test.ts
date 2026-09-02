import { describe, expect, it, vi } from "vitest";
import {
  MCP_STATUS_EVENT,
  createMcpStatusSnapshot,
  publishMcpStatusShutdown,
  publishMcpStatusSnapshot,
} from "../mcp-status.ts";
import { executeStatus } from "../proxy-modes.ts";

function createState() {
  const manager = {
    getConnection: vi.fn(),
  };
  return {
    config: {
      mcpServers: {
        connected: { command: "node", headers: { Authorization: "secret" } },
        cached: { command: "node" },
        failed: { command: "node" },
        auth: { url: "https://example.invalid" },
        idle: { command: "node" },
        disabled: { command: "node", disabled: true },
      },
    },
    manager,
    toolMetadata: new Map([
      ["connected", [{ name: "search" }]],
      ["cached", [{ name: "cached_search" }, { name: "read_doc" }]],
      ["failed", [{ name: "failed_search" }, { name: "failed_read" }]],
      ["idle", [{ name: "old_search" }]],
    ]),
    directToolCounts: new Map([
      ["connected", 1],
      ["cached", 2],
      ["failed", 0],
      ["idle", 1],
      ["disabled", 3],
    ]),
    resourceCounts: new Map([["connected", 2], ["cached", 1]]),
    failureTracker: new Map([["failed", Date.now() - 4_000]]),
    statusEvents: undefined,
  } as any;
}

describe("MCP status snapshots", () => {
  it("projects every status without connecting or exposing configuration", () => {
    const state = createState();
    state.manager.getConnection.mockImplementation((name: string) => {
      if (name === "connected") {
        return {
          status: "connected",
          listenState: "active",
          tools: [{ name: "search" }],
          resources: [{ name: "doc", uri: "file://doc" }, { name: "other", uri: "file://other" }],
          client: { secret: true },
          transport: { secret: true },
        };
      }
      if (name === "auth") return { status: "needs-auth", tools: [], resources: [] };
      return undefined;
    });

    const snapshot = createMcpStatusSnapshot(state);
    expect(snapshot).toMatchObject({
      version: 1,
      totalTools: 4,
      totalResources: 3,
      connectedCount: 1,
      disabledCount: 1,
    });
    expect(snapshot.servers).toEqual(expect.arrayContaining([
      { name: "connected", status: "connected", listenState: "active", toolCount: 1, directToolCount: 1, resourceCount: 2, disabled: false },
      { name: "cached", status: "cached", listenState: "disconnected", toolCount: 2, directToolCount: 2, resourceCount: 1, disabled: false },
      expect.objectContaining({ name: "failed", status: "failed", toolCount: 0, directToolCount: 0, disabled: false }),
      { name: "auth", status: "needs-auth", listenState: "disconnected", toolCount: 0, directToolCount: 0, disabled: false },
      { name: "idle", status: "cached", listenState: "disconnected", toolCount: 1, directToolCount: 1, disabled: false },
      { name: "disabled", status: "disabled", listenState: "disconnected", toolCount: 0, directToolCount: 0, disabled: true },
    ]));
    const failed = snapshot.servers.find(server => server.name === "failed");
    expect(failed?.failedAgoSeconds).toBeGreaterThanOrEqual(4);
    expect(failed?.failedAgoSeconds).toBeLessThanOrEqual(5);
    expect(state.manager.getConnection).toHaveBeenCalled();
    expect(snapshot).not.toHaveProperty("client");
    expect(snapshot).not.toHaveProperty("transport");
    expect(snapshot).not.toHaveProperty("config");
  });

  it("keeps needs-auth status out of failure backoff even with a fresh failure entry", () => {
    const state = createState();
    state.failureTracker.set("auth", Date.now());
    state.manager.getConnection.mockImplementation((name: string) => name === "auth"
      ? { status: "needs-auth", tools: [], resources: [] }
      : undefined);

    const snapshot = createMcpStatusSnapshot(state);

    expect(snapshot.servers.find(server => server.name === "auth")).toMatchObject({
      name: "auth",
      status: "needs-auth",
      toolCount: 0,
      directToolCount: 0,
    });
  });

  it("reports retained direct registrations during frozen failure backoff", () => {
    const state = createState();
    state.directToolCounts.set("failed", 2);

    const snapshot = createMcpStatusSnapshot(state);

    expect(snapshot.servers.find(server => server.name === "failed")).toMatchObject({
      status: "failed",
      directToolCount: 2,
    });
  });

  it("reports a dropped listen separately from a connected transport", () => {
    const state = createState();
    state.manager.getConnection.mockImplementation((name: string) => name === "connected"
      ? { status: "connected", listenState: "dropped", tools: [{ name: "search" }], resources: [] }
      : undefined);

    expect(createMcpStatusSnapshot(state).servers.find(server => server.name === "connected")).toMatchObject({
      status: "connected",
      listenState: "dropped",
    });
    expect(executeStatus(state).content[0]?.text).toContain(
      "catalog may be stale; will reconcile on next keep-alive or tool use",
    );
  });

  it("reports an active listen with unconfirmed catalog freshness", () => {
    const state = createState();
    state.manager.getConnection.mockImplementation((name: string) => name === "connected"
      ? { status: "connected", listenState: "active", listenCatalogStale: true, tools: [{ name: "search" }], resources: [] }
      : undefined);

    expect(createMcpStatusSnapshot(state).servers.find(server => server.name === "connected")).toMatchObject({
      status: "connected",
      listenState: "active",
      catalogStale: true,
    });
    expect(executeStatus(state).content[0]?.text).toContain("listen active, catalog may be stale");
  });

  it("keeps proxy status and shared snapshots in parity for cached failure states", () => {
    const state = createState();
    state.manager.getConnection.mockImplementation((name: string) => {
      if (name === "connected") return { status: "connected", tools: [{ name: "search" }], resources: [] };
      if (name === "auth") return { status: "needs-auth", tools: [], resources: [] };
      return undefined;
    });

    const snapshot = createMcpStatusSnapshot(state);
    const proxy = executeStatus(state).details as { servers: Array<{ name: string; status: string; toolCount: number }> };

    for (const server of snapshot.servers) {
      const proxyServer = proxy.servers.find(candidate => candidate.name === server.name);
      expect(proxyServer).toBeDefined();
      expect(proxyServer).toMatchObject({
        name: server.name,
        status: server.status === "not-connected" ? "not connected" : server.status,
        toolCount: server.toolCount,
      });
    }
  });

  it("publishes an empty snapshot at shutdown", () => {
    const emit = vi.fn();
    publishMcpStatusShutdown({ emit });

    expect(emit).toHaveBeenCalledWith(MCP_STATUS_EVENT, {
      version: 1,
      servers: [],
      totalTools: 0,
      totalResources: 0,
      connectedCount: 0,
      disabledCount: 0,
    });
  });

  it("publishes fresh snapshots and isolates event listener failures", () => {
    const state = createState();
    const emitted: unknown[] = [];
    state.statusEvents = {
      emit: vi.fn((_channel: string, payload: unknown) => {
        emitted.push(payload);
        throw new Error("consumer failed");
      }),
    };

    expect(() => publishMcpStatusSnapshot(state)).not.toThrow();
    publishMcpStatusSnapshot(state);
    expect(state.statusEvents.emit).toHaveBeenCalledWith(MCP_STATUS_EVENT, emitted[0]);
    expect(emitted[0]).not.toBe(emitted[1]);
    expect(emitted[0].servers).not.toBe(emitted[1].servers);
  });
});
