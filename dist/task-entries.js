export const MCP_TASK_CUSTOM_TYPE = "mcp-task-v1";
/** The custom message a task's outcome reaches the model as. */
export const MCP_TASK_RESULT_TYPE = "mcp-task-result";
const PENDING_KEYS = ["version", "kind", "sessionId", "key", "server", "tool", "reference"];
const REFERENCE_KEYS = ["endpointId", "generation", "taskId", "originalOperation"];
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const actualKeys = Object.keys(value);
    return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isTaskEntry(value) {
    if (!isRecord(value) || value.version !== 1 || value.kind !== "pending" || !hasExactKeys(value, PENDING_KEYS))
        return false;
    const reference = value.reference;
    return isNonEmptyString(value.sessionId)
        && isNonEmptyString(value.server)
        && isNonEmptyString(value.tool)
        && isRecord(reference)
        && hasExactKeys(reference, REFERENCE_KEYS)
        && reference.generation === "v2"
        && isNonEmptyString(reference.endpointId)
        && isNonEmptyString(reference.taskId)
        && isNonEmptyString(reference.originalOperation)
        && value.key === `${value.server}/${reference.taskId}`;
}
/** The key of a task outcome message Pi persisted, which it does only once the model received it. */
function deliveredTaskKey(entry) {
    if (entry.type !== "custom_message" || entry.customType !== MCP_TASK_RESULT_TYPE || !isRecord(entry.details))
        return undefined;
    const task = entry.details.task;
    return isRecord(task) && isNonEmptyString(task.server) && isNonEmptyString(task.id) ? `${task.server}/${task.id}` : undefined;
}
export function pendingTaskEntry(sessionId, task) {
    if (task.reference.generation !== "v2")
        throw new Error(`MCP task ${task.key} has a ${task.reference.generation} reference`);
    const { endpointId, generation, taskId, originalOperation } = task.reference;
    return {
        version: 1,
        kind: "pending",
        sessionId,
        key: task.key,
        server: task.server,
        tool: task.tool,
        reference: { endpointId, generation, taskId, originalOperation },
    };
}
/**
 * The tasks `sessionId` handed off whose outcome the model has not received
 * since: for each key the later of its pending entry and its delivered
 * outcome message decides. Entries are untrusted session data, so invalid ones are ignored.
 */
export function pendingTasksFromBranch(branchEntries, sessionId) {
    const pending = new Map();
    for (const entry of branchEntries) {
        if (!isRecord(entry))
            continue;
        const delivered = deliveredTaskKey(entry);
        if (delivered !== undefined) {
            pending.delete(delivered);
        }
        else if (entry.type === "custom" && entry.customType === MCP_TASK_CUSTOM_TYPE && isTaskEntry(entry.data) && entry.data.sessionId === sessionId) {
            pending.delete(entry.data.key);
            pending.set(entry.data.key, entry.data);
        }
    }
    return [...pending.values()].map(entry => ({
        key: entry.key,
        server: entry.server,
        tool: entry.tool,
        reference: entry.reference,
    }));
}
//# sourceMappingURL=task-entries.js.map