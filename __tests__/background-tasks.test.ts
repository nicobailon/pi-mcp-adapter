import { describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { TaskFailedError, withTasks, type ConnectedMcpSessionPort, type JsonRpcResponse, type TaskOutcome } from "@modelcontextprotocol/ext-tasks/client";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeCancelTask } from "../proxy-modes.ts";
import { BackgroundTaskRegistry, type HandedOffTask } from "../task-jobs.ts";
import type { SendMessageFn } from "../state.ts";

type Outcome = TaskOutcome<Record<string, unknown>>;

/** A task-backed execution that settles only when the test says so. */
function pendingTask() {
  let finish!: (outcome: Outcome) => void;
  const settled = new Promise<{ outcome: Outcome; lastTask: undefined }>((resolve) => {
    finish = (outcome) => resolve({ outcome, lastTask: undefined });
  });
  const execution = {
    kind: "task" as const,
    handle: { taskId: "t-1", operation: "tools/call" },
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    settle: vi.fn(() => settled),
  };
  return { execution, finish };
}

function taskState(execution: unknown, options: { background?: boolean } = {}) {
  const callTool = vi.fn(async (_name: string, _args: unknown, _options: { signal?: AbortSignal }) => execution);
  const sendMessage = vi.fn();
  const manager = {
    getConnection: vi.fn(() => ({ status: "connected", client: {}, taskSession: { callTool }, tools: [], resources: [] })),
    touch: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
    getRequestOptions: vi.fn(() => undefined),
  };
  const owner = new AbortController();
  const registry = new BackgroundTaskRegistry(manager as any, sendMessage, owner.signal);
  const start = vi.spyOn(registry, "start");
  const state = {
    config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "node", args: ["server.js"] } } },
    manager,
    toolMetadata: new Map([["demo", [{ name: "demo_build", originalName: "build", description: "Build" }]]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    ui: undefined,
    sendMessage,
    // The model made every call unless a test says otherwise; index.ts installs the real rule.
    calledByModel: () => true,
    proxyToolAvailable: () => true,
    ...(options.background === false ? {} : { backgroundTasks: registry }),
  } as any;
  // Resolves once the registry has delivered the outcome and released the server.
  const delivered = () => start.mock.results[0]!.value as Promise<void>;
  return { state, callTool, sendMessage, manager, delivered, owner };
}

const HANDLE_TEXT = 'Task t-1 started on demo/build. Do not call the tool again; the result arrives later in a message that starts "MCP task t-1". To stop it, call mcp({ cancelTask: "demo/t-1" }).';

/** A JSON-RPC peer; executions, serialization and recovery use the real Tasks SDK. */
function completedTaskSession(cancel: ReturnType<typeof vi.fn>) {
  const task = {
    taskId: "t-1",
    createdAt: "2026-10-24T00:00:00Z",
    lastUpdatedAt: "2026-10-24T00:00:00Z",
    ttlMs: 60_000,
    pollIntervalMs: 1,
  };
  const port: ConnectedMcpSessionPort = {
    endpointId: "background-delivery-test",
    taskCapabilities: { generation: "v2", capabilities: {} },
    invalidated: false,
    onServerRequest: () => () => {},
    onNotification: () => () => {},
    onInvalidated: () => () => {},
    dispatch: async (request): Promise<JsonRpcResponse> => {
      const { method } = request as { method: string };
      if (method === "tools/call") return { kind: "result", result: { resultType: "task", ...task, status: "working" } };
      if (method === "tasks/get") return {
        kind: "result",
        result: { resultType: "complete", ...task, status: "completed", result: { resultType: "complete", content: [{ type: "text", text: "build ok" }] } },
      };
      if (method === "tasks/cancel") {
        cancel();
        return { kind: "result", result: { resultType: "complete" } };
      }
      throw new Error(`Unexpected task request: ${method}`);
    },
  };
  return withTasks(port, { tools: { currentTool: () => undefined } });
}

describe("completed background task recovery", () => {
  it.each(["rendering", "delivery"])("recovers a completed task stopped during %s without cancelling or delivering it twice", async stage => {
    const cancel = vi.fn();
    const session = completedTaskSession(cancel);
    const replacement = completedTaskSession(cancel);
    const persisted: HandedOffTask[] = [];
    const manager = { decrementInFlight: vi.fn(), touch: vi.fn() };
    const owner = new AbortController();
    let finishStage!: () => void;
    const stageGate = new Promise<void>(resolve => { finishStage = resolve; });
    let beginStage!: () => void;
    const waiting = new Promise<void>(resolve => { beginStage = resolve; });
    const waitAtStage = async () => { beginStage(); await stageGate; };
    const deliveredMessages: Parameters<SendMessageFn>[0][] = [];
    const sendMessage = vi.fn<SendMessageFn>(async (message, _options, delivery) => {
      if (stage === "delivery") await waitAtStage();
      if (owner.signal.aborted || delivery?.isCurrent() === false) return;
      deliveredMessages.push(message);
      delivery?.onSent();
    });
    const tasks = new BackgroundTaskRegistry(manager, sendMessage, owner.signal, undefined, task => persisted.push(task));
    const render = async (result: Record<string, unknown>) => ({
      content: result.content as Array<{ type: "text"; text: string }>,
      details: {},
    });
    const guard = async (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
    const execution = await session.callTool("build", {});
    if (execution.kind !== "task") throw new Error("Expected a task-backed execution");
    const done = tasks.start({
      server: "demo", tool: "build", taskId: execution.handle.taskId, execution, guard,
      render: async result => {
        if (stage === "rendering") await waitAtStage();
        return render(result);
      },
    });
    try {
      await waiting;
      expect(tasks.size).toBe(0);
      expect(tasks.list()).toEqual([]);
      await tasks.handOffForShutdown();
      owner.abort();
      finishStage();
      await done;
      await session.close();

      expect(persisted).toHaveLength(1);
      expect(deliveredMessages).toEqual([]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
      const recoveredSend = vi.fn();
      const recoveredManager = { decrementInFlight: vi.fn(), touch: vi.fn() };
      const recovered = new BackgroundTaskRegistry(recoveredManager, recoveredSend, new AbortController().signal);

      await recovered.restore({ ...persisted[0]!, render, guard }, { taskSession: replacement, closed: () => false });

      expect(recoveredSend).toHaveBeenCalledTimes(1);
      expect(recoveredSend.mock.calls[0]![0].content).toEqual([
        { type: "text", text: "MCP task t-1 (demo/build) completed." },
        { type: "text", text: "build ok" },
      ]);
      expect(recovered.size).toBe(0);
      expect(recoveredManager.decrementInFlight).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      finishStage();
      await Promise.all([session.close(), replacement.close()]);
      await done;
    }
  });

  it("does not restore a result already accepted when shutdown starts in the same delivery stack", async () => {
    const cancel = vi.fn();
    const session = completedTaskSession(cancel);
    const persisted: HandedOffTask[] = [];
    const manager = { decrementInFlight: vi.fn(), touch: vi.fn() };
    const owner = new AbortController();
    let tasks!: BackgroundTaskRegistry;
    let shutdown: Promise<void> | undefined;
    const deliveredMessages: Parameters<SendMessageFn>[0][] = [];
    const sendMessage: SendMessageFn = (message, _options, delivery) => {
      if (delivery?.isCurrent() === false) return;
      deliveredMessages.push(message);
      delivery?.onSent();
      shutdown = tasks.handOffForShutdown();
    };
    tasks = new BackgroundTaskRegistry(manager, sendMessage, owner.signal, undefined, task => persisted.push(task));
    const execution = await session.callTool("build", {});
    if (execution.kind !== "task") throw new Error("Expected a task-backed execution");
    try {
      await tasks.start({
        server: "demo", tool: "build", taskId: execution.handle.taskId, execution,
        render: async result => ({ content: result.content as Array<{ type: "text"; text: string }>, details: {} }),
        guard: async text => ({ content: [{ type: "text", text }], details: {} }),
      });
      await shutdown;
      owner.abort();

      expect(deliveredMessages).toHaveLength(1);
      expect(deliveredMessages[0]!.content).toEqual([
        { type: "text", text: "MCP task t-1 (demo/build) completed." },
        { type: "text", text: "build ok" },
      ]);
      expect(persisted).toEqual([]);
      expect(tasks.size).toBe(0);
      expect(tasks.list()).toEqual([]);
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it("keeps a restored task pending when shutdown interrupts its outcome-unknown message", async () => {
    const cancel = vi.fn();
    const session = completedTaskSession(cancel);
    const execution = await session.callTool("build", {});
    if (execution.kind !== "task") throw new Error("Expected a task-backed execution");
    await execution.settle();
    const reference = execution.serializeReference();
    const persisted: HandedOffTask[] = [];
    const manager = { decrementInFlight: vi.fn(), touch: vi.fn() };
    const sendMessage = vi.fn();
    const tasks = new BackgroundTaskRegistry(manager, sendMessage, new AbortController().signal, undefined, task => persisted.push(task));
    let finishGuard!: () => void;
    const guardGate = new Promise<void>(resolve => { finishGuard = resolve; });
    let beginGuard!: () => void;
    const guarding = new Promise<void>(resolve => { beginGuard = resolve; });
    const done = tasks.restore({
      server: "demo", tool: "build", reference,
      render: async () => ({ content: [], details: {} }),
      guard: async text => {
        beginGuard();
        await guardGate;
        return { content: [{ type: "text", text }], details: {} };
      },
    }, { unavailable: "unreachable", closed: () => false });
    try {
      await guarding;
      await tasks.handOffForShutdown();
      finishGuard();
      await done;
      await new Promise(resolve => setImmediate(resolve));

      expect(persisted).toEqual([{ key: "demo/t-1", server: "demo", tool: "build", reference }]);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
      expect(tasks.list()).toEqual([]);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      finishGuard();
      await done;
      await session.close();
    }
  });
});

describe("background MCP tasks through the proxy", () => {
  it("returns the task handle before the task finishes, then delivers the result once as a follow-up", async () => {
    const { execution, finish } = pendingTask();
    const { state, sendMessage, manager, delivered } = taskState(execution);

    const result = await executeCall(state, "demo_build", {});

    expect(result.content).toEqual([{ type: "text", text: HANDLE_TEXT }]);
    expect(result.details).toMatchObject({ mode: "call", server: "demo", tool: "build", task: { id: "t-1", server: "demo", tool: "build", status: "working" } });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(manager.decrementInFlight).not.toHaveBeenCalled();

    finish({ status: "completed", result: { resultType: "complete", content: [{ type: "text", text: "build ok" }] } });
    await delivered();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "mcp-task-result",
        display: true,
        content: [{ type: "text", text: "MCP task t-1 (demo/build) completed." }, { type: "text", text: "build ok" }],
        details: {
          task: { id: "t-1", server: "demo", tool: "build", status: "completed" },
          mcpResult: { content: [{ type: "text", text: "build ok" }] },
        },
      },
      { triggerTurn: true, deliverAs: "followUp" },
      expect.objectContaining({ isCurrent: expect.any(Function), onSent: expect.any(Function) }),
    );
    expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
  });

  it("keeps the task running when the tool call is aborted after the handle came back", async () => {
    const { execution, finish } = pendingTask();
    const { state, callTool, delivered } = taskState(execution);
    const controller = new AbortController();

    await executeCall(state, "demo_build", {}, undefined, undefined, controller.signal);
    controller.abort();

    expect(execution.cancel).not.toHaveBeenCalled();
    expect(callTool.mock.calls[0]![2].signal!.aborted).toBe(false);
    finish({ status: "completed", result: { content: [] } });
    await delivered();
  });

  it("cancels the remote task when the session stops", async () => {
    const { execution, finish } = pendingTask();
    const { state, owner, delivered } = taskState(execution);

    await executeCall(state, "demo_build", {});
    owner.abort();

    expect(execution.cancel).toHaveBeenCalledTimes(1);
    finish({ status: "completed", result: { content: [] } });
    await delivered();
  });

  it("bounds a failed task's error with the output guard", async () => {
    const { execution, finish } = pendingTask();
    const { state, sendMessage, delivered } = taskState(execution);
    state.config.settings.outputGuard = { maxBytes: 200, maxLines: 5 };
    const error = Array.from({ length: 50 }, (_, line) => `server error line ${line}`).join("\n");

    await executeCall(state, "demo_build", {});
    finish({ status: "failed", error: new TaskFailedError(error) });
    await delivered();

    const { content, details } = sendMessage.mock.calls[0]![0];
    const guard = details.outputGuard;
    await rm(dirname(guard.fullOutputPath), { recursive: true, force: true });
    expect(content[0]).toEqual({ type: "text", text: "MCP task t-1 (demo/build) failed." });
    expect(guard.truncated).toBe(true);
    expect(content[1].text).not.toContain("server error line 49");
  });

  it("delivers a failed task's error and a tool error result", async () => {
    const failed = pendingTask();
    const failing = taskState(failed.execution);
    await executeCall(failing.state, "demo_build", {});
    failed.finish({ status: "failed", error: new TaskFailedError("boom") });
    await failing.delivered();
    expect(failing.sendMessage.mock.calls[0]![0]).toMatchObject({
      content: [{ type: "text", text: "MCP task t-1 (demo/build) failed." }, { type: "text", text: "boom" }],
      details: { error: "task_failed" },
    });

    const toolError = pendingTask();
    const erroring = taskState(toolError.execution);
    await executeCall(erroring.state, "demo_build", {});
    toolError.finish({ status: "completed", result: { content: [{ type: "text", text: "compile failed" }], isError: true } });
    await erroring.delivered();
    expect(erroring.sendMessage.mock.calls[0]![0]).toMatchObject({
      content: [{ type: "text", text: "MCP task t-1 (demo/build) completed." }, { type: "text", text: "Error: compile failed" }],
      details: { error: "tool_error" },
    });
  });

  it("waits for the result inline outside the interactive terminal", async () => {
    const outcome = { status: "completed" as const, result: { content: [{ type: "text", text: "build ok" }] } };

    const nonTui = pendingTask();
    const plain = taskState(nonTui.execution, { background: false });
    nonTui.finish(outcome);
    const inline = await executeCall(plain.state, "demo_build", {});
    expect(inline.content).toEqual([{ type: "text", text: "build ok" }]);
  });

  it("returns the result inline when code made the call", async () => {
    const outcome = { status: "completed" as const, result: { content: [{ type: "text", text: "build ok" }] } };

    // The runtime tool-call event: origin "script" and no tool call id.
    const event = pendingTask();
    const fromExtension = taskState(event.execution);
    event.finish(outcome);
    const eventResult = await executeCall(fromExtension.state, "demo_build", {}, undefined, undefined, undefined, "script");
    expect(eventResult.content).toEqual([{ type: "text", text: "build ok" }]);
    expect(fromExtension.sendMessage).not.toHaveBeenCalled();

    // A codemode call, which the adapter's calledByModel reports as not the model's.
    const nested = pendingTask();
    const fromScript = taskState(nested.execution);
    fromScript.state.calledByModel = (id: string | undefined) => id !== "codemode/1";
    nested.finish(outcome);
    const scriptResult = await executeCall(fromScript.state, "demo_build", {}, undefined, undefined, undefined, undefined, undefined, "codemode/1");
    expect(scriptResult.content).toEqual([{ type: "text", text: "build ok" }]);
    expect(fromScript.sendMessage).not.toHaveBeenCalled();
  });
});

describe("background MCP tasks through direct tools", () => {
  const spec = { serverName: "demo", originalName: "build", prefixedName: "demo_build", description: "Build" };
  const run = (state: unknown, toolSpec: Record<string, unknown> = spec, toolCallId = "toolu_1", signal?: AbortSignal) =>
    createDirectToolExecutor(() => state as any, () => null, toolSpec as any)(toolCallId, {}, signal, undefined, {} as any);

  it("returns the task handle before the task finishes, then delivers the result once as a follow-up", async () => {
    const { execution, finish } = pendingTask();
    const { state, sendMessage, manager, delivered } = taskState(execution);

    const result = await run(state);

    expect(result.content).toEqual([{ type: "text", text: HANDLE_TEXT }]);
    expect(result.details).toEqual({ server: "demo", tool: "build", task: { id: "t-1", server: "demo", tool: "build", status: "working" } });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(manager.decrementInFlight).not.toHaveBeenCalled();

    finish({ status: "completed", result: { content: [{ type: "text", text: "build ok" }] } });
    await delivered();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        customType: "mcp-task-result",
        display: true,
        content: [{ type: "text", text: "MCP task t-1 (demo/build) completed." }, { type: "text", text: "build ok" }],
        details: { task: { id: "t-1", server: "demo", tool: "build", status: "completed" } },
      },
      { triggerTurn: true, deliverAs: "followUp" },
      expect.objectContaining({ isCurrent: expect.any(Function), onSent: expect.any(Function) }),
    );
    expect(manager.decrementInFlight).toHaveBeenCalledTimes(1);
  });

  it("keeps the task running when the tool call is aborted after the handle came back", async () => {
    const { execution, finish } = pendingTask();
    const { state, callTool, delivered } = taskState(execution);
    const controller = new AbortController();

    await run(state, spec, "toolu_1", controller.signal);
    controller.abort();

    expect(execution.cancel).not.toHaveBeenCalled();
    expect(callTool.mock.calls[0]![2].signal!.aborted).toBe(false);
    finish({ status: "completed", result: { content: [] } });
    await delivered();
  });

  it("leaves out the cancel hint when the mcp tool is not available", async () => {
    const { execution, finish } = pendingTask();
    const { state, delivered } = taskState(execution);
    state.proxyToolAvailable = () => false;

    const result = await run(state);

    expect(result.content).toEqual([{ type: "text", text: 'Task t-1 started on demo/build. Do not call the tool again; the result arrives later in a message that starts "MCP task t-1".' }]);
    finish({ status: "completed", result: { content: [] } });
    await delivered();
  });

  it("returns the result inline for MCP-UI tools and calls made by code", async () => {
    const outcome = { status: "completed" as const, result: { content: [{ type: "text", text: "build ok" }] } };

    const ui = pendingTask();
    const withUi = taskState(ui.execution);
    ui.finish(outcome);
    // An open view for this tool, which the call reuses.
    withUi.state.uiServer = { serverName: "demo", toolName: "build", url: "http://localhost/ui", sendToolInput: vi.fn(), sendToolResult: vi.fn(), sendResultPatch: vi.fn() };
    const uiResult = await run(withUi.state, { ...spec, uiResourceUri: "ui://demo/build" });
    expect(uiResult.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("build ok") });
    expect(withUi.sendMessage).not.toHaveBeenCalled();

    const nested = pendingTask();
    const fromScript = taskState(nested.execution);
    fromScript.state.calledByModel = (id: string | undefined) => id !== "codemode/1";
    nested.finish(outcome);
    const scriptResult = await run(fromScript.state, spec, "codemode/1");
    expect(scriptResult.content).toEqual([{ type: "text", text: "build ok" }]);
    expect(fromScript.sendMessage).not.toHaveBeenCalled();
  });
});

describe("mcp({ cancelTask })", () => {
  it("cancels a background task and delivers it once as stopped by the agent", async () => {
    const { execution, finish } = pendingTask();
    // The server acknowledges the cancel by settling the task as cancelled.
    execution.cancel.mockImplementation(async () => finish({ status: "cancelled" }));
    const { state, sendMessage, delivered } = taskState(execution);
    await executeCall(state, "demo_build", {});

    const result = await executeCancelTask(state, "demo/t-1");
    await delivered();

    expect(result.content).toEqual([{ type: "text", text: 'Cancel requested for MCP task "demo/t-1". A message that starts "MCP task" confirms it.' }]);
    expect(result.details).toEqual({ mode: "cancelTask", task: "demo/t-1" });
    expect(execution.cancel).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0].content).toEqual([
      { type: "text", text: "MCP task t-1 (demo/build) cancelled." },
      { type: "text", text: "Stopped by the agent." },
    ]);
  });

  it("returns an error and cancels nothing for an unknown task or outside the interactive terminal", async () => {
    const { execution, finish } = pendingTask();
    const { state, delivered } = taskState(execution);
    await executeCall(state, "demo_build", {});

    const unknown = await executeCancelTask(state, "demo/nope");
    expect(unknown.details).toMatchObject({ mode: "cancelTask", error: "not_found" });

    const nonTui = await executeCancelTask(taskState(pendingTask().execution, { background: false }).state, "demo/t-1");
    expect(nonTui.details).toMatchObject({ mode: "cancelTask", error: "no_background_tasks" });

    expect(execution.cancel).not.toHaveBeenCalled();
    finish({ status: "completed", result: { content: [] } });
    await delivered();
  });
});
