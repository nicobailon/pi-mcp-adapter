import type { HandedOffTask } from "./task-jobs.ts";
export declare const MCP_TASK_CUSTOM_TYPE = "mcp-task-v1";
/** The custom message a task's outcome reaches the model as. */
export declare const MCP_TASK_RESULT_TYPE = "mcp-task-result";
/** The session entry that lets a stopped session resume a background task when it starts again. */
export type McpTaskEntryV1 = {
    version: 1;
    kind: "pending";
    sessionId: string;
    key: string;
    server: string;
    tool: string;
    reference: {
        endpointId: string;
        generation: "v2";
        taskId: string;
        originalOperation: string;
    };
};
export declare function pendingTaskEntry(sessionId: string, task: HandedOffTask): McpTaskEntryV1;
/**
 * The tasks `sessionId` handed off whose outcome the model has not received
 * since: for each key the later of its pending entry and its delivered
 * outcome message decides. Entries are untrusted session data, so invalid ones are ignored.
 */
export declare function pendingTasksFromBranch(branchEntries: readonly unknown[], sessionId: string): HandedOffTask[];
