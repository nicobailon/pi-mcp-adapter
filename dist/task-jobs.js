import { TaskExecutionClosedError, taskViewFromExecutionEvent, } from "@modelcontextprotocol/ext-tasks/client";
import { logger } from "./logger.js";
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
 * cancels the remote task; replacing the connection hands it over instead.
 */
export class BackgroundTaskRegistry {
    manager;
    sendMessage;
    ownerSignal;
    onChange;
    running = new Map();
    constructor(manager, sendMessage, ownerSignal, onChange = () => { }) {
        this.manager = manager;
        this.sendMessage = sendMessage;
        this.ownerSignal = ownerSignal;
        this.onChange = onChange;
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
        const key = `${task.server}/${task.taskId}`;
        return new Promise((finish) => {
            const entry = {
                ...task,
                info: { key, tool: task.tool, status: "working" },
                generation: 0,
                releaseCancel: () => { },
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
    async handOver(server, fresh) {
        const entries = [...this.running.values()].filter((entry) => entry.server === server);
        await Promise.all(entries.map(async (entry) => {
            const old = entry.execution;
            entry.generation += 1;
            entry.releaseCancel();
            try {
                let reference;
                await old.handoff((ref) => { reference = ref; });
                // close() cancels an execution that has not settled yet; result() settles it.
                await old.result();
                if (fresh.taskSession === undefined)
                    throw new Error("the new connection has no task session");
                const resumed = await fresh.taskSession.resumeTask(reference, {
                    ...(fresh.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: fresh.requestTimeoutMs }),
                });
                if (resumed.kind !== "task")
                    throw new Error("resumeTask returned an immediate execution");
                this.follow(entry, resumed);
            }
            catch (error) {
                const identity = { id: entry.taskId, server: entry.server, tool: entry.tool };
                try {
                    // A close or session stop that cut the resume short cancels, as it would have without the hand-off.
                    // The replaced connection stays open until this returns, and a detached execution can still cancel.
                    if (this.ownerSignal.aborted || fresh.closed()) {
                        await old.cancel().catch(() => { });
                        const guarded = await entry.guard(`The connection to ${entry.server} closed.`);
                        this.sendMessage({
                            customType: "mcp-task-result",
                            display: true,
                            content: [{ type: "text", text: `MCP task ${entry.taskId} (${entry.server}/${entry.tool}) cancelled.` }, ...guarded.content],
                            details: { task: { ...identity, status: "cancelled" }, error: "task_cancelled", ...guarded.details },
                        }, { triggerTurn: true, deliverAs: "followUp" });
                    }
                    else {
                        logger.warn(`MCP task ${entry.info.key} could not be resumed: ${error instanceof Error ? error.message : String(error)}`);
                        this.sendMessage({
                            customType: "mcp-task-result",
                            display: true,
                            content: [{
                                    type: "text",
                                    text: `MCP task ${entry.taskId} (${entry.server}/${entry.tool}): outcome unknown after the connection was replaced. Calling the tool again may repeat the work.`,
                                }],
                            details: { task: { ...identity, status: "unknown" }, error: "task_outcome_unknown" },
                        }, { triggerTurn: true, deliverAs: "followUp" });
                    }
                }
                finally {
                    this.release(entry);
                }
            }
        }));
    }
    follow(entry, execution) {
        const generation = entry.generation;
        const current = () => entry.generation === generation;
        entry.execution = execution;
        // The same cancel a blocking call sends when the runtime stops, ahead of the connection teardown.
        const cancel = () => void execution.cancel().catch(() => { });
        entry.releaseCancel = () => this.ownerSignal.removeEventListener("abort", cancel);
        if (this.ownerSignal.aborted)
            cancel();
        else
            this.ownerSignal.addEventListener("abort", cancel, { once: true });
        const label = `MCP task ${entry.taskId} (${entry.server}/${entry.tool})`;
        const identity = { id: entry.taskId, server: entry.server, tool: entry.tool };
        void execution.settle({
            onEvent: (event) => {
                const view = taskViewFromExecutionEvent(event);
                if (view === undefined || !current())
                    return;
                entry.info.status = view.status;
                if (view.statusMessage === undefined)
                    delete entry.info.statusMessage;
                else
                    entry.info.statusMessage = view.statusMessage;
            },
        })
            .then(async ({ outcome }) => {
            if (!current())
                return;
            this.remove(entry);
            let message;
            if (outcome.status === "completed") {
                const { resultType: _resultType, ...result } = outcome.result;
                const rendered = await entry.render(result);
                message = {
                    content: [{ type: "text", text: `${label} completed.` }, ...rendered.content],
                    details: { task: { ...identity, status: "completed" }, ...rendered.details },
                };
            }
            else if (outcome.status === "failed" && !(outcome.error.cause instanceof TaskExecutionClosedError)) {
                const guarded = await entry.guard(outcome.error.message);
                message = {
                    content: [{ type: "text", text: `${label} failed.` }, ...guarded.content],
                    details: { task: { ...identity, status: "failed" }, error: "task_failed", ...guarded.details },
                };
            }
            else {
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
            this.sendMessage({ customType: "mcp-task-result", display: true, ...message }, { triggerTurn: true, deliverAs: "followUp" });
        })
            .catch((error) => {
            logger.warn(`MCP task ${entry.info.key} could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
        })
            .finally(() => {
            if (current())
                this.release(entry);
        });
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