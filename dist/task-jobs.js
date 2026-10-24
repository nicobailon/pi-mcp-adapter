import { TaskExecutionClosedError, taskViewFromExecutionEvent } from "@modelcontextprotocol/ext-tasks/client";
import { logger } from "./logger.js";
/** The tool result a call returns once its task runs in the background. */
export function backgroundTaskHandle(server, tool, taskId) {
    return {
        content: [{
                type: "text",
                text: `Task ${taskId} started on ${server}/${tool}. Do not call the tool again; the result arrives later as an mcp-task-result message.`,
            }],
        task: { id: taskId, server, tool, status: "working" },
    };
}
/**
 * Tool calls whose server answered with a task. Each runs to settlement here,
 * holding its server's in-flight count, and its outcome reaches the model as
 * one follow-up message. Stopping the runtime or closing the connection
 * cancels the remote task.
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
    async stop(key) {
        const entry = this.running.get(key);
        if (entry === undefined)
            return false;
        entry.stopRequested = true;
        await entry.execution.cancel();
        return true;
    }
    /**
     * Takes over the call's in-flight count. Resolves once the outcome is
     * delivered and the count released.
     */
    start(task) {
        const key = `${task.server}/${task.taskId}`;
        const entry = {
            info: { key, tool: task.tool, status: "working" },
            execution: task.execution,
            stopRequested: false,
        };
        this.running.set(key, entry);
        this.onChange();
        // A list must never show a settled task, so the entry goes before the outcome is delivered.
        const remove = () => {
            if (this.running.get(key) !== entry)
                return;
            this.running.delete(key);
            this.onChange();
        };
        // The same cancel a blocking call sends when the runtime stops, ahead of the connection teardown.
        const cancel = () => void task.execution.cancel().catch(() => { });
        if (this.ownerSignal.aborted)
            cancel();
        else
            this.ownerSignal.addEventListener("abort", cancel, { once: true });
        return task.execution.settle({
            onEvent: (event) => {
                const view = taskViewFromExecutionEvent(event);
                if (view === undefined)
                    return;
                entry.info.status = view.status;
                if (view.statusMessage === undefined)
                    delete entry.info.statusMessage;
                else
                    entry.info.statusMessage = view.statusMessage;
            },
        })
            .then(async ({ outcome }) => {
            remove();
            const label = `MCP task ${task.taskId} (${task.server}/${task.tool})`;
            const identity = { id: task.taskId, server: task.server, tool: task.tool };
            let message;
            if (outcome.status === "completed") {
                const { resultType: _resultType, ...result } = outcome.result;
                const rendered = await task.render(result);
                message = {
                    content: [{ type: "text", text: `${label} completed.` }, ...rendered.content],
                    details: { task: { ...identity, status: "completed" }, ...rendered.details },
                };
            }
            else if (outcome.status === "failed" && !(outcome.error.cause instanceof TaskExecutionClosedError)) {
                message = {
                    content: [{ type: "text", text: `${label} failed.` }, { type: "text", text: outcome.error.message }],
                    details: { task: { ...identity, status: "failed" }, error: "task_failed" },
                };
            }
            else {
                const reason = outcome.status === "failed"
                    ? `The connection to ${task.server} closed.`
                    : entry.stopRequested
                        ? "Stopped by you."
                        : outcome.task?.statusMessage ?? "Task was cancelled by the server";
                message = {
                    content: [{ type: "text", text: `${label} cancelled.` }, { type: "text", text: reason }],
                    details: { task: { ...identity, status: "cancelled" }, error: "task_cancelled" },
                };
            }
            this.sendMessage({ customType: "mcp-task-result", display: true, ...message }, { triggerTurn: true, deliverAs: "followUp" });
        })
            .catch((error) => {
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
//# sourceMappingURL=task-jobs.js.map