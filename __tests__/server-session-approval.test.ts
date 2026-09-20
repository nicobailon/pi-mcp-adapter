import { describe, expect, it, vi } from "vitest";
import { ensureToolCallApproved } from "../tool-approval.ts";
import { restoreSessionApprovalState } from "../session-approvals.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import type { McpExtensionState } from "../state.ts";
import type { McpToolApprovalRequest, ToolMetadata } from "../types.ts";

const choice = "Allow server for this session";
const tool: ToolMetadata = { name: "demo_search", originalName: "search", description: "Search" };
function fixture() {
  const select = vi.fn().mockResolvedValue(choice);
  const persist = vi.fn();
  const state = {
    owner: createMcpRuntimeOwner(),
    config: { settings: { approveTools: true }, mcpServers: { demo: { command: "demo" }, other: { command: "other" } } },
    approvedToolCalls: new Map(),
    approvedServers: new Map(),
    consentManager: { clear: vi.fn(), restoreDecision: vi.fn() },
    persistSessionApproval: persist,
    ui: { select },
  } as unknown as McpExtensionState;
  return { state, select, persist };
}

const approve = (state: McpExtensionState, server = "demo", meta = tool, args = {}, signal?: AbortSignal) =>
  ensureToolCallApproved(state, server, meta, args, signal);

describe("server-wide runtime approval", () => {
  it("offers an explicit fourth choice and permits new tools and arguments only on that server", async () => {
    const { state, select, persist } = fixture();
    expect(await approve(state)).toEqual({ ok: true });
    expect(select.mock.calls[0][1]).toEqual(["Allow once", "Allow for session", choice, "Deny"]);
    expect(select.mock.calls[0][0]).toContain("all tools and arguments on this server");
    for (const origin of ["proxy", "direct", "resource", "iframe", "script"] as const) {
      expect(await ensureToolCallApproved(state, "demo", {
        ...tool, originalName: "new-tool", name: "demo_new-tool", inputSchema: { type: "object" },
      }, { different: true }, undefined, origin)).toEqual({ ok: true });
    }
    expect(select).toHaveBeenCalledTimes(1);
    select.mockResolvedValue("Deny");
    expect(await approve(state, "other")).toEqual({ ok: false, reason: "denied" });
    expect(select).toHaveBeenCalledTimes(2);
    expect(state.approvedToolCalls.size).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps broker denial above broad approval", async () => {
    const { state, select } = fixture();
    await approve(state);
    state.approvalEvents = { emit: (_channel: string, request: McpToolApprovalRequest) => {
      request.claim(() => "deny");
    } } as never;
    expect(await approve(state)).toEqual({ ok: false, reason: "denied" });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it.each(["Deny", "Allow once", undefined])("does not broaden a %s decision", async decision => {
    const { state, select } = fixture();
    select.mockResolvedValue(decision);
    await approve(state);
    await approve(state);
    expect(state.approvedServers?.size).toBe(0);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("keeps existing per-tool session grants argument-scoped", async () => {
    const { state, select } = fixture();
    select.mockResolvedValue("Allow for session");
    await approve(state);
    await approve(state);
    await approve(state, "demo", tool, { changed: true });
    expect(select).toHaveBeenCalledTimes(2);
    expect(state.approvedServers?.size).toBe(0);
  });

  it("requires a human prompt when headless and does not restore broad grants from entries", async () => {
    const { state, select } = fixture();
    await approve(state);
    restoreSessionApprovalState(state, [{ type: "custom", customType: "mcp-approval-v1", data: {
      version: 1, kind: "server", serverName: "demo", decision: "allow_for_session",
    } }]);
    state.ui = undefined;
    expect(await approve(state)).toEqual({ ok: false, reason: "approval_required_headless" });
    expect(state.approvedServers?.size).toBe(0);
    expect(select).toHaveBeenCalledTimes(1);
    const fresh = fixture();
    fresh.state.ui = undefined;
    expect(await approve(fresh.state)).toEqual({ ok: false, reason: "approval_required_headless" });
  });

  it.each(["replace", "mutate"])("invalidates consent after server definition %s", async change => {
    const { state, select } = fixture();
    await approve(state);
    if (change === "replace") state.config.mcpServers.demo = { command: "demo" };
    else state.config.mcpServers.demo.command = "changed";
    select.mockResolvedValue("Deny");
    expect(await approve(state)).toEqual({ ok: false, reason: "denied" });
    expect(state.approvedServers?.size).toBe(0);
  });

  it.each(["branch", "definition", "shutdown", "abort"])("rejects stale pending consent after %s", async change => {
    const { state, select } = fixture();
    let resolve!: (value: string) => void;
    let shown!: () => void;
    const opened = new Promise<void>(done => { shown = done; });
    select.mockImplementation(() => { shown(); return new Promise<string>(done => { resolve = done; }); });
    const controller = new AbortController();
    const pending = approve(state, "demo", tool, {}, controller.signal);
    const outcome = pending.catch(() => ({ ok: false as const, reason: "aborted" }));
    await opened;
    if (change === "branch") restoreSessionApprovalState(state, []);
    if (change === "definition") state.config.mcpServers.demo = { command: "replacement" };
    if (change === "shutdown") await state.owner.stop();
    if (change === "abort") controller.abort();
    resolve(choice);
    expect(await outcome).toMatchObject({ ok: false });
    expect(state.approvedServers?.size).toBe(0);
  });

  it("does not reuse broad grants from stopped runtimes", async () => {
    const { state } = fixture();
    await approve(state);
    await state.owner.stop();
    await expect(approve(state)).rejects.toThrow();
    const next = fixture();
    next.select.mockResolvedValue("Deny");
    expect(await approve(next.state)).toEqual({ ok: false, reason: "denied" });
  });
});
