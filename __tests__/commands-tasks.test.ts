import { describe, expect, it, vi } from "vitest";
import { showBackgroundTasks, stopBackgroundTask } from "../commands.ts";
import { BackgroundTaskRegistry } from "../task-jobs.ts";

/** A running task whose server acknowledges a cancel by settling it as cancelled. */
function runningTask() {
  let settle!: (outcome: unknown) => void;
  let onEvent: ((event: unknown) => void) | undefined;
  const settled = new Promise<unknown>((resolve) => { settle = (outcome) => resolve({ outcome, lastTask: undefined }); });
  const execution = {
    kind: "task",
    handle: { taskId: "t-1", operation: "tools/call" },
    cancel: vi.fn(async () => settle({ status: "cancelled" })),
    close: vi.fn(),
    settle: (options: { onEvent?: (event: unknown) => void }) => {
      onEvent = options.onEvent;
      return settled;
    },
  };
  return { execution: execution as any, report: (task: Record<string, unknown>) => onEvent?.({ type: "task", task }) };
}

function setup() {
  const sendMessage = vi.fn();
  const tasks = new BackgroundTaskRegistry({ decrementInFlight: vi.fn(), touch: vi.fn() }, sendMessage, new AbortController().signal);
  const notify = vi.fn();
  const ctx = { hasUI: true, ui: { notify } } as any;
  return { state: { backgroundTasks: tasks } as any, tasks, sendMessage, notify, ctx };
}

describe("/mcp tasks", () => {
  it("lists running tasks with their latest status", () => {
    const { state, tasks, notify, ctx } = setup();
    const { execution, report } = runningTask();
    void tasks.start({ server: "ci", tool: "build", taskId: "t-1", execution, render: async () => ({ content: [], details: {} }) });
    report({ taskId: "t-1", status: "working", statusMessage: "Compiling, 40 of 212 files done" });

    showBackgroundTasks(state, ctx);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("ci/t-1 (build): working — Compiling, 40 of 212 files done"), "info");
  });

  it("stops a task and delivers it as stopped by the user", async () => {
    const { state, tasks, sendMessage, notify, ctx } = setup();
    const { execution } = runningTask();
    const done = tasks.start({ server: "ci", tool: "build", taskId: "t-1", execution, render: async () => ({ content: [], details: {} }) });

    await stopBackgroundTask(state, ctx, "ci/t-1");
    await done;

    expect(execution.cancel).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0].content).toEqual([
      { type: "text", text: "MCP task t-1 (ci/build) cancelled." },
      { type: "text", text: "Stopped by you." },
    ]);
    expect(notify).toHaveBeenCalledWith('Stopped MCP task "ci/t-1".', "info");
    expect(tasks.list()).toEqual([]);
  });

  it("reports an unknown task", async () => {
    const { state, notify, ctx } = setup();

    await stopBackgroundTask(state, ctx, "ci/nope");

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('No running MCP task "ci/nope"'), "error");
  });

  it("explains that background tasks need the interactive terminal", () => {
    const notify = vi.fn();

    showBackgroundTasks({} as any, { hasUI: true, ui: { notify } } as any);

    expect(notify).toHaveBeenCalledWith("Background MCP tasks run only in the interactive terminal.", "info");
  });
});
