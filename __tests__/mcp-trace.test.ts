import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/client";
import {
  createMcpTraceEvent,
  isMcpTraceEnabled,
  McpTraceWriter,
  wrapTransportWithMcpTrace,
} from "../mcp-trace.ts";

function fakeTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    start: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  } as Transport;
}

describe("MCP protocol tracing", () => {
  it("is disabled unless global or per-server tracing is explicitly enabled", () => {
    expect(isMcpTraceEnabled({}, undefined)).toBe(false);
    expect(isMcpTraceEnabled({ debug: true }, undefined)).toBe(false);
    expect(isMcpTraceEnabled({ trace: false }, { enabled: true })).toBe(false);
    expect(isMcpTraceEnabled({}, { enabled: true })).toBe(true);
    expect(isMcpTraceEnabled({ trace: true }, undefined)).toBe(true);
  });

  it("writes a metadata-only event with redacted identifiers and no payload", () => {
    const event = createMcpTraceEvent(
      "outbound",
      "server https://user:secret@example.test/mcp",
      "streamable-http",
      {
        jsonrpc: "2.0",
        id: "request-secret-token",
        method: "tools/call",
        params: { name: "private", arguments: { token: "do-not-write" } },
      },
      "sent",
    );

    expect(event).toMatchObject({
      version: 1,
      direction: "outbound",
      transport: "streamable-http",
      kind: "request",
      method: "tools/call",
      status: "sent",
    });
    expect(JSON.stringify(event)).not.toContain("do-not-write");
    expect(JSON.stringify(event)).not.toContain("example.test");
    expect(JSON.stringify(event)).not.toContain("request-secret-token");
    expect(event).not.toHaveProperty("params");

    const sensitiveMetadata = createMcpTraceEvent(
      "inbound",
      "server ftp://example.test/mcp file:///private/path",
      "streamable-http",
      { jsonrpc: "2.0", id: "opaque-sensitive-id", result: {} },
      "received",
      { relatedRequestId: "request-without-a-keyword" },
    );
    expect(sensitiveMetadata.id).toBe("[REDACTED_ID]");
    expect(sensitiveMetadata.relatedRequestId).toBe("[REDACTED_ID]");
    expect(JSON.stringify(sensitiveMetadata)).not.toContain("example.test");
    expect(JSON.stringify(sensitiveMetadata)).not.toContain("private/path");
  });

  it("resets a reused destination before appending new events", async () => {
    const operations: string[] = [];
    const writer = new McpTraceWriter({
      filePath: "/tmp/mcp-trace.jsonl",
      writeFile: vi.fn(async () => { operations.push("reset"); }),
      appendFile: vi.fn(async () => { operations.push("append"); }),
      mkdir: vi.fn(async () => undefined),
    });
    writer.write(createMcpTraceEvent("inbound", "s", "stdio", {
      jsonrpc: "2.0",
      method: "notifications/ping",
      params: {},
    }, "received"));
    await writer.flush();
    expect(operations).toEqual(["reset", "append"]);
  });

  it("bounds metadata strings and rejects events over the file limit", async () => {
    const append = vi.fn(async () => undefined);
    const writer = new McpTraceWriter({
      filePath: "/tmp/mcp-trace.jsonl",
      maxBytes: 20,
      maxEvents: 2,
      appendFile: append,
      mkdir: vi.fn(async () => undefined),
    });
    writer.write(createMcpTraceEvent("inbound", "s", "stdio", {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {},
    }, "received"));
    await writer.flush();
    expect(append).not.toHaveBeenCalled();
    expect(writer.stats.events).toBe(0);
    expect(writer.isDisabled).toBe(true);
  });

  it("isolates writer failures and preserves send/onmessage callbacks", async () => {
    const append = vi.fn(async () => { throw new Error("disk full"); });
    const writer = new McpTraceWriter({
      filePath: "/tmp/mcp-trace.jsonl",
      appendFile: append,
      mkdir: vi.fn(async () => undefined),
    });
    const incoming = vi.fn();
    const sent = vi.fn(async () => undefined);
    const underlying = fakeTransport({ send: sent });
    const wrapped = wrapTransportWithMcpTrace(underlying, "demo", "stdio", {
      record: event => writer.write(event),
    });
    expect(wrapped).toBe(underlying);
    wrapped.onmessage = incoming;
    underlying.onmessage?.({ jsonrpc: "2.0", method: "notifications/ping", params: {} });
    await wrapped.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    await writer.flush();

    expect(incoming).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledOnce();
    expect(writer.isDisabled).toBe(true);
  });

  it("does not let a throwing observer break transport callbacks", async () => {
    const underlying = fakeTransport();
    const observer = { record: () => { throw new Error("trace failure"); } };
    const wrapped = wrapTransportWithMcpTrace(underlying, "demo", "stdio", observer);
    const incoming = vi.fn();
    wrapped.onmessage = incoming;
    underlying.onmessage?.({ jsonrpc: "2.0", method: "notifications/ping", params: {} });
    await wrapped.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    expect(incoming).toHaveBeenCalledOnce();
  });

  it("keeps transport behavior when onmessage cannot be redefined", async () => {
    const sent = vi.fn(async () => undefined);
    const underlying = fakeTransport({ send: sent });
    Object.defineProperty(underlying, "onmessage", {
      value: undefined,
      writable: true,
      configurable: false,
    });

    const wrapped = wrapTransportWithMcpTrace(underlying, "demo", "stdio", { record: vi.fn() });

    expect(wrapped).toBe(underlying);
    await wrapped.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    expect(sent).toHaveBeenCalledOnce();
  });
});
