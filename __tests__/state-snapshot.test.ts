import { describe, expect, it } from "vitest";

import { buildStateSnapshot } from "../init.ts";

function makeState(overrides: {
  connections: Record<string, { status: string } | undefined>;
  kinds: Record<string, "stdio" | "http" | "sse">;
  tools: Record<string, number>;
  failures?: Record<string, number>;
}) {
  return {
    config: {
      mcpServers: {
        local: { command: "demo" },
        remote: { url: "https://example.test/mcp" },
        cachedOnly: { command: "cached" },
        broken: { command: "broken" },
      },
    },
    manager: {
      getConnection: (name: string) => overrides.connections[name],
      getTransportKind: (name: string) => overrides.kinds[name],
    },
    toolMetadata: new Map(
      Object.entries(overrides.tools).map(([k, n]) => [k, Array.from({ length: n })]),
    ),
    failureTracker: new Map(Object.entries(overrides.failures ?? {})),
  } as any;
}

describe("buildStateSnapshot", () => {
  it("classifies each server after a multi-server connect", () => {
    const state = makeState({
      connections: {
        local: { status: "connected" },
        remote: { status: "needs-auth" },
        cachedOnly: undefined,
        broken: undefined,
      },
      kinds: { local: "stdio", remote: "http" },
      tools: { local: 4, cachedOnly: 9 },
      failures: { broken: Date.now() },
    });

    expect(buildStateSnapshot(state)).toEqual([
      { serverId: "local", transport: "stdio", status: "connected", toolCount: 4 },
      { serverId: "remote", transport: "http", status: "needs-auth", toolCount: 0 },
      { serverId: "cachedOnly", transport: "stdio", status: "cached", toolCount: 9 },
      { serverId: "broken", transport: "stdio", status: "failed", toolCount: 0 },
    ]);
  });

  it("falls back to disconnected with config-derived transport", () => {
    const state = makeState({
      connections: { local: undefined, remote: undefined, cachedOnly: undefined, broken: undefined },
      kinds: {},
      tools: {},
    });

    const snapshot = buildStateSnapshot(state);
    expect(snapshot.find((s) => s.serverId === "remote")).toEqual({
      serverId: "remote",
      transport: "http",
      status: "disconnected",
      toolCount: 0,
    });
    expect(snapshot.every((s) => s.status === "disconnected")).toBe(true);
  });
});
