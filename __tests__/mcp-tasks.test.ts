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
  TaskExecutionClosedError,
  TaskFailedError,
  type TaskEnabledSession,
  type ToolExecution,
} from "@modelcontextprotocol/ext-tasks/client";
import {
  attachTaskSession,
  callToolViaTaskSession,
  RawRequestChannel,
  serverAdvertisesTasks,
  startToolViaTaskSession,
} from "../mcp-tasks.ts";
import { BackgroundTaskRegistry, type HandedOffTask } from "../task-jobs.ts";

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
  cancels: Record<string, unknown>[];
  headersByMethod: Map<string, Record<string, string> | undefined>;
}

/**
 * Fake modern-era client + scripted server speaking the ext-tasks V2 wire
 * shapes through a real RawRequestChannel attached to a connected transport.
 * tools/call answers with a CreateTaskResult and tasks/get walks the given
 * status sequence. Stacks given the same `server` act as two connections to one server;
 * each cancel it records names the `connection` that sent it. `forgetsTasks` answers
 * tasks/get with -32602, as a server does for a task id it doesn't know. `beforePoll`
 * holds each tasks/get answer until the promise it returns resolves.
 */
function fakeModernTaskStack(
  script: { statuses: Array<Record<string, unknown>>; forgetsTasks?: boolean; beforePoll?: () => Promise<void> },
  server: FakeTaskServer = { polls: [], updates: [], cancels: [], headersByMethod: new Map() },
  connection = "first",
): {
  client: Client;
  transport: Transport;
  server: FakeTaskServer;
} {
  const task = {
    taskId: "task-e2e-1",
    createdAt: "2026-09-17T00:00:00Z",
    lastUpdatedAt: "2026-09-17T00:00:00Z",
    ttlMs: 60_000,
    pollIntervalMs: 1,
  };
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
      const answer = () => {
        if (script.forgetsTasks) {
          queueMicrotask(() => {
            transport.onmessage?.({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: "Unknown task" } } as JSONRPCMessage);
          });
          return;
        }
        const status = script.statuses[Math.min(server.polls.length, script.statuses.length - 1)]!;
        server.polls.push(frame.params ?? {});
        respond({ resultType: "complete", ...task, ...status });
      };
      if (script.beforePoll) void script.beforePoll().then(answer);
      else answer();
    } else if (frame.method === "tasks/update") {
      server.updates.push(frame.params ?? {});
      respond({ resultType: "complete" });
    } else if (frame.method === "tasks/cancel") {
      server.cancels.push({ connection, taskId: frame.params?.taskId });
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

  it("ends a blocking call's task sampling when the call is aborted", async () => {
    const { client, transport } = fakeModernTaskStack({
      statuses: [{
        status: "input_required",
        inputRequests: {
          reply: {
            method: "sampling/createMessage",
            params: { messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 10 },
          },
        },
      }],
    });
    let samplingSignal: AbortSignal | undefined;
    let samplingStarted!: () => void;
    const started = new Promise<void>(resolve => { samplingStarted = resolve; });
    const onSampling = vi.fn((_request: unknown, signal?: AbortSignal) => {
      samplingSignal = signal;
      samplingStarted();
      return new Promise<never>(() => {});
    });
    const attachment = await attachTaskSession({ client, serverName: "task-server", definition, transport, clientInfo, clientCapabilities, onSampling });
    const controller = new AbortController();
    try {
      const call = callToolViaTaskSession(attachment!.session, { name: "ask_model", args: {}, signal: controller.signal });
      await started;
      expect(samplingSignal?.aborted).toBe(false);
      controller.abort();
      await expect(call).rejects.toThrow();
      expect(samplingSignal?.aborted).toBe(true);
    } finally {
      await attachment!.session.close();
    }
  });

  it("answers a task-time roots request with the session roots", async () => {
    const roots = [{ uri: "file:///work/project", name: "project" }];
    const { client, transport, server } = fakeModernTaskStack({
      statuses: [
        { status: "input_required", inputRequests: { where: { method: "roots/list", params: {} } } },
        { status: "completed", result: { resultType: "complete", content: [], isError: false } },
      ],
    });
    const attachment = await attachTaskSession({
      client,
      serverName: "task-server",
      definition,
      transport,
      clientInfo,
      clientCapabilities: { roots: {} },
      roots,
    });
    try {
      await callToolViaTaskSession(attachment!.session, { name: "scan", args: {} });
      expect(server.updates[0]).toMatchObject({ inputResponses: { where: { roots } } });
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

describe("startToolViaTaskSession", () => {
  it("cancels like a blocking call when the tool call aborts before the task handle arrives", async () => {
    const { execution, cancel } = fakeExecution(new TaskCancelledError());
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const callTool = vi.fn(async (_name: string, _args: unknown, _options: { signal?: AbortSignal }) => {
      await answered;
      return execution;
    });
    const controller = new AbortController();

    const pending = startToolViaTaskSession({ callTool } as unknown as TaskEnabledSession, { name: "t", args: {}, signal: controller.signal });
    controller.abort();
    expect(callTool.mock.calls[0]![2].signal!.aborted).toBe(true);
    answer();

    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
  });
});

describe("background task delivery over a task session", () => {
  const definition = { command: "fake-server", tasks: true };
  const clientInfo = { name: "pi-mcp-test", version: "1.0.0" };

  function registry(ownerSignal = new AbortController().signal) {
    const sendMessage = vi.fn();
    const manager = { decrementInFlight: vi.fn(), touch: vi.fn() };
    return { tasks: new BackgroundTaskRegistry(manager, sendMessage, ownerSignal), sendMessage, manager };
  }

  const render = async (result: Record<string, unknown>) => ({
    content: result.content as Array<{ type: "text"; text: string }>,
    details: {},
  });
  const guard = async (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

  it("answers a task's question after its call returned and delivers the result", async () => {
    const { client, transport, server } = fakeModernTaskStack({
      statuses: [
        {
          status: "input_required",
          inputRequests: {
            name: {
              method: "elicitation/create",
              params: { mode: "form", message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } },
            },
          },
        },
        { status: "completed", result: { resultType: "complete", content: [{ type: "text", text: "hello Luca" }], isError: false } },
      ],
    });
    const onElicitation = vi.fn(async () => ({ action: "accept" as const, content: { name: "Luca" } }));
    const attachment = await attachTaskSession({
      client, serverName: "task-server", definition, transport, clientInfo, clientCapabilities: { elicitation: { form: {} } }, onElicitation,
    });
    const { tasks, sendMessage } = registry();
    try {
      const started = await startToolViaTaskSession(attachment!.session, { name: "hello_world", args: {} });
      expect(started.kind).toBe("task");
      if (started.kind !== "task") return;
      await tasks.start({ server: "task-server", tool: "hello_world", taskId: started.taskId, execution: started.execution, render, guard });

      expect(onElicitation).toHaveBeenCalledTimes(1);
      expect(server.updates[0]).toMatchObject({ taskId: "task-e2e-1", inputResponses: { name: { action: "accept", content: { name: "Luca" } } } });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toEqual([
        { type: "text", text: "MCP task task-e2e-1 (task-server/hello_world) completed." },
        { type: "text", text: "hello Luca" },
      ]);
    } finally {
      await attachment!.session.close();
    }
  });

  it("delivers one cancelled result when the connection closes under a running task", async () => {
    const { client, transport } = fakeModernTaskStack({ statuses: [{ status: "working" }] });
    const attachment = await attachTaskSession({
      client, serverName: "task-server", definition, transport, clientInfo, clientCapabilities: {},
    });
    const { tasks, sendMessage } = registry();
    const started = await startToolViaTaskSession(attachment!.session, { name: "slow_tool", args: {} });
    if (started.kind !== "task") throw new Error("expected a task");
    const done = tasks.start({ server: "task-server", tool: "slow_tool", taskId: started.taskId, execution: started.execution, render, guard });

    await attachment!.session.close();
    await done;

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({
      content: [
        { type: "text", text: "MCP task task-e2e-1 (task-server/slow_tool) cancelled." },
        { type: "text", text: "The connection to task-server closed." },
      ],
      details: { task: { status: "cancelled" }, error: "task_cancelled" },
    });
  });

  function attach(stack: ReturnType<typeof fakeModernTaskStack>, serverDefinition: typeof definition = definition) {
    return attachTaskSession({
      client: stack.client, serverName: "task-server", definition: serverDefinition, transport: stack.transport, clientInfo, clientCapabilities: {},
    });
  }

  async function startOn(tasks: BackgroundTaskRegistry, session: TaskEnabledSession) {
    const started = await startToolViaTaskSession(session, { name: "slow_tool", args: {} });
    if (started.kind !== "task") throw new Error("expected a task");
    return { done: tasks.start({ server: "task-server", tool: "slow_tool", taskId: started.taskId, execution: started.execution, render, guard }) };
  }

  it("hands a running task over to a replacement connection without cancelling it", async () => {
    const script = { statuses: [{ status: "working" }] as Array<Record<string, unknown>> };
    const first = fakeModernTaskStack(script);
    const second = fakeModernTaskStack(script, first.server, "second");
    const replaced = await attach(first);
    const replacement = await attach(second);
    const { tasks, sendMessage, manager } = registry();
    try {
      const { done } = await startOn(tasks, replaced!.session);

      await tasks.handOver("task-server", { taskSession: replacement!.session, closed: () => false });
      await replaced!.session.close();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(manager.decrementInFlight).not.toHaveBeenCalled();

      script.statuses.push({ status: "completed", result: { resultType: "complete", content: [{ type: "text", text: "built" }], isError: false } });
      await done;

      expect(first.server.cancels).toEqual([]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toEqual([
        { type: "text", text: "MCP task task-e2e-1 (task-server/slow_tool) completed." },
        { type: "text", text: "built" },
      ]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    } finally {
      await replacement!.session.close();
    }
  });

  it.each([
    ["has no task session", undefined, false, "It could not be followed after its connection changed"],
    ["is a different endpoint", { command: "other-server", tasks: true }, false, "Server 'task-server' was reconfigured since this task started"],
    ["no longer knows the task", definition, true, "Expired on the server: outcome unknown"],
  ])("delivers one outcome-unknown message, with why, when the replacement connection %s", async (_case, replacementDefinition, forgetsTasks, reason) => {
    const script = { statuses: [{ status: "working" }] };
    const first = fakeModernTaskStack(script);
    const replaced = await attach(first);
    const replacement = replacementDefinition === undefined
      ? undefined
      : await attach(fakeModernTaskStack({ ...script, forgetsTasks }, first.server, "second"), replacementDefinition);
    const { tasks, sendMessage, manager } = registry();
    try {
      const { done } = await startOn(tasks, replaced!.session);

      await tasks.handOver("task-server", { taskSession: replacement?.session, closed: () => false });
      await replaced!.session.close();
      await done;

      expect(first.server.cancels).toEqual([]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0]).toMatchObject({
        content: [
          { type: "text", text: "MCP task task-e2e-1 (task-server/slow_tool) outcome unknown." },
          { type: "text", text: `${reason}. Calling the tool again may repeat the work.` },
        ],
        details: { task: { status: "unknown" }, error: "task_outcome_unknown" },
      });
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    } finally {
      await replacement?.session.close();
    }
  });

  it("stops a handed-over task through its resumed execution", async () => {
    const script = { statuses: [{ status: "working" }] };
    const first = fakeModernTaskStack(script);
    const second = fakeModernTaskStack(script, first.server, "second");
    const replaced = await attach(first);
    const replacement = await attach(second);
    const { tasks, sendMessage } = registry();
    try {
      const { done } = await startOn(tasks, replaced!.session);
      await tasks.handOver("task-server", { taskSession: replacement!.session, closed: () => false });
      await replaced!.session.close();

      expect(await tasks.stop("task-server/task-e2e-1", "you")).toBe(true);
      await done;

      expect(first.server.cancels).toEqual([{ connection: "second", taskId: "task-e2e-1" }]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toEqual([
        { type: "text", text: "MCP task task-e2e-1 (task-server/slow_tool) cancelled." },
        { type: "text", text: "Stopped by you." },
      ]);
    } finally {
      await replacement!.session.close();
    }
  });

  it("cancels a handed-over task over its resumed connection when the runtime stops", async () => {
    const script = { statuses: [{ status: "working" }] };
    const first = fakeModernTaskStack(script);
    const second = fakeModernTaskStack(script, first.server, "second");
    const replaced = await attach(first);
    const replacement = await attach(second);
    const owner = new AbortController();
    const { tasks, sendMessage, manager } = registry(owner.signal);
    try {
      const { done } = await startOn(tasks, replaced!.session);
      await tasks.handOver("task-server", { taskSession: replacement!.session, closed: () => false });
      await replaced!.session.close();

      owner.abort();
      await done;

      expect(first.server.cancels).toEqual([{ connection: "second", taskId: "task-e2e-1" }]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].details).toMatchObject({ task: { status: "cancelled" } });
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    } finally {
      await replacement!.session.close();
    }
  });

  it("cancels the task when the replacement connection closes before the hand-off resumes it", async () => {
    const script = { statuses: [{ status: "working" }] };
    const first = fakeModernTaskStack(script);
    const replaced = await attach(first);
    const replacement = await attach(fakeModernTaskStack(script, first.server, "second"));
    const { tasks, sendMessage, manager } = registry();
    let replacementClosed = false;
    try {
      const { done } = await startOn(tasks, replaced!.session);

      const handingOver = tasks.handOver("task-server", { taskSession: replacement!.session, closed: () => replacementClosed });
      replacementClosed = true;
      await replacement!.session.close();
      await handingOver;
      await done;

      expect(first.server.cancels).toEqual([{ connection: "first", taskId: "task-e2e-1" }]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0]).toMatchObject({
        content: [
          { type: "text", text: "MCP task task-e2e-1 (task-server/slow_tool) cancelled." },
          { type: "text", text: "The connection to task-server closed." },
        ],
        details: { task: { status: "cancelled" }, error: "task_cancelled" },
      });
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    } finally {
      await replaced!.session.close();
    }
  });
});

describe("background tasks across a session stop and start", () => {
  const definition = { command: "fake-server", tasks: true };
  const clientInfo = { name: "pi-mcp-test", version: "1.0.0" };
  const render = async (result: Record<string, unknown>) => ({
    content: result.content as Array<{ type: "text"; text: string }>,
    details: {},
  });
  const guard = async (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

  function attach(stack: ReturnType<typeof fakeModernTaskStack>) {
    return attachTaskSession({
      client: stack.client, serverName: "task-server", definition, transport: stack.transport, clientInfo, clientCapabilities: {},
    });
  }

  function registry(options: { owner?: AbortController; persist?: (task: HandedOffTask) => void; onChange?: () => void } = {}) {
    const sendMessage = vi.fn();
    const manager = { decrementInFlight: vi.fn(), touch: vi.fn() };
    const owner = options.owner ?? new AbortController();
    return { tasks: new BackgroundTaskRegistry(manager, sendMessage, owner.signal, options.onChange, options.persist), sendMessage, manager, owner };
  }

  /** Runs a task on its own connection, then stops that session and returns what it recorded. */
  async function handedOffTask(script: { statuses: Array<Record<string, unknown>> }) {
    const stack = fakeModernTaskStack(script);
    const connection = await attach(stack);
    const persisted: HandedOffTask[] = [];
    const stopping = registry({ persist: (task) => persisted.push(task) });
    const started = await startToolViaTaskSession(connection!.session, { name: "slow_tool", args: {} });
    if (started.kind !== "task") throw new Error("expected a task");
    const done = stopping.tasks.start({ server: "task-server", tool: "slow_tool", taskId: started.taskId, execution: started.execution, render, guard });

    await stopping.tasks.handOffForShutdown();
    stopping.owner.abort();
    await connection!.session.close();
    await done;
    return { stack, persisted, stopping };
  }

  it("hands every running task off at session stop without cancelling or delivering it", async () => {
    const { stack, persisted, stopping } = await handedOffTask({ statuses: [{ status: "working" }] });

    expect(persisted).toEqual([{
      key: "task-server/task-e2e-1",
      server: "task-server",
      tool: "slow_tool",
      reference: expect.objectContaining({ generation: "v2", taskId: "task-e2e-1" }),
    }]);
    expect(stack.server.cancels).toEqual([]);
    expect(stopping.sendMessage).not.toHaveBeenCalled();
    expect(stopping.manager.decrementInFlight).toHaveBeenCalledTimes(1);
    expect(stopping.tasks.size).toBe(0);
  });

  it("resumes a handed-off task when the session starts again and delivers its outcome once", async () => {
    const script = { statuses: [{ status: "working" }] as Array<Record<string, unknown>> };
    const { stack, persisted } = await handedOffTask(script);
    const connection = await attach(fakeModernTaskStack(script, stack.server, "second"));
    const { tasks, sendMessage, manager } = registry();
    try {
      const restored = tasks.restore(
        { server: "task-server", tool: "slow_tool", reference: persisted[0]!.reference, render, guard },
        { taskSession: connection!.session, closed: () => false },
      );
      script.statuses.push({ status: "completed", result: { resultType: "complete", content: [{ type: "text", text: "built" }], isError: false } });
      await restored;

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toEqual([
        { type: "text", text: "MCP task task-e2e-1 (task-server/slow_tool) completed." },
        { type: "text", text: "built" },
      ]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
      expect(stack.server.cancels).toEqual([]);
    } finally {
      await connection!.session.close();
    }
  });

  it("hands a restored task off again when the session stops before it ends", async () => {
    const script = { statuses: [{ status: "working" }] };
    const { stack, persisted } = await handedOffTask(script);
    const connection = await attach(fakeModernTaskStack(script, stack.server, "second"));
    let followed!: () => void;
    const following = new Promise<void>((resolve) => { followed = resolve; });
    const again: HandedOffTask[] = [];
    const restarted = registry({ persist: (task) => again.push(task), onChange: () => followed() });
    try {
      const restored = restarted.tasks.restore(
        { server: "task-server", tool: "slow_tool", reference: persisted[0]!.reference, render, guard },
        { taskSession: connection!.session, closed: () => false },
      );
      await following;
      await restarted.tasks.handOffForShutdown();
      restarted.owner.abort();
      await restored;

      expect(again).toEqual([expect.objectContaining({ key: "task-server/task-e2e-1" })]);
      expect(stack.server.cancels).toEqual([]);
      expect(restarted.sendMessage).not.toHaveBeenCalled();
      expect(restarted.manager.decrementInFlight).toHaveBeenCalledTimes(1);
    } finally {
      await connection!.session.close();
    }
  });

  it("delivers nothing for a restore cut short by another session stop", async () => {
    const script = { statuses: [{ status: "working" }] };
    const { stack, persisted } = await handedOffTask(script);
    const connection = await attach(fakeModernTaskStack(script, stack.server, "second"));
    const { tasks, sendMessage, manager, owner } = registry();

    const restored = tasks.restore(
      { server: "task-server", tool: "slow_tool", reference: persisted[0]!.reference, render, guard },
      { taskSession: connection!.session, closed: () => true },
    );
    owner.abort();
    await connection!.session.close();
    await restored;

    expect(sendMessage).not.toHaveBeenCalled();
    expect(stack.server.cancels).toEqual([]);
    expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
  });

  it.each(["never answers", "answers after the reconnect"])(
    "moves a restored task to a replacement connection when the old one's first poll %s",
    async (stale) => {
      const script = { statuses: [{ status: "working" }] as Array<Record<string, unknown>> };
      const { stack, persisted } = await handedOffTask(script);
      let polled!: () => void;
      const asked = new Promise<void>((resolve) => { polled = resolve; });
      let answerPoll!: () => void;
      const held = new Promise<void>((resolve) => { answerPoll = resolve; });
      const replaced = await attach(fakeModernTaskStack({ ...script, beforePoll: () => { polled(); return held; } }, stack.server, "second"));
      const replacement = await attach(fakeModernTaskStack(script, stack.server, "third"));
      const { tasks, sendMessage, manager } = registry();
      let replacedClosed = false;
      try {
        const restored = tasks.restore(
          { server: "task-server", tool: "slow_tool", reference: persisted[0]!.reference, render, guard },
          { taskSession: replaced!.session, closed: () => replacedClosed },
        );
        await asked;

        // As the server manager does: mark the old connection closed, hand over, then dispose it.
        replacedClosed = true;
        await tasks.handOver("task-server", { taskSession: replacement!.session, closed: () => false });
        if (stale === "answers after the reconnect") {
          answerPoll();
          await new Promise((resolve) => setImmediate(resolve));
        }
        await replaced!.session.close();
        script.statuses.push({ status: "completed", result: { resultType: "complete", content: [{ type: "text", text: "built" }], isError: false } });
        await restored;

        expect(stack.server.cancels).toEqual([]);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0]![0].content).toEqual([
          { type: "text", text: "MCP task task-e2e-1 (task-server/slow_tool) completed." },
          { type: "text", text: "built" },
        ]);
        expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
      } finally {
        await replacement!.session.close();
      }
    },
  );

  describe("when another transition takes a task over mid-await", () => {
    const reference = { endpointId: "e1", generation: "v2", taskId: "t-1", originalOperation: "tools/call" } as const;

    /**
     * An execution that logs what reaches it, modelled on ext-tasks: handing off or detaching settles it
     * as closed, the first outcome wins, and cancel is cached so it sends one frame.
     */
    function controlledExecution(log: string[], name: string) {
      let resolveOutcome!: (outcome: unknown) => void;
      const outcome = new Promise((resolve) => { resolveOutcome = resolve; });
      let settled = false;
      const finish = (value: unknown) => {
        if (settled) return;
        settled = true;
        resolveOutcome(value);
      };
      const closed = () => finish({ status: "failed", error: new TaskFailedError("closed", {}, { cause: new TaskExecutionClosedError() }) });
      let cancelling: Promise<void> | undefined;
      const execution = {
        kind: "task",
        handoff: async (persist: (ref: typeof reference) => void) => { persist(reference); closed(); },
        detach: async () => { log.push(`${name}.detach`); closed(); },
        cancel: () => (cancelling ??= (async () => { log.push(`${name}.cancel`); finish({ status: "cancelled" }); })()),
        result: () => outcome,
        settle: async () => ({ outcome: await outcome }),
      } as never;
      return { execution, finish };
    }

    const loggedExecution = (log: string[], name: string) => controlledExecution(log, name).execution;
    const completed = { status: "completed", result: { content: [{ type: "text", text: "built" }] } };
    const cancels = (log: string[]) => log.filter((line) => line.endsWith(".cancel"));

    /** A task session whose resumeTask waits until the test answers it. */
    function pendingResume() {
      let answer!: { resolve: (execution: unknown) => void; reject: (error: unknown) => void };
      let requested!: () => void;
      const asked = new Promise<void>((resolve) => { requested = resolve; });
      const taskSession = {
        resumeTask: () => new Promise((resolve, reject) => { answer = { resolve, reject }; requested(); }),
      } as unknown as TaskEnabledSession;
      return { taskSession, asked, answer: () => answer };
    }

    it.each(["fails", "succeeds"])("persists, and never cancels, a task the session stops for while a reconnect's resume %s", async (outcome) => {
      const log: string[] = [];
      const persisted: HandedOffTask[] = [];
      const { tasks, sendMessage, manager, owner } = registry({ persist: (task) => persisted.push(task) });
      void tasks.start({ server: "task-server", tool: "slow_tool", taskId: "t-1", execution: loggedExecution(log, "old"), render, guard });
      const resume = pendingResume();
      let replacementClosed = false;
      const handingOver = tasks.handOver("task-server", { taskSession: resume.taskSession, closed: () => replacementClosed });
      await resume.asked;

      await tasks.handOffForShutdown();
      owner.abort();
      replacementClosed = true;
      if (outcome === "fails") resume.answer().reject(new Error("MCP connection closed"));
      else resume.answer().resolve(loggedExecution(log, "resumed"));
      await handingOver;

      expect(persisted).toEqual([expect.objectContaining({ key: "task-server/t-1" })]);
      expect(log.filter((line) => line.endsWith(".cancel"))).toEqual([]);
      expect(log).toEqual(outcome === "fails" ? [] : ["resumed.detach"]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("lets a restored task run on, still pending, when its resume answers after the session stopped", async () => {
      const log: string[] = [];
      const { tasks, sendMessage, manager, owner } = registry({ persist: () => {} });
      const resume = pendingResume();
      const restored = tasks.restore(
        { server: "task-server", tool: "slow_tool", reference, render, guard },
        { taskSession: resume.taskSession, closed: () => false },
      );
      await resume.asked;

      await tasks.handOffForShutdown();
      owner.abort();
      resume.answer().resolve(loggedExecution(log, "resumed"));
      await restored;

      expect(log).toEqual(["resumed.detach"]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    });

    it("lets a restored task run on, still pending, when its resume answers after the owner stopped without a hand-off", async () => {
      const log: string[] = [];
      const persisted: HandedOffTask[] = [];
      const { tasks, sendMessage, manager, owner } = registry({ persist: (task) => persisted.push(task) });
      const resume = pendingResume();
      const restored = tasks.restore(
        { server: "task-server", tool: "slow_tool", reference, render, guard },
        { taskSession: resume.taskSession, closed: () => false },
      );
      await resume.asked;

      // A session restart or failed start stops the owner without handOffForShutdown.
      owner.abort();
      resume.answer().resolve(loggedExecution(log, "resumed"));
      await restored;

      expect(log).toEqual(["resumed.detach"]);
      expect(persisted).toEqual([]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    });

    const restoredTask = (taskId: string) =>
      ({ server: "task-server", tool: "slow_tool", reference: { ...reference, taskId }, render, guard });
    it("hands over a restored task whose resume answered on the old connection just as it was replaced", async () => {
      const log: string[] = [];
      const { tasks, sendMessage, manager } = registry();
      const resume = pendingResume();
      const restored = tasks.restore(restoredTask("t-1"), { taskSession: resume.taskSession, closed: () => false });
      await resume.asked;
      const fresh = controlledExecution(log, "fresh");
      const resumeTask = vi.fn(async () => fresh.execution);

      // The answer is in, but the restore hasn't followed it yet when the replacement lands.
      resume.answer().resolve(loggedExecution(log, "stale"));
      await tasks.handOver("task-server", { taskSession: { resumeTask } as unknown as TaskEnabledSession, closed: () => false });
      expect(resumeTask).toHaveBeenCalledTimes(1);
      fresh.finish(completed);
      await restored;

      expect(cancels(log)).toEqual([]);
      expect(log).toContain("stale.detach");
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toEqual([
        { type: "text", text: "MCP task t-1 (task-server/slow_tool) completed." },
        { type: "text", text: "built" },
      ]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    });

    it("leaves a restore still resuming pending, without resuming it again, when its connection is replaced while the session stops", async () => {
      const log: string[] = [];
      const persisted: HandedOffTask[] = [];
      const { tasks, sendMessage, manager, owner } = registry({ persist: (task) => persisted.push(task) });
      const resume = pendingResume();
      const restored = tasks.restore(restoredTask("t-1"), { taskSession: resume.taskSession, closed: () => false });
      await resume.asked;
      const resumeTask = vi.fn();

      await tasks.handOffForShutdown();
      const handingOver = tasks.handOver("task-server", { taskSession: { resumeTask } as unknown as TaskEnabledSession, closed: () => false });
      resume.answer().reject(new Error("This operation was aborted"));
      await handingOver;
      owner.abort();
      await restored;

      expect(resumeTask).not.toHaveBeenCalled();
      expect(cancels(log)).toEqual([]);
      expect(persisted).toEqual([]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    });


    it.each(["while it hands off a running task", "with nothing running"])(
      "lets a restore that resumes once the session starts stopping %s run on, still pending",
      async (when) => {
        const log: string[] = [];
        const persisted: HandedOffTask[] = [];
        const { tasks, sendMessage, manager, owner } = registry({ persist: (task) => persisted.push(task) });
        if (when !== "with nothing running") {
          void tasks.start({ server: "task-server", tool: "slow_tool", taskId: "t-0", execution: loggedExecution(log, "running"), render, guard });
        }
        const resume = pendingResume();
        const restored = tasks.restore(restoredTask("t-1"), { taskSession: resume.taskSession, closed: () => false });
        await resume.asked;

        const handingOff = tasks.handOffForShutdown();
        resume.answer().resolve(loggedExecution(log, "restored"));
        await handingOff;
        // Let the restore's continuation run before the owner stops, as it can between the hand-off and owner.stop.
        await new Promise((resolve) => setImmediate(resolve));
        owner.abort();
        await restored;

        expect(cancels(log)).toEqual([]);
        expect(log).toContain("restored.detach");
        expect(persisted.map((task) => task.key)).toEqual(when === "with nothing running" ? [] : ["task-server/t-0"]);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(manager.decrementInFlight).toHaveBeenCalledTimes(when === "with nothing running" ? 1 : 2);
      },
    );

    it("stops a restored task over its resumed execution and names who stopped it", async () => {
      const log: string[] = [];
      let followed!: () => void;
      const following = new Promise<void>((resolve) => { followed = resolve; });
      const { tasks, sendMessage, manager } = registry({ onChange: () => followed() });
      const taskSession = { resumeTask: async () => loggedExecution(log, "restored") } as unknown as TaskEnabledSession;
      const restored = tasks.restore(restoredTask("t-1"), { taskSession, closed: () => false });
      await following;

      expect(await tasks.stop("task-server/t-1", "the agent")).toBe(true);
      await restored;

      expect(cancels(log)).toEqual(["restored.cancel"]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toEqual([
        { type: "text", text: "MCP task t-1 (task-server/slow_tool) cancelled." },
        { type: "text", text: "Stopped by the agent." },
      ]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    });

    it("delivers once when a task ends on the server while a reconnect hands it over", async () => {
      const log: string[] = [];
      const { tasks, sendMessage, manager } = registry();
      const old = controlledExecution(log, "old");
      const resumed = controlledExecution(log, "resumed");
      const done = tasks.start({ server: "task-server", tool: "slow_tool", taskId: "t-1", execution: old.execution, render, guard });
      const taskSession = {
        resumeTask: async () => { resumed.finish(completed); return resumed.execution; },
      } as unknown as TaskEnabledSession;

      const handingOver = tasks.handOver("task-server", { taskSession, closed: () => false });
      old.finish(completed);
      await handingOver;
      await done;

      expect(cancels(log)).toEqual([]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toEqual([
        { type: "text", text: "MCP task t-1 (task-server/slow_tool) completed." },
        { type: "text", text: "built" },
      ]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    });

    it("sends at most one cancel and one message when a stop lands in a reconnect's resume window", async () => {
      const log: string[] = [];
      const { tasks, sendMessage, manager } = registry();
      const done = tasks.start({ server: "task-server", tool: "slow_tool", taskId: "t-1", execution: loggedExecution(log, "old"), render, guard });
      const resume = pendingResume();
      const handingOver = tasks.handOver("task-server", { taskSession: resume.taskSession, closed: () => false });
      await resume.asked;

      expect(await tasks.stop("task-server/t-1", "the agent")).toBe(true);
      // The server honoured the cancel, so the resumed task is already cancelled.
      const resumed = controlledExecution(log, "resumed");
      resumed.finish({ status: "cancelled" });
      resume.answer().resolve(resumed.execution);
      await handingOver;
      await done;

      expect(cancels(log)).toEqual(["old.cancel"]);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0]![0].content).toEqual([
        { type: "text", text: "MCP task t-1 (task-server/slow_tool) cancelled." },
        { type: "text", text: "Stopped by the agent." },
      ]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    });

    it("finds nothing to stop once the session stopping took over a task in a reconnect's resume window", async () => {
      const log: string[] = [];
      const persisted: HandedOffTask[] = [];
      const { tasks, sendMessage, manager, owner } = registry({ persist: (task) => persisted.push(task) });
      void tasks.start({ server: "task-server", tool: "slow_tool", taskId: "t-1", execution: loggedExecution(log, "old"), render, guard });
      const resume = pendingResume();
      const handingOver = tasks.handOver("task-server", { taskSession: resume.taskSession, closed: () => false });
      await resume.asked;

      await tasks.handOffForShutdown();
      expect(await tasks.stop("task-server/t-1", "the agent")).toBe(false);
      owner.abort();
      resume.answer().resolve(loggedExecution(log, "resumed"));
      await handingOver;

      expect(cancels(log)).toEqual([]);
      expect(persisted).toHaveLength(1);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    });

    it("persists, and never cancels, a task that starts after the session began stopping", async () => {
      const log: string[] = [];
      const persisted: HandedOffTask[] = [];
      const { tasks, sendMessage, manager, owner } = registry({ persist: (task) => persisted.push(task) });
      await tasks.handOffForShutdown();

      const done = tasks.start({ server: "task-server", tool: "slow_tool", taskId: "t-1", execution: loggedExecution(log, "late"), render, guard });
      owner.abort();
      await done;

      expect(persisted).toEqual([expect.objectContaining({ key: "task-server/t-1", reference: expect.objectContaining({ taskId: "t-1" }) })]);
      expect(cancels(log)).toEqual([]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
      expect(tasks.size).toBe(0);
    });

    it("still cancels a task that starts while a runtime without a session record stops", async () => {
      const log: string[] = [];
      const { tasks, manager, owner } = registry();
      await tasks.handOffForShutdown();

      const done = tasks.start({ server: "task-server", tool: "slow_tool", taskId: "t-1", execution: loggedExecution(log, "late"), render, guard });
      owner.abort();
      await done;

      expect(cancels(log)).toEqual(["late.cancel"]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
    });
  });
});
