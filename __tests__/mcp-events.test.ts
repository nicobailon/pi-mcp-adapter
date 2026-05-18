import { describe, expect, it, vi } from "vitest";

import {
  McpEventBus,
  MCP_EVENT_CHANNELS,
  MCP_STATE_ENTRY_TYPE,
  MCP_TOOL_NAMES_LIMIT,
  NOOP_EVENT_BUS,
  toEventError,
  type McpEventSink,
} from "../mcp-events.ts";

type Emitted = { channel: string; data: any };

function createSpySink() {
  const emitted: Emitted[] = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const sink: McpEventSink & { emitted: Emitted[]; entries: typeof entries } = {
    emitted,
    entries,
    emit(channel, data) {
      emitted.push({ channel, data });
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
  };
  return sink;
}

describe("McpEventBus", () => {
  it("emits a versioned envelope on mcp:server", () => {
    const sink = createSpySink();
    const bus = new McpEventBus(sink, () => 1234);

    bus.emitServer("github", "stdio", "connecting");

    expect(sink.emitted).toEqual([
      {
        channel: MCP_EVENT_CHANNELS.server,
        data: { v: 1, serverId: "github", transport: "stdio", at: 1234, phase: "connecting" },
      },
    ]);
  });

  it("attaches error only when provided", () => {
    const sink = createSpySink();
    const bus = new McpEventBus(sink, () => 1);

    bus.emitServer("s", "http", "errored", { message: "boom", code: "ECONN" });

    expect(sink.emitted[0].data).toMatchObject({
      phase: "errored",
      error: { message: "boom", code: "ECONN" },
    });
  });

  it("bounds mcp:tools.toolNames and keeps the count", () => {
    const sink = createSpySink();
    const bus = new McpEventBus(sink, () => 0);

    bus.emitTools("s", "http", 3, "connect", ["a", "b", "c"]);
    expect(sink.emitted[0].data).toMatchObject({
      toolCount: 3,
      source: "connect",
      toolNames: ["a", "b", "c"],
    });

    const many = Array.from({ length: MCP_TOOL_NAMES_LIMIT + 1 }, (_, i) => `t${i}`);
    bus.emitTools("s", "http", many.length, "refresh", many);
    expect(sink.emitted[1].data.toolCount).toBe(many.length);
    expect(sink.emitted[1].data.toolNames).toBeUndefined();
  });

  it("carries authorizationUrl only on the interactive auth_required phase", () => {
    const sink = createSpySink();
    const bus = new McpEventBus(sink, () => 0);

    bus.emitAuth("s", "http", "auth_required", { authorizationUrl: "https://idp/authorize" });
    bus.emitAuth("s", "http", "auth_succeeded", { authorizationUrl: "https://idp/authorize" });
    bus.emitAuth("s", "http", "auth_failed", { error: { message: "denied" } });

    expect(sink.emitted[0].data.authorizationUrl).toBe("https://idp/authorize");
    expect(sink.emitted[1].data.authorizationUrl).toBeUndefined();
    expect(sink.emitted[2].data).toMatchObject({ phase: "auth_failed", error: { message: "denied" } });
  });

  it("is a no-op without a sink (the default the manager holds)", () => {
    expect(() => NOOP_EVENT_BUS.emitServer("s", "stdio", "connected")).not.toThrow();
  });

  it("never lets a faulty sink wedge the caller", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bus = new McpEventBus({
        emit() {
          throw new Error("subscriber blew up");
        },
      });
      expect(() => bus.emitServer("s", "stdio", "connected")).not.toThrow();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("mirrors a durable mcp:state snapshot on each transition when a provider is set", () => {
    const sink = createSpySink();
    const bus = new McpEventBus(sink, () => 7);
    bus.setSnapshotProvider(() => [
      { serverId: "s", transport: "stdio", status: "connected", toolCount: 2 },
    ]);

    bus.emitServer("s", "stdio", "connected");

    expect(sink.entries).toEqual([
      {
        customType: MCP_STATE_ENTRY_TYPE,
        data: {
          v: 1,
          at: 7,
          servers: [{ serverId: "s", transport: "stdio", status: "connected", toolCount: 2 }],
        },
      },
    ]);
  });

  it("does not mirror when the sink cannot append entries", () => {
    const emitted: Emitted[] = [];
    const bus = new McpEventBus({ emit: (channel, data) => emitted.push({ channel, data }) });
    bus.setSnapshotProvider(() => []);
    expect(() => bus.emitServer("s", "stdio", "connected")).not.toThrow();
    expect(emitted).toHaveLength(1);
  });

  it("normalizes thrown values via toEventError", () => {
    const withCode = Object.assign(new Error("nope"), { code: "EBADF" });
    expect(toEventError(withCode)).toEqual({ message: "nope", code: "EBADF" });
    expect(toEventError(new Error("plain"))).toEqual({ message: "plain" });
    expect(toEventError("string error")).toEqual({ message: "string error" });
  });
});
