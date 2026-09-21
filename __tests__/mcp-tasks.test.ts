import { describe, expect, it, vi } from "vitest";
import { ProtocolError, UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import type {
  Client,
  JSONRPCMessage,
  Transport,
} from "@modelcontextprotocol/client";
import {
  DispatchError,
  JsonRpcResponseError,
  TaskCancelledError,
  TaskFailedError,
  type TaskEnabledSession,
  type ToolExecution,
} from "@modelcontextprotocol/ext-tasks/client";
import {
  attachTaskSession,
  callToolViaTaskSession,
  RawRequestChannel,
  serverAdvertisesTasks,
} from "../mcp-tasks.ts";

type SentFrame = { message: JSONRPCMessage; options: Parameters<Transport["send"]>[1] };

function fakeTransport(): Transport & { sent: SentFrame[] } {
  const transport = {
    sent: [] as SentFrame[],
    onmessage: undefined as Transport["onmessage"],
    onclose: undefined as Transport["onclose"],
    onerror: undefined as Transport["onerror"],
    async start() {},
    async send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]) {
      transport.sent.push({ message, options });
    },
    async close() {},
  };
  return transport;
}

/** Simulates the SDK client having installed its handlers during connect. */
function connectedTransport(): { transport: Transport & { sent: SentFrame[] }; sdkReceived: JSONRPCMessage[]; sdkClosed: number[] } {
  const transport = fakeTransport();
  const sdkReceived: JSONRPCMessage[] = [];
  const sdkClosed: number[] = [];
  transport.onmessage = (message) => sdkReceived.push(message);
  transport.onclose = () => sdkClosed.push(1);
  return { transport, sdkReceived, sdkClosed };
}

function honorRequestSignalTeardown(transport: Transport & { sent: SentFrame[] }) {
  const streams = new Map<string, { open: boolean; signal: AbortSignal; onAbort: () => void }>();
  const originalSend = transport.send.bind(transport);
  transport.send = async (message, options) => {
    await originalSend(message, options);
    const id = "id" in message && typeof message.id === "string" ? message.id : undefined;
    const signal = options?.requestSignal;
    if (id === undefined || signal === undefined) return;
    const stream = { open: !signal.aborted, signal, onAbort: () => { stream.open = false; } };
    signal.addEventListener("abort", stream.onAbort, { once: true });
    streams.set(id, stream);
  };
  return {
    isOpen(id: string) {
      return streams.get(id)?.open === true;
    },
    signalFor(id: string) {
      return streams.get(id)?.signal;
    },
    deliver(message: JSONRPCMessage) {
      if (!("id" in message) || typeof message.id !== "string") return;
      const stream = streams.get(message.id);
      if (!stream?.open) return;
      transport.onmessage?.(message);
      stream.signal.removeEventListener("abort", stream.onAbort);
      streams.delete(message.id);
    },
  };
}

describe("RawRequestChannel", () => {
  it("resolves rawDispatch with a correlated result without forwarding it to the SDK handler", async () => {
    const { transport, sdkReceived } = connectedTransport();
    const channel = new RawRequestChannel(transport);
    channel.attach();

    const pending = channel.rawDispatch({ method: "tasks/get", params: { taskId: "t-1" } });
    const request = transport.sent[0]!.message as { id: string; method: string };
    expect(request.method).toBe("tasks/get");
    expect(request.id).toMatch(/^pi-mcp-tasks-/);

    transport.onmessage?.({
      jsonrpc: "2.0",
      id: request.id,
      result: { resultType: "complete", status: "working" },
    } as JSONRPCMessage);

    await expect(pending).resolves.toEqual({
      kind: "result",
      result: { resultType: "complete", status: "working" },
    });
    expect(sdkReceived).toHaveLength(0);
  });

  it("passes ext-tasks context headers (Mcp-Name) and the abort signal to transport.send", async () => {
    const { transport } = connectedTransport();
    const channel = new RawRequestChannel(transport);
    channel.attach();
    const controller = new AbortController();

    const pending = channel.rawDispatch(
      { method: "tasks/get", params: { taskId: "t-9" } },
      { signal: controller.signal, context: { headers: { "Mcp-Name": "t-9" } } },
    );
    const { message, options } = transport.sent[0]!;
    expect(options).toMatchObject({
      headers: { "Mcp-Name": "t-9" },
      requestSignal: controller.signal,
    });
    transport.onmessage?.({ jsonrpc: "2.0", id: (message as { id: string }).id, result: {} } as JSONRPCMessage);
    await pending;
  });

  it("preserves the SDK's handlers for non-task traffic and close signals", async () => {
    const { transport, sdkReceived, sdkClosed } = connectedTransport();
    const channel = new RawRequestChannel(transport);
    channel.attach();

    const sdkResponse = { jsonrpc: "2.0", id: 3, result: {} } as JSONRPCMessage;
    const notification = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, progressToken: "p" } } as JSONRPCMessage;
    transport.onmessage?.(sdkResponse);
    transport.onmessage?.(notification);
    expect(sdkReceived).toEqual([sdkResponse, notification]);

    const pending = channel.rawDispatch({ method: "tasks/get", params: { taskId: "t" } });
    transport.onclose?.();
    await expect(pending).rejects.toThrow(/connection closed/);
    expect(sdkClosed).toEqual([1]);
  });

  it("forwards method-bearing server requests even when their string ID uses the raw-request prefix", () => {
    const { transport, sdkReceived } = connectedTransport();
    const channel = new RawRequestChannel(transport);
    channel.attach();
    const serverRequest = {
      jsonrpc: "2.0",
      id: "pi-mcp-tasks-server-request",
      method: "elicitation/create",
      params: { message: "Choose", requestedSchema: { type: "object", properties: {} } },
    } as JSONRPCMessage;

    transport.onmessage?.(serverRequest);

    expect(sdkReceived).toEqual([serverRequest]);
  });

  it("resolves JSON-RPC error responses as error-kind results", async () => {
    const { transport } = connectedTransport();
    const channel = new RawRequestChannel(transport);
    channel.attach();
    const pending = channel.rawDispatch({ method: "tasks/get", params: { taskId: "missing" } });
    const request = transport.sent[0]!.message as { id: string };
    transport.onmessage?.({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: "Task not found" },
    } as JSONRPCMessage);
    await expect(pending).resolves.toEqual({
      kind: "error",
      error: { code: -32602, message: "Task not found" },
    });
  });

  it("rejects pending dispatches on abort and drops their late responses", async () => {
    const { transport, sdkReceived } = connectedTransport();
    const channel = new RawRequestChannel(transport);
    channel.attach();

    const controller = new AbortController();
    const pending = channel.rawDispatch(
      { method: "tasks/get", params: { taskId: "t-1" } },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow();

    // A late response to the aborted request is ours: dropped, not forwarded.
    const request = transport.sent[0]!.message as { id: string };
    transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result: {} } as JSONRPCMessage);
    expect(sdkReceived).toHaveLength(0);
  });

  it("cancels a task whose handle arrives after the tools/call was aborted", async () => {
    vi.useFakeTimers();
    try {
      const { transport, sdkReceived } = connectedTransport();
      const streams = honorRequestSignalTeardown(transport);
      const channel = new RawRequestChannel(transport);
      channel.attach();
      const controller = new AbortController();
      const pending = channel.rawDispatch(
        { method: "tools/call", params: { name: "slow_tool", arguments: {} } },
        { signal: controller.signal },
      );
      const callRequest = transport.sent[0]!.message as { id: string };

      controller.abort();
      await expect(pending).rejects.toThrow();
      const observationSignal = streams.signalFor(callRequest.id);
      expect(observationSignal).not.toBe(controller.signal);
      expect(streams.isOpen(callRequest.id)).toBe(true);
      streams.deliver({
        jsonrpc: "2.0",
        id: callRequest.id,
        result: { resultType: "task", taskId: "late-abort-task", status: "working" },
      } as JSONRPCMessage);
      expect(observationSignal?.aborted).toBe(true);

      const cancel = transport.sent[1]!;
      expect(cancel.message).toMatchObject({
        method: "tasks/cancel",
        params: { taskId: "late-abort-task" },
      });
      expect(cancel.options).toMatchObject({ headers: { "Mcp-Name": "late-abort-task" } });
      transport.onmessage?.({
        jsonrpc: "2.0",
        id: (cancel.message as { id: string }).id,
        result: { resultType: "complete" },
      } as JSONRPCMessage);
      expect(sdkReceived).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds how long an aborted tools/call is retained for a late task handle", async () => {
    vi.useFakeTimers();
    try {
      const { transport, sdkReceived } = connectedTransport();
      const streams = honorRequestSignalTeardown(transport);
      const channel = new RawRequestChannel(transport);
      channel.attach();
      const controller = new AbortController();
      const pending = channel.rawDispatch(
        { method: "tools/call", params: { name: "slow_tool", arguments: {} } },
        { signal: controller.signal },
      );
      const callRequest = transport.sent[0]!.message as { id: string };

      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(streams.isOpen(callRequest.id)).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(streams.isOpen(callRequest.id)).toBe(false);

      streams.deliver({
        jsonrpc: "2.0",
        id: callRequest.id,
        result: { resultType: "task", taskId: "expired-task", status: "working" },
      } as JSONRPCMessage);
      expect(transport.sent).toHaveLength(1);
      expect(sdkReceived).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a dispatch that never receives a response", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = connectedTransport();
      const channel = new RawRequestChannel(transport, 50);
      channel.attach();
      const pending = channel.rawDispatch({ method: "tasks/get", params: { taskId: "t" } });
      const assertion = expect(pending).rejects.toThrow(/timed out after 50ms/);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a task whose handle arrives after the tools/call timed out", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = connectedTransport();
      const streams = honorRequestSignalTeardown(transport);
      const channel = new RawRequestChannel(transport, 50);
      channel.attach();
      const pending = channel.rawDispatch({
        method: "tools/call",
        params: { name: "slow_tool", arguments: {} },
      });
      const callRequest = transport.sent[0]!.message as { id: string };
      const assertion = expect(pending).rejects.toThrow(/timed out after 50ms/);

      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(streams.isOpen(callRequest.id)).toBe(true);
      streams.deliver({
        jsonrpc: "2.0",
        id: callRequest.id,
        result: { resultType: "task", taskId: "late-timeout-task", status: "working" },
      } as JSONRPCMessage);

      const cancel = transport.sent[1]!;
      expect(cancel.message).toMatchObject({
        method: "tasks/cancel",
        params: { taskId: "late-timeout-task" },
      });
      expect(cancel.options).toMatchObject({ headers: { "Mcp-Name": "late-timeout-task" } });
      transport.onmessage?.({
        jsonrpc: "2.0",
        id: (cancel.message as { id: string }).id,
        result: { resultType: "complete" },
      } as JSONRPCMessage);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up the pending entry when send throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = connectedTransport();
      transport.send = () => {
        throw new Error("transport tore down");
      };
      const channel = new RawRequestChannel(transport, 60_000);
      channel.attach();
      await expect(channel.rawDispatch({ method: "tasks/get", params: { taskId: "t" } }))
        .rejects.toThrow("transport tore down");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

type FakeOutcome =
  | { status: "completed"; result: Record<string, unknown> }
  | { status: "failed"; error: TaskFailedError }
  | { status: "cancelled" };

function fakeExecution(outcome: FakeOutcome | Error, kind: "immediate" | "task" = "task") {
  const cancel = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const execution = {
    kind,
    handle: kind === "task" ? { taskId: "t-1", operation: "tools/call" } : undefined,
    cancel,
    close,
    async settle() {
      if (outcome instanceof Error) throw outcome;
      return { outcome, lastTask: undefined };
    },
  } as unknown as ToolExecution<Record<string, unknown>>;
  return { execution, cancel, close };
}

function fakeSession(execution: ToolExecution<Record<string, unknown>>) {
  const callTool = vi.fn(async () => execution);
  return { session: { callTool } as unknown as TaskEnabledSession, callTool };
}

describe("callToolViaTaskSession", () => {
  it("returns the completed result and closes the execution", async () => {
    const result = { content: [{ type: "text", text: "done" }], isError: false };
    const { execution, close } = fakeExecution({ status: "completed", result });
    const { session, callTool } = fakeSession(execution);

    await expect(callToolViaTaskSession(session, { name: "slow_tool", args: { a: 1 } }))
      .resolves.toEqual(result);
    expect(callTool).toHaveBeenCalledWith("slow_tool", { a: 1 }, {});
    expect(close).toHaveBeenCalled();
  });

  it("passes _meta through as request metadata", async () => {
    const { execution } = fakeExecution({ status: "completed", result: { content: [] } });
    const { session, callTool } = fakeSession(execution);
    await callToolViaTaskSession(session, { name: "t", args: {}, meta: { "io.example/ui": true } });
    expect(callTool).toHaveBeenCalledWith("t", {}, { metadata: { "io.example/ui": true } });
  });

  it("maps failed tasks to the typed ProtocolError for their code", async () => {
    const { execution } = fakeExecution({
      status: "failed",
      error: new TaskFailedError("rate limited", { code: -32001, data: { retryAfter: 5 } }),
    });
    const { session } = fakeSession(execution);
    const pending = callToolViaTaskSession(session, { name: "t", args: {} });
    await expect(pending).rejects.toThrow("rate limited");
    await pending.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(-32001);
      expect((error as ProtocolError).data).toEqual({ retryAfter: 5 });
    });
  });

  it("maps a -32042 failure to UrlElicitationRequiredError so the call-site branch fires", async () => {
    const elicitation = {
      mode: "url",
      elicitationId: "e-1",
      url: "https://example.com/verify",
      message: "Verify to continue",
    };
    const { execution } = fakeExecution(
      new JsonRpcResponseError({
        code: -32042,
        message: "URL elicitation required",
        data: { elicitations: [elicitation] },
      }),
    );
    const { session } = fakeSession(execution);
    await expect(callToolViaTaskSession(session, { name: "t", args: {} }))
      .rejects.toBeInstanceOf(UrlElicitationRequiredError);
  });

  it("unwraps DispatchError to its cause so session recovery can classify transport failures", async () => {
    const httpError = Object.assign(new Error("HTTP 404"), { status: 404 });
    const { execution } = fakeExecution(
      new DispatchError("MCP client request failed", true, { cause: httpError }),
    );
    const { session } = fakeSession(execution);
    await expect(callToolViaTaskSession(session, { name: "t", args: {} }))
      .rejects.toBe(httpError);
  });

  it("rethrows codeless local failures without relabeling them as server errors", async () => {
    const local = new TaskFailedError("underlying connection dropped");
    const { execution } = fakeExecution({ status: "failed", error: local });
    const { session } = fakeSession(execution);
    await expect(callToolViaTaskSession(session, { name: "t", args: {} }))
      .rejects.toBe(local);
  });

  it("cancels the remote task when the signal aborts and rethrows the abort", async () => {
    // Settlement hangs like a real in-flight task until cancel() lands.
    let rejectSettle: (error: Error) => void;
    const settled = new Promise<never>((_, reject) => { rejectSettle = reject; });
    const cancel = vi.fn(async () => rejectSettle(new TaskCancelledError()));
    const close = vi.fn(async () => {});
    const execution = {
      kind: "task",
      handle: { taskId: "t-1", operation: "tools/call" },
      cancel,
      close,
      settle: () => settled,
    } as unknown as ToolExecution<Record<string, unknown>>;
    const { session } = fakeSession(execution);
    const controller = new AbortController();
    const pending = callToolViaTaskSession(session, { name: "t", args: {}, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("cancels the remote task when the signal aborted while callTool was resolving", async () => {
    const { execution, cancel } = fakeExecution(new TaskCancelledError());
    const { session } = fakeSession(execution);
    const controller = new AbortController();
    controller.abort();
    await expect(callToolViaTaskSession(session, { name: "t", args: {}, signal: controller.signal }))
      .rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });

  it("does not register a cancel hook for immediate results", async () => {
    const { execution, cancel } = fakeExecution(
      { status: "completed", result: { content: [] } },
      "immediate",
    );
    const { session } = fakeSession(execution);
    const controller = new AbortController();
    await callToolViaTaskSession(session, { name: "t", args: {}, signal: controller.signal });
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
  });
});

interface FakeTaskServer {
  polls: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  headersByMethod: Map<string, Record<string, string> | undefined>;
}

/**
 * Fake modern-era client + scripted server speaking the ext-tasks V2 wire
 * shapes through a real RawRequestChannel attached to a connected transport.
 * tools/call answers with a CreateTaskResult and tasks/get walks the given
 * status sequence.
 */
function fakeModernTaskStack(script: { statuses: Array<Record<string, unknown>> }): {
  client: Client;
  transport: Transport;
  server: FakeTaskServer;
} {
  const server: FakeTaskServer = { polls: [], updates: [], headersByMethod: new Map() };
  const task = {
    taskId: "task-e2e-1",
    createdAt: "2026-09-17T00:00:00Z",
    lastUpdatedAt: "2026-09-17T00:00:00Z",
    ttlMs: 60_000,
    pollIntervalMs: 1,
  };
  let pollIndex = 0;
  const transport = fakeTransport();
  transport.onmessage = () => {}; // the "SDK handler" installed at connect
  const originalSend = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]) => {
    await originalSend(message, options);
    const frame = message as { id?: string | number; method?: string; params?: Record<string, unknown> };
    if (frame.id === undefined || frame.method === undefined) return;
    server.headersByMethod.set(frame.method, (options as { headers?: Record<string, string> } | undefined)?.headers);
    const respond = (result: Record<string, unknown>) => {
      queueMicrotask(() => {
        transport.onmessage?.({ jsonrpc: "2.0", id: frame.id, result } as JSONRPCMessage);
      });
    };
    if (frame.method === "tools/call") {
      respond({ resultType: "task", status: "working", ...task });
    } else if (frame.method === "tasks/get") {
      server.polls.push(frame.params ?? {});
      const status = script.statuses[Math.min(pollIndex, script.statuses.length - 1)]!;
      pollIndex += 1;
      respond({ resultType: "complete", ...task, ...status });
    } else if (frame.method === "tasks/update") {
      server.updates.push(frame.params ?? {});
      respond({ resultType: "complete" });
    } else if (frame.method === "tasks/cancel") {
      respond({ resultType: "complete" });
    }
  };
  const client = {
    request: async () => ({}),
    getProtocolEra: () => "modern" as const,
    getNegotiatedProtocolVersion: () => "2026-07-28",
    getServerCapabilities: () => ({
      tools: {},
      extensions: { "io.modelcontextprotocol/tasks": {} },
    }),
    fallbackRequestHandler: undefined,
    fallbackNotificationHandler: undefined,
    onclose: undefined,
  } as unknown as Client;
  return { client, transport, server };
}

describe("attachTaskSession", () => {
  const definition = { command: "fake-server", tasks: true };
  const clientInfo = { name: "pi-mcp-test", version: "1.0.0" };
  const clientCapabilities = { elicitation: { form: {} } };

  it("returns undefined when the server does not advertise tasks", async () => {
    const client = {
      getProtocolEra: () => "modern" as const,
      getServerCapabilities: () => ({ tools: {} }),
    } as unknown as Client;
    expect(serverAdvertisesTasks(client)).toBe(false);
    const attachment = await attachTaskSession({
      client,
      serverName: "plain",
      definition,
      transport: fakeTransport(),
      clientInfo,
      clientCapabilities,
    });
    expect(attachment).toBeUndefined();
  });

  it("requires the exact empty-object extension declaration and the modern era", () => {
    const nonEmpty = {
      getProtocolEra: () => "modern" as const,
      getServerCapabilities: () => ({ extensions: { "io.modelcontextprotocol/tasks": { experimental: true } } }),
    } as unknown as Client;
    const legacy = {
      getProtocolEra: () => "legacy" as const,
      getServerCapabilities: () => ({ tasks: { requests: { "tools/call": {} } } }),
    } as unknown as Client;
    const modern = {
      getProtocolEra: () => "modern" as const,
      getServerCapabilities: () => ({ extensions: { "io.modelcontextprotocol/tasks": {} } }),
    } as unknown as Client;
    expect(serverAdvertisesTasks(nonEmpty)).toBe(false);
    expect(serverAdvertisesTasks(legacy)).toBe(false);
    expect(serverAdvertisesTasks(modern)).toBe(true);
  });

  it("drives a v2 task to completion and stamps Mcp-Name on task requests", async () => {
    const finalResult = { resultType: "complete", content: [{ type: "text", text: "task done" }], isError: false };
    const { client, transport, server } = fakeModernTaskStack({
      statuses: [
        { status: "working" },
        { status: "completed", result: finalResult },
      ],
    });
    const attachment = await attachTaskSession({
      client,
      serverName: "task-server",
      definition,
      transport,
      clientInfo,
      clientCapabilities,
    });
    expect(attachment).toBeDefined();
    try {
      const result = await callToolViaTaskSession(attachment!.session, { name: "slow_tool", args: { input: "x" } });
      expect(result).toEqual({ content: [{ type: "text", text: "task done" }], isError: false });
      expect(server.polls.length).toBeGreaterThanOrEqual(1);
      expect(server.polls[0]).toMatchObject({ taskId: "task-e2e-1" });
      // SEP-2663 Streamable HTTP binding: Mcp-Name mirrors params.taskId.
      expect(server.headersByMethod.get("tasks/get")).toMatchObject({ "Mcp-Name": "task-e2e-1" });
    } finally {
      await attachment!.session.close();
    }
  });

  it("routes task-time elicitation through the handler and answers via tasks/update", async () => {
    const finalResult = { resultType: "complete", content: [{ type: "text", text: "hello Luca" }], isError: false };
    const { client, transport, server } = fakeModernTaskStack({
      statuses: [
        {
          status: "input_required",
          inputRequests: {
            name: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Please enter your name.",
                requestedSchema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              },
            },
          },
        },
        { status: "completed", result: finalResult },
      ],
    });
    const onElicitation = vi.fn(async () => ({
      action: "accept" as const,
      content: { name: "Luca" },
    }));
    const attachment = await attachTaskSession({
      client,
      serverName: "task-server",
      definition,
      transport,
      clientInfo,
      clientCapabilities,
      onElicitation,
    });
    expect(attachment).toBeDefined();
    try {
      const result = await callToolViaTaskSession(attachment!.session, { name: "hello_world", args: {} });
      expect(result).toEqual({ content: [{ type: "text", text: "hello Luca" }], isError: false });
      expect(onElicitation).toHaveBeenCalledTimes(1);
      expect(server.updates).toHaveLength(1);
      expect(server.updates[0]).toMatchObject({
        taskId: "task-e2e-1",
        inputResponses: { name: { action: "accept", content: { name: "Luca" } } },
      });
      expect(server.headersByMethod.get("tasks/update")).toMatchObject({ "Mcp-Name": "task-e2e-1" });
    } finally {
      await attachment!.session.close();
    }
  });

  it("surfaces a failed task as a typed ProtocolError", async () => {
    const { client, transport } = fakeModernTaskStack({
      statuses: [
        {
          status: "failed",
          error: { code: -32603, message: "API rate limit exceeded" },
        },
      ],
    });
    const attachment = await attachTaskSession({
      client,
      serverName: "task-server",
      definition,
      transport,
      clientInfo,
      clientCapabilities,
    });
    try {
      const pending = callToolViaTaskSession(attachment!.session, { name: "slow_tool", args: {} });
      await expect(pending).rejects.toThrow(/rate limit/i);
      await pending.catch((error: unknown) => {
        expect(error).toBeInstanceOf(ProtocolError);
        expect((error as ProtocolError).code).toBe(-32603);
      });
    } finally {
      await attachment!.session.close();
    }
  });
});
