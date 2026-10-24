import type { SerializedTaskReference } from "@modelcontextprotocol/ext-tasks/client";
import type { HandedOffTask } from "./task-jobs.ts";

export const MCP_TASK_CUSTOM_TYPE = "mcp-task-v1";

/** The session entry that lets a stopped session resume its background tasks when it starts again. */
export type McpTaskEntryV1 =
  | {
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
    }
  | {
      version: 1;
      kind: "settled";
      sessionId: string;
      key: string;
    };

const PENDING_KEYS = ["version", "kind", "sessionId", "key", "server", "tool", "reference"] as const;
const SETTLED_KEYS = ["version", "kind", "sessionId", "key"] as const;
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
  if (!isRecord(value) || value.version !== 1 || !isNonEmptyString(value.sessionId) || !isNonEmptyString(value.key)) return false;
  if (value.kind === "settled") return hasExactKeys(value, SETTLED_KEYS);
  if (value.kind !== "pending" || !hasExactKeys(value, PENDING_KEYS)) return false;
  const reference = value.reference;
  return isNonEmptyString(value.server)
    && isNonEmptyString(value.tool)
    && isRecord(reference)
    && hasExactKeys(reference, REFERENCE_KEYS)
    && reference.generation === "v2"
    && isNonEmptyString(reference.endpointId)
    && isNonEmptyString(reference.taskId)
    && isNonEmptyString(reference.originalOperation)
    && value.key === `${value.server}/${reference.taskId}`;
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

export function settledTaskEntry(sessionId: string, key: string): McpTaskEntryV1 {
  return { version: 1, kind: "settled", sessionId, key };
}

/**
 * The tasks `sessionId` handed off and has not settled since: for each key the
 * last valid entry decides. Entries are untrusted session data, so invalid ones are ignored.
 */
export function pendingTasksFromBranch(branchEntries: readonly unknown[], sessionId: string): HandedOffTask[] {
  const latest = new Map<string, McpTaskEntryV1>();
  for (const entry of branchEntries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== MCP_TASK_CUSTOM_TYPE) continue;
    if (!isTaskEntry(entry.data) || entry.data.sessionId !== sessionId) continue;
    latest.delete(entry.data.key);
    latest.set(entry.data.key, entry.data);
  }
  return [...latest.values()].flatMap(entry => entry.kind === "pending"
    ? [{ key: entry.key, server: entry.server, tool: entry.tool, reference: entry.reference as SerializedTaskReference }]
    : []);
}
