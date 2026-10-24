import {
  JsonRpcResponseError,
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
import { MCP_TASK_RESULT_TYPE } from "./task-entries.ts";

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

/** Each outcome's `details.error`; a completed task's result carries its own. */
const OUTCOME_ERRORS = { completed: undefined, failed: "task_failed", cancelled: "task_cancelled", unknown: "task_outcome_unknown" } as const;

/** A task a stopped session handed off, which the session can resume when it starts again. */
export interface HandedOffTask {
  key: string;
  server: string;
  tool: string;
  reference: SerializedTaskReference;
}

export interface RestoredTask extends Omit<BackgroundTaskStart, "execution" | "taskId"> {
  reference: SerializedTaskReference;
}

/** A running task as `/mcp tasks` shows it. */
export interface BackgroundTaskInfo {
  /** `<server>/<taskId>`, the name `/mcp tasks stop` takes. */
  key: string;
  tool: string;
  status: TaskState;
  statusMessage?: string;
}

interface TaskEntry extends Omit<BackgroundTaskStart, "execution"> {
  info: BackgroundTaskInfo;
  /** Bumped when the task is handed off, so the superseded execution's outcome is ignored. */
  generation: number;
  /** Who asked to stop the task, named in the cancelled message. */
  stoppedBy?: "you" | "the agent";
  /** Removes the current execution's owner-abort cancel. */
  releaseCancel: () => void;
  /** Resolves the promise `start()` returned. */
  finish: () => void;
}

interface RunningTask extends TaskEntry {
  /** The execution following the task; a connection replacement swaps it for a resumed one. */
  execution: BackgroundToolExecution;
}

/** What a replacement connection offers for resuming its server's tasks. */
export interface ReplacementTaskSession {
  taskSession?: TaskEnabledSession | undefined;
  requestTimeoutMs?: number | undefined;
  /** Whether the replacement connection has since been closed, by a disconnect, disable or session stop. */
  closed: () => boolean;
  /** Why there is no task session to resume on, when the caller knows. */
  unavailable?: "not-configured" | "unreachable" | undefined;
}

function unfollowableReason(server: string, session: ReplacementTaskSession, error: unknown): string {
  if (session.unavailable === "not-configured") return `Server '${server}' is not configured in this session; the task may still be running on it`;
  if (session.unavailable === "unreachable") return `Could not reach '${server}'`;
  // ext-tasks rejects resumeTask with this plain Error when the server's name now maps to another url or command.
  if (error instanceof Error && error.message === "Task reference belongs to a different endpoint") {
    return `Server '${server}' was reconfigured since this task started`;
  }
  // tasks/get answering -32602 (invalid params) is how a server says it doesn't know the task id.
  if (error instanceof JsonRpcResponseError && error.code === -32602) return "Expired on the server: outcome unknown";
  return "It could not be followed after its connection changed";
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
 * cancels the remote task; replacing the connection hands it over instead,
 * and so does stopping the session, which can resume it when it starts again.
 */
export class BackgroundTaskRegistry {
  private readonly running = new Map<string, RunningTask>();
  /** Restores still waiting on `resumeTask`, which aren't in `running` yet but a replacement hands over too. */
  private readonly resuming = new Map<TaskEntry, {
    reference: SerializedTaskReference;
    abort: AbortController;
    resumed: Promise<BackgroundToolExecution | undefined>;
  }>();
  /** Set once a session that persists its tasks starts stopping; see the ownership note below. */
  private stopping = false;

  constructor(
    private readonly manager: Pick<McpServerManager, "decrementInFlight" | "touch">,
    private readonly sendMessage: SendMessageFn,
    private readonly ownerSignal: AbortSignal,
    private readonly onChange: () => void = () => {},
    /** Records a task handed off by a stopping session. Without it, stopping the session cancels its tasks. */
    private readonly persistHandedOff?: (task: HandedOffTask) => void,
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
    return new Promise((finish) => {
      const { execution, ...rest } = task;
      const entry = this.entry(rest, finish);
      if (this.stopping) void this.persistOnStop(entry, execution);
      else this.follow(entry, entry.generation, execution);
    });
  }

  /**
   * Follows a task this session handed off when it last stopped, resuming it on
   * `session`. The caller holds the server's in-flight count, as for `start()`.
   */
  restore(task: RestoredTask, session: ReplacementTaskSession): Promise<void> {
    return new Promise((finish) => {
      const { reference, ...rest } = task;
      const entry = this.entry({ ...rest, taskId: reference.taskId }, finish);
      void this.resumeOn(entry, entry.generation, reference, session);
    });
  }

  /**
   * Moves every task on `server` from its replaced connection to the fresh one
   * without cancelling it. Resolves once the old executions have settled, so
   * closing the old task session afterwards sends no `tasks/cancel`.
   */
  async handOver(server: string, fresh: ReplacementTaskSession): Promise<void> {
    const entries = [...this.running.values()].filter((entry) => entry.server === server);
    const restores = [...this.resuming].filter(([entry]) => entry.server === server);
    await Promise.all([
      ...entries.map(async (entry) => {
        const old = entry.execution;
        const generation = this.takeOver(entry);
        let reference: SerializedTaskReference | undefined;
        await old.handoff((ref) => { reference = ref; });
        // close() cancels an execution that has not settled yet; result() settles it.
        await old.result();
        if (!this.owns(entry, generation)) return this.relinquish(entry, generation);
        await this.resumeOn(entry, generation, reference!, fresh, old);
      }),
      ...restores.map(async ([entry, restore]) => {
        const generation = this.takeOver(entry);
        // Ends only the local wait on the old connection: an execution it already resumed stops following
        // the task without cancelling it, and settling it means closing the old task session sends no cancel.
        restore.abort.abort();
        await (await restore.resumed)?.result();
        if (!this.owns(entry, generation)) return this.relinquish(entry, generation);
        await this.resumeOn(entry, generation, restore.reference, fresh);
      }),
    ]);
  }

  /**
   * For a stopping session: hands every task off without cancelling it and
   * records each, so the session can resume it when it starts again. Must run
   * before the owner stops, whose abort would cancel the tasks, and on every
   * session stop, since it also claims tasks still being restored or resumed.
   */
  async handOffForShutdown(): Promise<void> {
    if (this.persistHandedOff === undefined) return;
    this.stopping = true;
    await Promise.all([...this.running.values()].map(async (entry) => {
      this.takeOver(entry);
      // Final for this runtime: no later hand-over or stop may pick the task up again.
      this.remove(entry);
      await this.persistOnStop(entry, entry.execution);
    }));
  }

  private async persistOnStop(entry: TaskEntry, execution: BackgroundToolExecution): Promise<void> {
    const persist = this.persistHandedOff!;
    try {
      await execution.handoff((reference) => persist({ key: entry.info.key, server: entry.server, tool: entry.tool, reference }));
      await execution.result();
    } catch (error) {
      // Still owned by its task session, whose teardown cancels it as it did before.
      logger.warn(`MCP task ${entry.info.key} could not be handed off: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.release(entry);
    }
  }

  /*
   * Ownership: at most one continuation owns an entry at a time, the one whose
   * generation matches `entry.generation`: its follow chain, an in-flight
   * hand-over or restore, or a shutdown hand-off. Taking over bumps the
   * generation. After every await a continuation checks it still owns the
   * entry before any side effect (cancel, release, persist, delivery, adding
   * to `running`); one that lost ownership only detaches an execution it alone
   * holds, and releases the in-flight count only if nobody took the entry over.
   * Taking an entry out of `running` ends the contest for it, since every
   * take-over starts from `running`, or from `resuming` for a restore still
   * resuming, and an entry leaving `running` never re-enters either. Once the
   * session starts stopping, it owns every task, including one started after:
   * it takes over those in `running`, persists one that starts, and every other
   * continuation (a restore or resume in flight, a follow about to start) loses
   * ownership, so a restored record stays pending. A stopping session persists
   * its tasks and never cancels them.
   */
  private takeOver(entry: TaskEntry): number {
    entry.generation += 1;
    entry.releaseCancel();
    return entry.generation;
  }

  private owns(entry: TaskEntry, generation: number): boolean {
    return entry.generation === generation && !this.stopping;
  }

  private relinquish(entry: TaskEntry, generation: number, held?: BackgroundToolExecution): void {
    if (held !== undefined) void held.detach();
    if (entry.generation !== generation) return;
    this.takeOver(entry);
    this.release(entry);
  }

  private entry(task: Omit<BackgroundTaskStart, "execution">, finish: () => void): TaskEntry {
    return {
      ...task,
      info: { key: `${task.server}/${task.taskId}`, tool: task.tool, status: "working" },
      generation: 0,
      releaseCancel: () => {},
      finish,
    };
  }

  /** Resumes a handed-off task on `session`, or tells the model once why it can't be followed. */
  private async resumeOn(
    entry: TaskEntry,
    generation: number,
    reference: SerializedTaskReference,
    session: ReplacementTaskSession,
    old?: BackgroundToolExecution,
  ): Promise<void> {
    let resumed: Awaited<ReturnType<TaskEnabledSession["resumeTask"]>>;
    try {
      if (session.taskSession === undefined) throw new Error("the connection has no task session");
      const abort = new AbortController();
      const resuming = session.taskSession.resumeTask(reference, {
        ...(session.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: session.requestTimeoutMs }),
        signal: abort.signal,
      });
      const restore = old === undefined
        ? { reference, abort, resumed: resuming.then((execution) => execution.kind === "task" ? execution : undefined, () => undefined) }
        : undefined;
      if (restore !== undefined) this.resuming.set(entry, restore);
      try {
        resumed = await resuming;
      } finally {
        if (restore !== undefined && this.resuming.get(entry) === restore) this.resuming.delete(entry);
      }
      if (resumed.kind !== "task") throw new Error("resumeTask returned an immediate execution");
    } catch (error) {
      if (!this.owns(entry, generation)) return this.relinquish(entry, generation);
      this.remove(entry);
      try {
        if (this.ownerSignal.aborted || session.closed()) {
          // A restore cut short by another stop delivers nothing, so the session's record still says pending.
          if (old === undefined) return;
          // A close that cut a hand-over short cancels, as it would have without it. A stopping session that
          // persists its tasks has taken the entry over by now, so this cancel is only for one that doesn't.
          // The replaced connection stays open until handOver returns, and a detached execution can still cancel.
          await old.cancel().catch(() => {});
          this.deliver(entry, "cancelled", await entry.guard(`The connection to ${entry.server} closed.`));
        } else {
          logger.warn(`MCP task ${entry.info.key} could not be resumed: ${error instanceof Error ? error.message : String(error)}`);
          const reason = unfollowableReason(entry.server, session, error);
          this.deliver(entry, "unknown", await entry.guard(`${reason}. Calling the tool again may repeat the work.`));
        }
      } finally {
        this.release(entry);
      }
      return;
    }
    // The owner stopped during a restore: its record still says pending, so let the task run on.
    if (old === undefined && this.ownerSignal.aborted) return this.relinquish(entry, generation, resumed);
    this.follow(entry, generation, resumed);
  }

  private follow(entry: TaskEntry, generation: number, execution: BackgroundToolExecution): void {
    if (!this.owns(entry, generation)) return this.relinquish(entry, generation, execution);
    const running: RunningTask = Object.assign(entry, { execution });
    if (this.running.get(entry.info.key) !== running) {
      this.running.set(entry.info.key, running);
      this.onChange();
    }
    // The same cancel a blocking call sends when the runtime stops, ahead of the connection teardown.
    const cancel = () => void execution.cancel().catch(() => {});
    entry.releaseCancel = () => this.ownerSignal.removeEventListener("abort", cancel);
    if (this.ownerSignal.aborted) cancel();
    else this.ownerSignal.addEventListener("abort", cancel, { once: true });
    void execution.settle({
      onEvent: (event) => {
        const view = taskViewFromExecutionEvent(event);
        if (view === undefined || !this.owns(entry, generation)) return;
        entry.info.status = view.status;
        if (view.statusMessage === undefined) delete entry.info.statusMessage;
        else entry.info.statusMessage = view.statusMessage;
      },
    })
      .then(async ({ outcome }) => {
        if (!this.owns(entry, generation)) return;
        this.remove(entry);
        if (outcome.status === "completed") {
          const { resultType: _resultType, ...result } = outcome.result as Record<string, unknown>;
          this.deliver(entry, "completed", await entry.render(result));
        } else if (outcome.status === "failed" && !(outcome.error.cause instanceof TaskExecutionClosedError)) {
          this.deliver(entry, "failed", await entry.guard(outcome.error.message));
        } else {
          const reason = outcome.status === "failed"
            ? `The connection to ${entry.server} closed.`
            : entry.stoppedBy !== undefined
              ? `Stopped by ${entry.stoppedBy}.`
              : outcome.task?.statusMessage ?? "Task was cancelled by the server";
          this.deliver(entry, "cancelled", await entry.guard(reason));
        }
      })
      .catch((error: unknown) => {
        logger.warn(`MCP task ${entry.info.key} could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        // Nobody took over: this chain still holds the in-flight count, even if the session started stopping.
        if (entry.generation === generation) this.release(entry);
      });
  }

  private deliver(entry: TaskEntry, status: keyof typeof OUTCOME_ERRORS, body: RenderedTaskResult): void {
    const error = OUTCOME_ERRORS[status];
    this.sendMessage({
      customType: MCP_TASK_RESULT_TYPE,
      display: true,
      content: [{ type: "text", text: `MCP task ${entry.taskId} (${entry.server}/${entry.tool}) ${status === "unknown" ? "outcome unknown" : status}.` }, ...body.content],
      details: { task: { id: entry.taskId, server: entry.server, tool: entry.tool, status }, ...(error ? { error } : {}), ...body.details },
    }, { triggerTurn: true, deliverAs: "followUp" });
  }

  // A list must never show a settled task, so the entry goes before the outcome is delivered.
  private remove(entry: TaskEntry): void {
    if (this.running.get(entry.info.key) !== entry) return;
    this.running.delete(entry.info.key);
    this.onChange();
  }

  private release(entry: TaskEntry): void {
    this.remove(entry);
    entry.releaseCancel();
    this.manager.decrementInFlight(entry.server);
    this.manager.touch(entry.server);
    entry.finish();
  }
}
