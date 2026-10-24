import { describe, expect, it } from "vitest";
import type { SerializedTaskReference } from "@modelcontextprotocol/ext-tasks/client";
import { MCP_TASK_CUSTOM_TYPE, pendingTaskEntry, pendingTasksFromBranch, settledTaskEntry } from "../task-entries.ts";

const reference = { endpointId: "endpoint-1", generation: "v2", taskId: "t-1", originalOperation: "tools/call" } as SerializedTaskReference;
const task = { key: "ci/t-1", server: "ci", tool: "build", reference };
const custom = (data: unknown) => ({ type: "custom", customType: MCP_TASK_CUSTOM_TYPE, data });

describe("background task session entries", () => {
  it("resumes a task whose last entry in this session is pending", () => {
    expect(pendingTasksFromBranch([custom(pendingTaskEntry("s-1", task))], "s-1")).toEqual([task]);
  });

  it("skips a task whose last entry is settled, and resumes one stopped again after a restore", () => {
    const settled = [custom(pendingTaskEntry("s-1", task)), custom(settledTaskEntry("s-1", "ci/t-1"))];
    expect(pendingTasksFromBranch(settled, "s-1")).toEqual([]);
    expect(pendingTasksFromBranch([...settled.slice(0, 1), custom(pendingTaskEntry("s-1", task))], "s-1")).toEqual([task]);
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
      { version: 1, kind: "settled", sessionId: "s-1" },
      "pending",
    ];
    expect(pendingTasksFromBranch([...invalid.map(custom), { type: "custom", customType: "other", data: valid }], "s-1")).toEqual([]);
  });
});
