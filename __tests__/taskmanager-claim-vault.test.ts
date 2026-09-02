import { describe, expect, it } from "vitest";
import {
  TaskManagerClaimVault,
  captureTaskManagerResult,
  isTaskManagerClaimTool,
  prepareTaskManagerArgs,
} from "../taskmanager-claim-vault.ts";

describe("TaskManager claim capability vault", () => {
  const claim = (token = "raw-secret") => ({
    structuredContent: {
      claimed: true,
      task_id: "task_1",
      claim_token: token,
      claimed_until: "2026-08-26T02:00:00Z",
    },
    content: [{ type: "text", text: "claimed" }],
  });

  it("returns an opaque handle and keeps the token out of the result", () => {
    const vault = new TaskManagerClaimVault("session-a");
    const result = captureTaskManagerResult(vault, "taskmanager", "claim_task", claim(), { task_id: "task_1" }) as any;
    const handle = result.structuredContent.claim_handle;

    expect(handle).toMatch(/^claim_/);
    expect(JSON.stringify(result)).not.toContain("raw-secret");
    expect(vault.listMetadata()).toEqual([expect.objectContaining({ taskId: "task_1", claimedUntil: "2026-08-26T02:00:00Z" })]);
    expect(vault.listMetadata()[0]).not.toHaveProperty("token");
  });

  it("captures, redacts, renews, and releases FastMCP JSON-string results", () => {
    const vault = new TaskManagerClaimVault("session-fastmcp");
    const claimPayload = JSON.stringify({
      id: "1",
      claimed: true,
      claim_token: "fastmcp-secret",
      claimed_until: "2026-08-26T02:00:00Z",
    });
    const result = captureTaskManagerResult(vault, "taskmanager", "claim_task", {
      structuredContent: { result: claimPayload },
      content: [{ type: "text", text: claimPayload }],
    }, { task_id: "1" }) as any;
    const handle = result.structuredContent.claim_handle;

    expect(handle).toMatch(/^claim_/);
    expect(JSON.stringify(result)).not.toContain("fastmcp-secret");
    expect(JSON.parse((result.content[0] as any).text)).toMatchObject({ claim_handle: handle });
    expect(JSON.parse(result.structuredContent.result)).toMatchObject({ claim_handle: handle });
    expect((result.content[0] as any).text).not.toContain("fastmcp-secret");
    expect(result.structuredContent.result).not.toContain("fastmcp-secret");
    expect(prepareTaskManagerArgs(vault, "taskmanager", "renew_task_claim", { claim_handle: handle })).toEqual({
      task_id: "1",
      claim_token: "fastmcp-secret",
    });

    captureTaskManagerResult(vault, "taskmanager", "renew_task_claim", {
      structuredContent: { result: JSON.stringify({ renewed: true, claimed_until: "2026-08-26T03:00:00Z" }) },
    }, { claim_handle: handle });
    expect(vault.listMetadata()[0]).toMatchObject({ claimedUntil: "2026-08-26T03:00:00Z", uncertain: false });

    captureTaskManagerResult(vault, "taskmanager", "release_task_claim", {
      structuredContent: { result: JSON.stringify({ released: true, status: "pending" }) },
    }, { claim_handle: handle });
    expect(vault.listMetadata()).toEqual([]);
  });

  it("resolves only matching handles and updates renewal metadata", () => {
    const vault = new TaskManagerClaimVault("session-a");
    const result = captureTaskManagerResult(vault, "taskmanager", "claim_task", claim(), { task_id: "task_1" }) as any;
    const handle = result.structuredContent.claim_handle;

    expect(prepareTaskManagerArgs(vault, "taskmanager", "renew_task_claim", { claim_handle: handle, disposition: "retain" })).toEqual({
      claim_token: "raw-secret",
      task_id: "task_1",
      disposition: "retain",
    });
    expect(() => prepareTaskManagerArgs(vault, "taskmanager", "renew_task_claim", { task_id: "task_1", claim_handle: handle })).toThrow("already binds task_id");
    expect(() => prepareTaskManagerArgs(vault, "taskmanager", "renew_task_claim", { task_id: "task_2", claim_handle: handle })).toThrow("already binds task_id");

    const renewed = captureTaskManagerResult(vault, "taskmanager", "renew_task_claim", {
      structuredContent: { renewed: true, claimed_until: "2026-08-26T03:00:00Z" },
    }, { claim_handle: handle }) as any;
    expect(JSON.stringify(renewed)).not.toContain("raw-secret");
    expect(vault.listMetadata()[0]).toMatchObject({ claimedUntil: "2026-08-26T03:00:00Z", uncertain: false, timestampValid: true });

    captureTaskManagerResult(vault, "taskmanager", "renew_task_claim", {
      structuredContent: { renewed: true, claimed_until: "malformed" },
    }, { claim_handle: handle });
    expect(vault.listMetadata()[0]).toMatchObject({ claimedUntil: "malformed", uncertain: true, timestampValid: false });
  });

  it("retains malformed lease timestamps as uncertain without rewriting them", () => {
    const vault = new TaskManagerClaimVault();
    captureTaskManagerResult(vault, "taskmanager", "claim_task", {
      structuredContent: { claimed: true, task_id: "task_1", claim_token: "secret-3", claimed_until: "not-a-timestamp" },
    }, { task_id: "task_1" });
    expect(vault.listMetadata()[0]).toMatchObject({ claimedUntil: "not-a-timestamp", timestampValid: false, uncertain: true });
  });

  it("retains uncertain receipts and deletes them after terminal success", () => {
    const vault = new TaskManagerClaimVault();
    const result = captureTaskManagerResult(vault, "nexus", "claim_task", claim("secret-2"), { task_id: "task_1" }) as any;
    const handle = result.structuredContent.claim_handle;

    captureTaskManagerResult(vault, "nexus", "release_task_claim", { structuredContent: { released: false } }, { claim_handle: handle });
    expect(vault.listMetadata()[0]).toMatchObject({ uncertain: true });
    captureTaskManagerResult(vault, "nexus", "release_task_claim", { isError: true, structuredContent: { error: "timeout" } }, { claim_handle: handle });
    expect(vault.listMetadata()[0]).toMatchObject({ uncertain: true });
    captureTaskManagerResult(vault, "nexus", "release_task_claim", { structuredContent: { released: true } }, { claim_handle: handle });
    expect(vault.listMetadata()).toEqual([]);
  });

  it("captures capabilities from every claim-producing TaskManager operation", () => {
    for (const toolName of ["claim_task", "resolve_and_claim_task", "resolve_blocker_and_claim_task"]) {
      const vault = new TaskManagerClaimVault(`session-${toolName}`);
      const result = captureTaskManagerResult(vault, "taskmanager", toolName, claim(toolName), { task_id: "task_1" }) as any;
      expect(result.structuredContent.claim_handle).toMatch(/^claim_/);
      expect(vault.listMetadata()).toHaveLength(1);
    }
  });

  it("rejects unknown handles and ignores unrelated servers", () => {
    const vault = new TaskManagerClaimVault();
    expect(() => prepareTaskManagerArgs(vault, "taskmanager", "complete_task", { claim_handle: "claim_missing" })).toThrow("Unknown");
    expect(() => vault.validateArgs({ claim_token: "raw-secret" })).toThrow("Raw TaskManager claim_token");
    expect(isTaskManagerClaimTool("demo", "claim_task")).toBe(false);
    expect(isTaskManagerClaimTool("taskmanager", "claim_task")).toBe(true);
  });
});
