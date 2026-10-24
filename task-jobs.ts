import {
  TaskExecutionClosedError,
  taskViewFromExecutionEvent,
  type SerializedTaskReference,
  type TaskEnabledSession,
  type TaskState,
} from "@modelcontextprotocol/ext-tasks/client";
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

interface RunningTask extends Omit<BackgroundTaskStart, "execution"> {
  info: BackgroundTaskInfo;
  /** The execution following the task; a connection replacement swaps it for a resumed one. */
  execution: BackgroundToolExecution;
  /** Bumped when the task is handed off, so the superseded execution's outcome is ignored. */
  generation: number;
  /** Who asked to stop the task, named in the cancelled message. */
  stoppedBy?: "you" | "the agent";
  /** Removes the current execution's owner-abort cancel. */
  releaseCancel: () => void;
  /** Resolves the promise `start()` returned. */
  finish: () => void;
}

/** What a replacement connection offers for resuming its server's tasks. */
export interface ReplacementTaskSession {
  taskSession?: TaskEnabledSession | undefined;
  requestTimeoutMs?: number | undefined;
}

/**
 * The tool result a call returns once its task runs in the background. `cancelHint` names
 * mcp({ cancelTask }) only while the `mcp` tool exists to take it.
 */
export function backgroundTaskHandle(server: string, tool: string, taskId: string, cancelHint: boolean) {
  const hint = cancelHint ? ` To stop it, call mcp({ cancelTask: ${JSON.stringify(`${server}/${taskId}`)} }).` : "";
  return {
    content: [{
      type: "text" as const,
      text: `Task ${taskId} started on ${server}/${tool}. Do not call the tool again; the result arrives later as an mcp-task-result message.${hint}`,
    }],
    task: { id: taskId, server, tool, status: "working" as const },
  };
}

/**
 * Tool calls whose server answered with a task. Each runs to settlement here,
 * holding its server's in-flight count, and its outcome reaches the model as
 * one follow-up message. Stopping the runtime or closing the connection
 * cancels the remote task; replacing the connection hands it over instead.
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
  async stop(key: string, by: "you" | "the agent"): Promise<boolean> {
    const entry = this.running.get(key);
    if (entry === undefined) return false;
    entry.stoppedBy = by;
    await entry.execution.cancel();
    return true;
  }

  /**
   * Takes over the call's in-flight count. Resolves once the outcome is
   * delivered and the count released.
   */
  start(task: BackgroundTaskStart): Promise<void> {
    const key = `${task.server}/${task.taskId}`;
    return new Promise((finish) => {
      const entry: RunningTask = {
        ...task,
        info: { key, tool: task.tool, status: "working" },
        generation: 0,
        releaseCancel: () => {},
        finish,
      };
      this.running.set(key, entry);
      this.onChange();
      this.follow(entry, task.execution);
    });
  }

  /**
   * Moves every task on `server` from its replaced connection to the fresh one
   * without cancelling it. Resolves once the old executions have settled, so
   * closing the old task session afterwards sends no `tasks/cancel`.
   */
  async handOver(server: string, fresh: ReplacementTaskSession): Promise<void> {
    const entries = [...this.running.values()].filter((entry) => entry.server === server);
    await Promise.all(entries.map(async (entry) => {
      const old = entry.execution;
      entry.generation += 1;
      entry.releaseCancel();
      try {
        let reference: SerializedTaskReference | undefined;
        await old.handoff((ref) => { reference = ref; });
        // close() cancels an execution that has not settled yet; result() settles it.
        await old.result();
        if (fresh.taskSession === undefined) throw new Error("the new connection has no task session");
        const resumed = await fresh.taskSession.resumeTask(reference!, {
          ...(fresh.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: fresh.requestTimeoutMs }),
        });
        if (resumed.kind !== "task") throw new Error("resumeTask returned an immediate execution");
        this.follow(entry, resumed);
      } catch (error) {
        logger.warn(`MCP task ${entry.info.key} could not be resumed: ${error instanceof Error ? error.message : String(error)}`);
        this.sendMessage(
          {
            customType: "mcp-task-result",
            display: true,
            content: [{
              type: "text",
              text: `MCP task ${entry.taskId} (${entry.server}/${entry.tool}): outcome unknown after the connection was replaced. Calling the tool again may repeat the work.`,
            }],
            details: { task: { id: entry.taskId, server: entry.server, tool: entry.tool, status: "unknown" }, error: "task_outcome_unknown" },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        this.release(entry);
      }
    }));
  }

  private follow(entry: RunningTask, execution: BackgroundToolExecution): void {
    const generation = entry.generation;
    const current = () => entry.generation === generation;
    entry.execution = execution;
    // The same cancel a blocking call sends when the runtime stops, ahead of the connection teardown.
    const cancel = () => void execution.cancel().catch(() => {});
    entry.releaseCancel = () => this.ownerSignal.removeEventListener("abort", cancel);
    if (this.ownerSignal.aborted) cancel();
    else this.ownerSignal.addEventListener("abort", cancel, { once: true });
    const label = `MCP task ${entry.taskId} (${entry.server}/${entry.tool})`;
    const identity = { id: entry.taskId, server: entry.server, tool: entry.tool };
    void execution.settle({
      onEvent: (event) => {
        const view = taskViewFromExecutionEvent(event);
        if (view === undefined || !current()) return;
        entry.info.status = view.status;
        if (view.statusMessage === undefined) delete entry.info.statusMessage;
        else entry.info.statusMessage = view.statusMessage;
      },
    })
      .then(async ({ outcome }) => {
        if (!current()) return;
        this.remove(entry);
        let message: RenderedTaskResult;
        if (outcome.status === "completed") {
          const { resultType: _resultType, ...result } = outcome.result as Record<string, unknown>;
          const rendered = await entry.render(result);
          message = {
            content: [{ type: "text", text: `${label} completed.` }, ...rendered.content],
            details: { task: { ...identity, status: "completed" }, ...rendered.details },
          };
        } else if (outcome.status === "failed" && !(outcome.error.cause instanceof TaskExecutionClosedError)) {
          const guarded = await entry.guard(outcome.error.message);
          message = {
            content: [{ type: "text", text: `${label} failed.` }, ...guarded.content],
            details: { task: { ...identity, status: "failed" }, error: "task_failed", ...guarded.details },
          };
        } else {
          const reason = outcome.status === "failed"
            ? `The connection to ${entry.server} closed.`
            : entry.stoppedBy !== undefined
              ? `Stopped by ${entry.stoppedBy}.`
              : outcome.task?.statusMessage ?? "Task was cancelled by the server";
          const guarded = await entry.guard(reason);
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
        logger.warn(`MCP task ${entry.info.key} could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (current()) this.release(entry);
      });
  }

  // A list must never show a settled task, so the entry goes before the outcome is delivered.
  private remove(entry: RunningTask): void {
    if (this.running.get(entry.info.key) !== entry) return;
    this.running.delete(entry.info.key);
    this.onChange();
  }

  private release(entry: RunningTask): void {
    this.remove(entry);
    entry.releaseCancel();
    this.manager.decrementInFlight(entry.server);
    this.manager.touch(entry.server);
    entry.finish();
  }
}
