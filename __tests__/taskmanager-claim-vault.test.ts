import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TaskManagerClaimVault,
  captureTaskManagerResult,
  getTaskManagerClaimVault,
  isTaskManagerClaimTool,
  prepareTaskManagerArgs,
} from "../taskmanager-claim-vault.ts";

describe("TaskManager claim capability vault", () => {
  afterEach(() => vi.useRealTimers());

  const claim = (token = "raw-secret") => ({
    structuredContent: {
      claimed: true,
      task_id: "task_1",
      claim_token: token,
      claimed_until: "2099-08-26T02:00:00Z",
    },
    content: [{ type: "text", text: "claimed" }],
  });

  it("returns an opaque handle and keeps the token out of the result", () => {
    const vault = new TaskManagerClaimVault("session-a");
    const result = captureTaskManagerResult(vault, "taskmanager", "claim_task", claim(), { task_id: "task_1" }) as any;
    const handle = result.structuredContent.claim_handle;

    expect(handle).toMatch(/^claim_/);
    expect(JSON.stringify(result)).not.toContain("raw-secret");
    expect(vault.listMetadata()).toEqual([expect.objectContaining({ taskId: "task_1", claimedUntil: "2099-08-26T02:00:00Z" })]);
    expect(vault.listMetadata()[0]).not.toHaveProperty("token");
  });

  it("captures, redacts, renews, and releases FastMCP JSON-string results", () => {
    const vault = new TaskManagerClaimVault("session-fastmcp");
    const claimPayload = JSON.stringify({
      id: "1",
      claimed: true,
      claim_token: "fastmcp-secret",
      claimed_until: "2099-08-26T02:00:00Z",
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
      structuredContent: { result: JSON.stringify({ renewed: true, claimed_until: "2099-08-26T03:00:00Z" }) },
    }, { claim_handle: handle });
    expect(vault.listMetadata()[0]).toMatchObject({ claimedUntil: "2099-08-26T03:00:00Z", uncertain: false });

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
      structuredContent: { renewed: true, claimed_until: "2099-08-26T03:00:00Z" },
    }, { claim_handle: handle }) as any;
    expect(JSON.stringify(renewed)).not.toContain("raw-secret");
    expect(vault.listMetadata()[0]).toMatchObject({ claimedUntil: "2099-08-26T03:00:00Z", uncertain: false, timestampValid: true });

    captureTaskManagerResult(vault, "taskmanager", "renew_task_claim", {
      structuredContent: { renewed: true, claimed_until: "malformed" },
    }, { claim_handle: handle });
    expect(vault.listMetadata()[0]).toMatchObject({ claimedUntil: "malformed", uncertain: true, timestampValid: false });
  });

  it("purges expired process-local capabilities", () => {
    const vault = new TaskManagerClaimVault("session-expired", new Map());
    const result = captureTaskManagerResult(vault, "taskmanager", "claim_task", {
      structuredContent: {
        claimed: true,
        task_id: "task_expired",
        claim_token: "expired-secret",
        claimed_until: "2000-01-01T00:00:00Z",
      },
    }, { task_id: "task_expired" }) as any;

    expect(() => prepareTaskManagerArgs(vault, "taskmanager", "renew_task_claim", {
      claim_handle: result.structuredContent.claim_handle,
    })).toThrow("Unknown or expired TaskManager claim handle");
    expect(vault.listMetadata()).toEqual([]);
  });

  it("retains capabilities across adapter state cleanup and module reload", async () => {
    const stableScope = {};
    const cleanups: Array<() => void | Promise<void>> = [];
    vi.resetModules();
    const firstModule = await import("../taskmanager-claim-vault.ts");
    const first = firstModule.getTaskManagerClaimVault(stableScope, { addCleanup: cleanup => cleanups.push(cleanup) });
    const result = firstModule.captureTaskManagerResult(first, "taskmanager", "claim_task", {
      structuredContent: {
        claimed: true,
        task_id: "task_reload",
        claim_token: "reload-secret",
        claimed_until: "2099-08-26T02:00:00Z",
      },
    }, { task_id: "task_reload" }) as any;
    const handle = result.structuredContent.claim_handle;

    expect(cleanups).toEqual([]);
    vi.resetModules();
    const reloadedModule = await import("../taskmanager-claim-vault.ts");
    const reloaded = reloadedModule.getTaskManagerClaimVault(stableScope);
    expect(reloadedModule.prepareTaskManagerArgs(reloaded, "taskmanager", "renew_task_claim", { claim_handle: handle })).toEqual({
      task_id: "task_reload",
      claim_token: "reload-secret",
    });

    reloaded.destroy();
  });

  it("keeps destroy scoped to one adapter session", () => {
    const first = getTaskManagerClaimVault({});
    const second = getTaskManagerClaimVault({});
    const firstResult = captureTaskManagerResult(first, "taskmanager", "claim_task", claim("first-secret"), { task_id: "task_1" }) as any;
    const secondResult = captureTaskManagerResult(second, "taskmanager", "claim_task", claim("second-secret"), { task_id: "task_1" }) as any;

    first.destroy();
    expect(() => prepareTaskManagerArgs(first, "taskmanager", "renew_task_claim", {
      claim_handle: firstResult.structuredContent.claim_handle,
    })).toThrow("Unknown or expired TaskManager claim handle");
    expect(prepareTaskManagerArgs(second, "taskmanager", "renew_task_claim", {
      claim_handle: secondResult.structuredContent.claim_handle,
    })).toMatchObject({ claim_token: "second-secret" });

    second.destroy();
  });

  it("bounds retained process-local capabilities", () => {
    const vault = new TaskManagerClaimVault("session-bounded", new Map());
    const handles = Array.from({ length: 101 }, (_, index) => {
      const result = captureTaskManagerResult(vault, "taskmanager", "claim_task", claim(`secret-${index}`), { task_id: "task_1" }) as any;
      return result.structuredContent.claim_handle as string;
    });

    expect(vault.listMetadata()).toHaveLength(100);
    expect(() => prepareTaskManagerArgs(vault, "taskmanager", "renew_task_claim", { claim_handle: handles[0] })).toThrow("Unknown");
    expect(prepareTaskManagerArgs(vault, "taskmanager", "renew_task_claim", { claim_handle: handles[100] })).toMatchObject({
      claim_token: "secret-100",
    });
    vault.destroy();
  });

  it("expires malformed-timestamp capabilities after the fallback TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const vault = new TaskManagerClaimVault("session-malformed", new Map());
    const result = captureTaskManagerResult(vault, "taskmanager", "claim_task", {
      structuredContent: {
        claimed: true,
        task_id: "task_malformed",
        claim_token: "malformed-secret",
        claimed_until: "not-a-timestamp",
      },
    }, { task_id: "task_malformed" }) as any;

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(() => prepareTaskManagerArgs(vault, "taskmanager", "renew_task_claim", {
      claim_handle: result.structuredContent.claim_handle,
    })).toThrow("Unknown or expired TaskManager claim handle");
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

  it("purges capabilities after every successful completion operation", () => {
    for (const toolName of ["complete_task", "complete_task_from_pr"]) {
      const vault = new TaskManagerClaimVault(`session-${toolName}`);
      const result = captureTaskManagerResult(vault, "taskmanager", "claim_task", claim(toolName), { task_id: "task_1" }) as any;
      const handle = result.structuredContent.claim_handle;

      captureTaskManagerResult(vault, "taskmanager", toolName, {
        structuredContent: { completed: true, status: "completed" },
      }, { claim_handle: handle });
      expect(vault.listMetadata()).toEqual([]);
    }
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
    expect(isTaskManagerClaimTool("taskmanager", "create_task_blocker")).toBe(true);
  });
});
