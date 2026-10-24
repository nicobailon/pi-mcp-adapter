import { type SerializedTaskReference, type TaskEnabledSession, type TaskState } from "@modelcontextprotocol/ext-tasks/client";
import type { BackgroundToolExecution } from "./mcp-tasks.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { SendMessageFn } from "./state.ts";
import type { ContentBlock } from "./types.ts";
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
/** The custom message a task's outcome reaches the model as. */
export declare const MCP_TASK_RESULT_TYPE = "mcp-task-result";
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
/** What a replacement connection offers for resuming its server's tasks. */
export interface ReplacementTaskSession {
    taskSession?: TaskEnabledSession | undefined;
    requestTimeoutMs?: number | undefined;
    /** Whether the replacement connection has since been closed, by a disconnect, disable or session stop. */
    closed: () => boolean;
    /** Why there is no task session to resume on, when the caller knows. */
    unavailable?: "not-configured" | "unreachable" | undefined;
}
/**
 * The tool result a call returns once its task runs in the background. `cancelHint` names
 * mcp({ cancelTask }) only while the `mcp` tool exists to take it.
 */
export declare function backgroundTaskHandle(server: string, tool: string, taskId: string, cancelHint: boolean): {
    content: {
        type: "text";
        text: string;
    }[];
    task: {
        id: string;
        server: string;
        tool: string;
        status: "working";
    };
};
/**
 * Tool calls whose server answered with a task. Each runs to settlement here,
 * holding its server's in-flight count, and its outcome reaches the model as
 * one follow-up message. Stopping the runtime or closing the connection
 * cancels the remote task; replacing the connection hands it over instead,
 * and so does stopping the session, which can resume it when it starts again.
 */
export declare class BackgroundTaskRegistry {
    private readonly manager;
    private readonly sendMessage;
    private readonly ownerSignal;
    private readonly onChange;
    /** Records a task handed off by a stopping session. Without it, stopping the session cancels its tasks. */
    private readonly persistHandedOff?;
    private readonly running;
    /** Set once a session that persists its tasks starts stopping; see the ownership note below. */
    private stopping;
    constructor(manager: Pick<McpServerManager, "decrementInFlight" | "touch">, sendMessage: SendMessageFn, ownerSignal: AbortSignal, onChange?: () => void, 
    /** Records a task handed off by a stopping session. Without it, stopping the session cancels its tasks. */
    persistHandedOff?: ((task: HandedOffTask) => void) | undefined);
    get size(): number;
    list(): BackgroundTaskInfo[];
    /** Resolves false for an unknown key; rejects when the cancel request fails. */
    stop(key: string, by: "you" | "the agent"): Promise<boolean>;
    /**
     * Takes over the call's in-flight count. Resolves once the outcome is
     * delivered and the count released.
     */
    start(task: BackgroundTaskStart): Promise<void>;
    /**
     * Follows a task this session handed off when it last stopped, resuming it on
     * `session`. The caller holds the server's in-flight count, as for `start()`.
     */
    restore(task: RestoredTask, session: ReplacementTaskSession): Promise<void>;
    /**
     * Moves every task on `server` from its replaced connection to the fresh one
     * without cancelling it. Resolves once the old executions have settled, so
     * closing the old task session afterwards sends no `tasks/cancel`.
     */
    handOver(server: string, fresh: ReplacementTaskSession): Promise<void>;
    /**
     * For a stopping session: hands every task off without cancelling it and
     * records each, so the session can resume it when it starts again. Must run
     * before the owner stops, whose abort would cancel the tasks, and on every
     * session stop, since it also claims tasks still being restored or resumed.
     */
    handOffForShutdown(): Promise<void>;
    private persistOnStop;
    private takeOver;
    private owns;
    private relinquish;
    private entry;
    /** Resumes a handed-off task on `session`, or tells the model once why it can't be followed. */
    private resumeOn;
    private follow;
    private deliver;
    private remove;
    private release;
}
