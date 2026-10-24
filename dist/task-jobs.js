import { JsonRpcResponseError, TaskExecutionClosedError, taskViewFromExecutionEvent, } from "@modelcontextprotocol/ext-tasks/client";
import { logger } from "./logger.js";
/** The custom message a task's outcome reaches the model as. */
export const MCP_TASK_RESULT_TYPE = "mcp-task-result";
/** Each outcome's `details.error`; a completed task's result carries its own. */
const OUTCOME_ERRORS = { completed: undefined, failed: "task_failed", cancelled: "task_cancelled", unknown: "task_outcome_unknown" };
function unfollowableReason(server, session, error) {
    if (session.unavailable === "not-configured")
        return `Server '${server}' is not configured in this session; the task may still be running on it`;
    if (session.unavailable === "unreachable")
        return `Could not reach '${server}'`;
    // ext-tasks rejects resumeTask with this plain Error when the server's name now maps to another url or command.
    if (error instanceof Error && error.message === "Task reference belongs to a different endpoint") {
        return `Server '${server}' was reconfigured since this task started`;
    }
    // tasks/get answering -32602 (invalid params) is how a server says it doesn't know the task id.
    if (error instanceof JsonRpcResponseError && error.code === -32602)
        return "Expired on the server: outcome unknown";
    return "It could not be followed after its connection changed";
}
/**
 * The tool result a call returns once its task runs in the background. `cancelHint` names
 * mcp({ cancelTask }) only while the `mcp` tool exists to take it.
 */
export function backgroundTaskHandle(server, tool, taskId, cancelHint) {
    const hint = cancelHint ? ` To stop it, call mcp({ cancelTask: ${JSON.stringify(`${server}/${taskId}`)} }).` : "";
    return {
        content: [{
                type: "text",
                text: `Task ${taskId} started on ${server}/${tool}. Do not call the tool again; the result arrives later as an mcp-task-result message.${hint}`,
            }],
        task: { id: taskId, server, tool, status: "working" },
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
    manager;
    sendMessage;
    ownerSignal;
    onChange;
    persistHandedOff;
    running = new Map();
    /** Set once a session that persists its tasks starts stopping; see the ownership note below. */
    stopping = false;
    constructor(manager, sendMessage, ownerSignal, onChange = () => { }, 
    /** Records a task handed off by a stopping session. Without it, stopping the session cancels its tasks. */
    persistHandedOff) {
        this.manager = manager;
        this.sendMessage = sendMessage;
        this.ownerSignal = ownerSignal;
        this.onChange = onChange;
        this.persistHandedOff = persistHandedOff;
    }
    get size() {
        return this.running.size;
    }
    list() {
        return [...this.running.values()].map(({ info }) => ({ ...info }));
    }
    /** Resolves false for an unknown key; rejects when the cancel request fails. */
    async stop(key, by) {
        const entry = this.running.get(key);
        if (entry === undefined)
            return false;
        entry.stoppedBy = by;
        await entry.execution.cancel();
        return true;
    }
    /**
     * Takes over the call's in-flight count. Resolves once the outcome is
     * delivered and the count released.
     */
    start(task) {
        return new Promise((finish) => {
            const { execution, ...rest } = task;
            const entry = this.entry(rest, finish);
            if (this.stopping)
                void this.persistOnStop(entry, execution);
            else
                this.follow(entry, entry.generation, execution);
        });
    }
    /**
     * Follows a task this session handed off when it last stopped, resuming it on
     * `session`. The caller holds the server's in-flight count, as for `start()`.
     */
    restore(task, session) {
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
    async handOver(server, fresh) {
        const entries = [...this.running.values()].filter((entry) => entry.server === server);
        await Promise.all(entries.map(async (entry) => {
            const old = entry.execution;
            const generation = this.takeOver(entry);
            let reference;
            await old.handoff((ref) => { reference = ref; });
            // close() cancels an execution that has not settled yet; result() settles it.
            await old.result();
            if (!this.owns(entry, generation))
                return this.relinquish(entry, generation);
            await this.resumeOn(entry, generation, reference, fresh, old);
        }));
    }
    /**
     * For a stopping session: hands every task off without cancelling it and
     * records each, so the session can resume it when it starts again. Must run
     * before the owner stops, whose abort would cancel the tasks, and on every
     * session stop, since it also claims tasks still being restored or resumed.
     */
    async handOffForShutdown() {
        if (this.persistHandedOff === undefined)
            return;
        this.stopping = true;
        await Promise.all([...this.running.values()].map(async (entry) => {
            this.takeOver(entry);
            // Final for this runtime: no later hand-over or stop may pick the task up again.
            this.remove(entry);
            await this.persistOnStop(entry, entry.execution);
        }));
    }
    async persistOnStop(entry, execution) {
        const persist = this.persistHandedOff;
        try {
            await execution.handoff((reference) => persist({ key: entry.info.key, server: entry.server, tool: entry.tool, reference }));
            await execution.result();
        }
        catch (error) {
            // Still owned by its task session, whose teardown cancels it as it did before.
            logger.warn(`MCP task ${entry.info.key} could not be handed off: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
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
     * take-over starts from `running`. Once the session starts stopping, it owns
     * every task, including one started after: it takes over those in `running`,
     * persists one that starts, and every other continuation (a restore or resume
     * in flight, a follow about to start) loses ownership, so a restored record
     * stays pending. A stopping session persists its tasks and never cancels them.
     */
    takeOver(entry) {
        entry.generation += 1;
        entry.releaseCancel();
        return entry.generation;
    }
    owns(entry, generation) {
        return entry.generation === generation && !this.stopping;
    }
    relinquish(entry, generation, held) {
        if (held !== undefined)
            void held.detach();
        if (entry.generation !== generation)
            return;
        this.takeOver(entry);
        this.release(entry);
    }
    entry(task, finish) {
        return {
            ...task,
            info: { key: `${task.server}/${task.taskId}`, tool: task.tool, status: "working" },
            generation: 0,
            releaseCancel: () => { },
            finish,
        };
    }
    /** Resumes a handed-off task on `session`, or tells the model once why it can't be followed. */
    async resumeOn(entry, generation, reference, session, old) {
        let resumed;
        try {
            if (session.taskSession === undefined)
                throw new Error("the connection has no task session");
            resumed = await session.taskSession.resumeTask(reference, {
                ...(session.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: session.requestTimeoutMs }),
            });
            if (resumed.kind !== "task")
                throw new Error("resumeTask returned an immediate execution");
        }
        catch (error) {
            if (!this.owns(entry, generation))
                return this.relinquish(entry, generation);
            this.remove(entry);
            try {
                if (this.ownerSignal.aborted || session.closed()) {
                    // A restore cut short by another stop delivers nothing, so the session's record still says pending.
                    if (old === undefined)
                        return;
                    // A close that cut a hand-over short cancels, as it would have without it. A stopping session that
                    // persists its tasks has taken the entry over by now, so this cancel is only for one that doesn't.
                    // The replaced connection stays open until handOver returns, and a detached execution can still cancel.
                    await old.cancel().catch(() => { });
                    this.deliver(entry, "cancelled", await entry.guard(`The connection to ${entry.server} closed.`));
                }
                else {
                    logger.warn(`MCP task ${entry.info.key} could not be resumed: ${error instanceof Error ? error.message : String(error)}`);
                    const reason = unfollowableReason(entry.server, session, error);
                    this.deliver(entry, "unknown", await entry.guard(`${reason}. Calling the tool again may repeat the work.`));
                }
            }
            finally {
                this.release(entry);
            }
            return;
        }
        // The owner stopped during a restore: its record still says pending, so let the task run on.
        if (old === undefined && this.ownerSignal.aborted)
            return this.relinquish(entry, generation, resumed);
        this.follow(entry, generation, resumed);
    }
    follow(entry, generation, execution) {
        if (!this.owns(entry, generation))
            return this.relinquish(entry, generation, execution);
        const running = Object.assign(entry, { execution });
        if (this.running.get(entry.info.key) !== running) {
            this.running.set(entry.info.key, running);
            this.onChange();
        }
        // The same cancel a blocking call sends when the runtime stops, ahead of the connection teardown.
        const cancel = () => void execution.cancel().catch(() => { });
        entry.releaseCancel = () => this.ownerSignal.removeEventListener("abort", cancel);
        if (this.ownerSignal.aborted)
            cancel();
        else
            this.ownerSignal.addEventListener("abort", cancel, { once: true });
        void execution.settle({
            onEvent: (event) => {
                const view = taskViewFromExecutionEvent(event);
                if (view === undefined || !this.owns(entry, generation))
                    return;
                entry.info.status = view.status;
                if (view.statusMessage === undefined)
                    delete entry.info.statusMessage;
                else
                    entry.info.statusMessage = view.statusMessage;
            },
        })
            .then(async ({ outcome }) => {
            if (!this.owns(entry, generation))
                return;
            this.remove(entry);
            if (outcome.status === "completed") {
                const { resultType: _resultType, ...result } = outcome.result;
                this.deliver(entry, "completed", await entry.render(result));
            }
            else if (outcome.status === "failed" && !(outcome.error.cause instanceof TaskExecutionClosedError)) {
                this.deliver(entry, "failed", await entry.guard(outcome.error.message));
            }
            else {
                const reason = outcome.status === "failed"
                    ? `The connection to ${entry.server} closed.`
                    : entry.stoppedBy !== undefined
                        ? `Stopped by ${entry.stoppedBy}.`
                        : outcome.task?.statusMessage ?? "Task was cancelled by the server";
                this.deliver(entry, "cancelled", await entry.guard(reason));
            }
        })
            .catch((error) => {
            logger.warn(`MCP task ${entry.info.key} could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
        })
            .finally(() => {
            // Nobody took over: this chain still holds the in-flight count, even if the session started stopping.
            if (entry.generation === generation)
                this.release(entry);
        });
    }
    deliver(entry, status, body) {
        const error = OUTCOME_ERRORS[status];
        this.sendMessage({
            customType: MCP_TASK_RESULT_TYPE,
            display: true,
            content: [{ type: "text", text: `MCP task ${entry.taskId} (${entry.server}/${entry.tool}) ${status === "unknown" ? "outcome unknown" : status}.` }, ...body.content],
            details: { task: { id: entry.taskId, server: entry.server, tool: entry.tool, status }, ...(error ? { error } : {}), ...body.details },
        }, { triggerTurn: true, deliverAs: "followUp" });
    }
    // A list must never show a settled task, so the entry goes before the outcome is delivered.
    remove(entry) {
        if (this.running.get(entry.info.key) !== entry)
            return;
        this.running.delete(entry.info.key);
        this.onChange();
    }
    release(entry) {
        this.remove(entry);
        entry.releaseCancel();
        this.manager.decrementInFlight(entry.server);
        this.manager.touch(entry.server);
        entry.finish();
    }
}
//# sourceMappingURL=task-jobs.js.map