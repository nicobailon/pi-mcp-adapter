import type { SerializedTaskReference } from "@modelcontextprotocol/ext-tasks/client";
// Type-only, so index.ts can scan a session at startup without loading the task runtime.
import type { HandedOffTask } from "./task-jobs.ts";

export const MCP_TASK_CUSTOM_TYPE = "mcp-task-v1";

/** The custom message a task's outcome reaches the model as. */
export const MCP_TASK_RESULT_TYPE = "mcp-task-result";

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

const PENDING_KEYS = ["version", "kind", "sessionId", "key", "server", "tool", "reference"] as const;
const REFERENCE_KEYS = ["endpointId", "generation", "taskId", "originalOperation"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTaskEntry(value: unknown): value is McpTaskEntryV1 {
  if (!isRecord(value) || value.version !== 1 || value.kind !== "pending" || !hasExactKeys(value, PENDING_KEYS)) return false;
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
function deliveredTaskKey(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "custom_message" || entry.customType !== MCP_TASK_RESULT_TYPE || !isRecord(entry.details)) return undefined;
  const task = entry.details.task;
  return isRecord(task) && isNonEmptyString(task.server) && isNonEmptyString(task.id) ? `${task.server}/${task.id}` : undefined;
}

export function pendingTaskEntry(sessionId: string, task: HandedOffTask): McpTaskEntryV1 {
  if (task.reference.generation !== "v2") throw new Error(`MCP task ${task.key} has a ${task.reference.generation} reference`);
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
export function pendingTasksFromBranch(branchEntries: readonly unknown[], sessionId: string): HandedOffTask[] {
  const pending = new Map<string, McpTaskEntryV1>();
  for (const entry of branchEntries) {
    if (!isRecord(entry)) continue;
    const delivered = deliveredTaskKey(entry);
    if (delivered !== undefined) {
      pending.delete(delivered);
    } else if (entry.type === "custom" && entry.customType === MCP_TASK_CUSTOM_TYPE && isTaskEntry(entry.data) && entry.data.sessionId === sessionId) {
      pending.delete(entry.data.key);
      pending.set(entry.data.key, entry.data);
    }
  }
  return [...pending.values()].map(entry => ({
    key: entry.key,
    server: entry.server,
    tool: entry.tool,
    reference: entry.reference as SerializedTaskReference,
  }));
}
