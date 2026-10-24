import { describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { TaskFailedError, type TaskOutcome } from "@modelcontextprotocol/ext-tasks/client";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeCancelTask } from "../proxy-modes.ts";
import { BackgroundTaskRegistry } from "../task-jobs.ts";

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

function taskState(execution: object, options: { background?: boolean } = {}) {
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
