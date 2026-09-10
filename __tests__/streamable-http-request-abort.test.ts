import { describe, expect, it, vi } from "vitest";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { StreamableHttpRequestAbortTransport } from "../streamable-http-request-abort.ts";

type SendOptions = Parameters<Transport["send"]>[1];

function request(id: number): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "slow", arguments: {} } };
}

function cancelled(id: number): JSONRPCMessage {
  return { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } };
}

function createBase(send = vi.fn(async (_message: JSONRPCMessage, _options?: SendOptions) => {})): Transport & { send: typeof send } {
  return {
    send,
    start: vi.fn(async () => {}),
    hasPerRequestStream: true,
    close: vi.fn(async () => {}),
    sessionId: "session-1",
    setProtocolVersion: vi.fn(),
    setSupportedProtocolVersions: vi.fn(),
  };
}

describe("StreamableHttpRequestAbortTransport", () => {
  it.each([undefined, false])("rejects a base transport with hasPerRequestStream=%s", hasPerRequestStream => {
    const base = createBase();
    base.hasPerRequestStream = hasPerRequestStream;

    expect(() => new StreamableHttpRequestAbortTransport(base)).toThrow(
      "StreamableHttpRequestAbortTransport requires a per-request stream transport",
    );
  });

  it("forwards a supplied modern request signal unchanged", async () => {
    const base = createBase();
    const transport = new StreamableHttpRequestAbortTransport(base);
    const signal = new AbortController().signal;

    await transport.send(request(1), { requestSignal: signal });

    expect(base.send).toHaveBeenCalledWith(request(1), { requestSignal: signal });
    expect(base.send.mock.calls[0]?.[1]?.requestSignal).toBe(signal);
  });

  it("aborts only the matching legacy request and still forwards cancellation", async () => {
    const base = createBase();
    const transport = new StreamableHttpRequestAbortTransport(base);

    await transport.send(request(1));
    await transport.send(request(2));
    const firstSignal = base.send.mock.calls[0]?.[1]?.requestSignal;
    const secondSignal = base.send.mock.calls[1]?.[1]?.requestSignal;
    await transport.send(cancelled(1));

    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);
    expect(base.send).toHaveBeenLastCalledWith(cancelled(1), undefined);
  });

  it("cleans active signals on response, stream end, send rejection, base close, and close", async () => {
    const rejectSend = vi.fn(async (message: JSONRPCMessage, _options?: SendOptions) => {
      if ("id" in message && message.id === 3) throw new Error("send failed");
    });
    const base = createBase(rejectSend);
    const transport = new StreamableHttpRequestAbortTransport(base);
    const onclose = vi.fn();
    transport.onclose = onclose;

    await transport.send(request(1));
    const responseSignal = rejectSend.mock.calls[0]?.[1]?.requestSignal;
    base.onmessage?.({ jsonrpc: "2.0", id: 1, result: {} });
    await transport.send(cancelled(1));
    expect(responseSignal?.aborted).toBe(false);

    await transport.send(request(2));
    const streamSignal = rejectSend.mock.calls[2]?.[1]?.requestSignal;
    rejectSend.mock.calls[2]?.[1]?.onRequestStreamEnd?.();
    await transport.send(cancelled(2));
    expect(streamSignal?.aborted).toBe(false);

    await expect(transport.send(request(3))).rejects.toThrow("send failed");
    const rejectedSignal = rejectSend.mock.calls[4]?.[1]?.requestSignal;
    await transport.send(cancelled(3));
    expect(rejectedSignal?.aborted).toBe(false);

    await transport.send(request(4));
    const baseCloseSignal = rejectSend.mock.calls[6]?.[1]?.requestSignal;
    base.onclose?.();
    expect(baseCloseSignal?.aborted).toBe(true);
    expect(onclose).toHaveBeenCalledOnce();

    await transport.send(request(5));
    const closeSignal = rejectSend.mock.calls[7]?.[1]?.requestSignal;
    await transport.close();
    expect(closeSignal?.aborted).toBe(true);
    expect(base.close).toHaveBeenCalledOnce();
    expect(transport.sessionId).toBe("session-1");
  });
});
