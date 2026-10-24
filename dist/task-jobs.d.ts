import { type TaskState } from "@modelcontextprotocol/ext-tasks/client";
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
/** A running task as `/mcp tasks` shows it. */
export interface BackgroundTaskInfo {
    /** `<server>/<taskId>`, the name `/mcp tasks stop` takes. */
    key: string;
    tool: string;
    status: TaskState;
    statusMessage?: string;
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
 * cancels the remote task.
 */
export declare class BackgroundTaskRegistry {
    private readonly manager;
    private readonly sendMessage;
    private readonly ownerSignal;
    private readonly onChange;
    private readonly running;
    constructor(manager: Pick<McpServerManager, "decrementInFlight" | "touch">, sendMessage: SendMessageFn, ownerSignal: AbortSignal, onChange?: () => void);
    get size(): number;
    list(): BackgroundTaskInfo[];
    /** Resolves false for an unknown key; rejects when the cancel request fails. */
    stop(key: string, by: "you" | "the agent"): Promise<boolean>;
    /**
     * Takes over the call's in-flight count. Resolves once the outcome is
     * delivered and the count released.
     */
    start(task: BackgroundTaskStart): Promise<void>;
}
