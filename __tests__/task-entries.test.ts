import { describe, expect, it } from "vitest";
import type { SerializedTaskReference } from "@modelcontextprotocol/ext-tasks/client";
import { MCP_TASK_CUSTOM_TYPE, pendingTaskEntry, pendingTasksFromBranch } from "../task-entries.ts";

const reference = { endpointId: "endpoint-1", generation: "v2", taskId: "t-1", originalOperation: "tools/call" } as SerializedTaskReference;
const task = { key: "ci/t-1", server: "ci", tool: "build", reference };
const custom = (data: unknown) => ({ type: "custom", customType: MCP_TASK_CUSTOM_TYPE, data });
/** The outcome message as Pi persists it once the model received it. */
const delivered = (server: string, id: string) => ({
  type: "custom_message",
  customType: "mcp-task-result",
  content: [{ type: "text", text: `MCP task ${id} (${server}/build) completed.` }],
  display: true,
  details: { task: { id, server, tool: "build", status: "completed" } },
});

describe("background task session entries", () => {
  it("resumes a task whose last entry in this session is pending", () => {
    expect(pendingTasksFromBranch([custom(pendingTaskEntry("s-1", task))], "s-1")).toEqual([task]);
  });

  it("does not resume a task whose outcome message the model already received", () => {
    expect(pendingTasksFromBranch([custom(pendingTaskEntry("s-1", task)), delivered("ci", "t-1")], "s-1")).toEqual([]);
    expect(pendingTasksFromBranch([custom(pendingTaskEntry("s-1", task)), delivered("ci", "t-2")], "s-1")).toEqual([task]);
    // Only the delivered message settles a task; no entry written by the adapter does.
    const writtenSettled = custom({ version: 1, kind: "settled", sessionId: "s-1", key: "ci/t-1" });
    expect(pendingTasksFromBranch([custom(pendingTaskEntry("s-1", task)), writtenSettled], "s-1")).toEqual([task]);
  });

  it("resumes a task stopped again after its outcome was delivered once", () => {
    const branch = [custom(pendingTaskEntry("s-1", task)), delivered("ci", "t-1"), custom(pendingTaskEntry("s-1", task))];
    expect(pendingTasksFromBranch(branch, "s-1")).toEqual([task]);
  });

  it("ignores another session's entries, so a fork does not pick up its parent's tasks", () => {
    expect(pendingTasksFromBranch([custom(pendingTaskEntry("parent", task))], "fork")).toEqual([]);
  });

  it("ignores entries that do not match the contract exactly", () => {
    const valid = pendingTaskEntry("s-1", task);
    const invalid = [
      { ...valid, extra: true },
      { ...valid, version: 2 },
      { ...valid, key: "ci/other" },
      { ...valid, reference: { ...reference, generation: "v1" } },
      { ...valid, reference: { ...reference, headers: {} } },
      "pending",
    ];
    expect(pendingTasksFromBranch([...invalid.map(custom), { type: "custom", customType: "other", data: valid }], "s-1")).toEqual([]);
  });
});
