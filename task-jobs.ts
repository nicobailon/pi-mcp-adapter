import { TaskExecutionClosedError, taskViewFromExecutionEvent, type TaskState } from "@modelcontextprotocol/ext-tasks/client";
import type { BackgroundToolExecution } from "./mcp-tasks.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { SendMessageFn } from "./state.ts";
import type { ContentBlock } from "./types.ts";
import { logger } from "./logger.ts";

export interface RenderedTaskResult {
  content: ContentBlock[];
  details: Record<string, unknown>;
}

export interface BackgroundTaskStart {
  server: string;
  tool: string;
  taskId: string;
  execution: BackgroundToolExecution;
  /** Renders a completed tool result the way the call site renders an inline one. */
  render: (result: Record<string, unknown>) => Promise<RenderedTaskResult>;
  /** Bounds a failure or cancel reason, which may come from the server, with the call site's output guard. */
  guard: (text: string) => Promise<RenderedTaskResult>;
}

/** A running task as `/mcp tasks` shows it. */
export interface BackgroundTaskInfo {
  /** `<server>/<taskId>`, the name `/mcp tasks stop` takes. */
  key: string;
  tool: string;
  status: TaskState;
  statusMessage?: string;
}

interface RunningTask {
  info: BackgroundTaskInfo;
  execution: BackgroundToolExecution;
  stopRequested: boolean;
}

/** The tool result a call returns once its task runs in the background. */
export function backgroundTaskHandle(server: string, tool: string, taskId: string) {
  return {
    content: [{
      type: "text" as const,
      text: `Task ${taskId} started on ${server}/${tool}. Do not call the tool again; the result arrives later as an mcp-task-result message.`,
    }],
    task: { id: taskId, server, tool, status: "working" as const },
  };
}

/**
 * Tool calls whose server answered with a task. Each runs to settlement here,
 * holding its server's in-flight count, and its outcome reaches the model as
 * one follow-up message. Stopping the runtime or closing the connection
 * cancels the remote task.
 */
export class BackgroundTaskRegistry {
  private readonly running = new Map<string, RunningTask>();

  constructor(
    private readonly manager: Pick<McpServerManager, "decrementInFlight" | "touch">,
    private readonly sendMessage: SendMessageFn,
    private readonly ownerSignal: AbortSignal,
    private readonly onChange: () => void = () => {},
  ) {}

  get size(): number {
    return this.running.size;
  }

  list(): BackgroundTaskInfo[] {
    return [...this.running.values()].map(({ info }) => ({ ...info }));
  }

  /** Resolves false for an unknown key; rejects when the cancel request fails. */
  async stop(key: string): Promise<boolean> {
    const entry = this.running.get(key);
    if (entry === undefined) return false;
    entry.stopRequested = true;
    await entry.execution.cancel();
    return true;
  }

  /**
   * Takes over the call's in-flight count. Resolves once the outcome is
   * delivered and the count released.
   */
  start(task: BackgroundTaskStart): Promise<void> {
    const key = `${task.server}/${task.taskId}`;
    const entry: RunningTask = {
      info: { key, tool: task.tool, status: "working" },
      execution: task.execution,
      stopRequested: false,
    };
    this.running.set(key, entry);
    this.onChange();
    // A list must never show a settled task, so the entry goes before the outcome is delivered.
    const remove = () => {
      if (this.running.get(key) !== entry) return;
      this.running.delete(key);
      this.onChange();
    };
    // The same cancel a blocking call sends when the runtime stops, ahead of the connection teardown.
    const cancel = () => void task.execution.cancel().catch(() => {});
    if (this.ownerSignal.aborted) cancel();
    else this.ownerSignal.addEventListener("abort", cancel, { once: true });
    return task.execution.settle({
      onEvent: (event) => {
        const view = taskViewFromExecutionEvent(event);
        if (view === undefined) return;
        entry.info.status = view.status;
        if (view.statusMessage === undefined) delete entry.info.statusMessage;
        else entry.info.statusMessage = view.statusMessage;
      },
    })
      .then(async ({ outcome }) => {
        remove();
        const label = `MCP task ${task.taskId} (${task.server}/${task.tool})`;
        const identity = { id: task.taskId, server: task.server, tool: task.tool };
        let message: RenderedTaskResult;
        if (outcome.status === "completed") {
          const { resultType: _resultType, ...result } = outcome.result as Record<string, unknown>;
          const rendered = await task.render(result);
          message = {
            content: [{ type: "text", text: `${label} completed.` }, ...rendered.content],
            details: { task: { ...identity, status: "completed" }, ...rendered.details },
          };
        } else if (outcome.status === "failed" && !(outcome.error.cause instanceof TaskExecutionClosedError)) {
          const guarded = await task.guard(outcome.error.message);
          message = {
            content: [{ type: "text", text: `${label} failed.` }, ...guarded.content],
            details: { task: { ...identity, status: "failed" }, error: "task_failed", ...guarded.details },
          };
        } else {
          const reason = outcome.status === "failed"
            ? `The connection to ${task.server} closed.`
            : entry.stopRequested
              ? "Stopped by you."
              : outcome.task?.statusMessage ?? "Task was cancelled by the server";
          const guarded = await task.guard(reason);
          message = {
            content: [{ type: "text", text: `${label} cancelled.` }, ...guarded.content],
            details: { task: { ...identity, status: "cancelled" }, error: "task_cancelled", ...guarded.details },
          };
        }
        this.sendMessage(
          { customType: "mcp-task-result", display: true, ...message },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      })
      .catch((error: unknown) => {
        logger.warn(`MCP task ${task.server}/${task.taskId} could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        remove();
        this.ownerSignal.removeEventListener("abort", cancel);
        this.manager.decrementInFlight(task.server);
        this.manager.touch(task.server);
      });
  }
}
