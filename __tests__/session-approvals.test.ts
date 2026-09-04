import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "../state.ts";
import { ConsentManager } from "../consent-manager.ts";
import {
  MCP_APPROVAL_CUSTOM_TYPE,
  computeToolArgumentsHash,
  computeToolDefinitionHash,
  createSessionApprovalWriter,
  getToolApprovalIdentity,
  makeToolApprovalKey,
  rememberToolApproval,
  restoreSessionApprovalState,
  type SessionApprovalEntry,
} from "../session-approvals.ts";

const tool = {
  originalName: "search",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
  },
  resourceUri: undefined,
  uiResourceUri: "ui://demo/search",
};

function createState(mode: "never" | "once-per-server" | "always" = "once-per-server", persist?: (entry: SessionApprovalEntry) => void): McpExtensionState {
  return {
    approvedToolCalls: new Map(),
    consentManager: new ConsentManager(mode, persist),
  } as unknown as McpExtensionState;
}

function custom(data: unknown): unknown {
  return { type: "custom", customType: MCP_APPROVAL_CUSTOM_TYPE, data };
}

describe("session approval persistence", () => {
  it("hashes normalized arguments and the effective tool definition deterministically", () => {
    expect(computeToolArgumentsHash({ query: "demo", options: { limit: 5, reverse: true } }))
      .toBe(computeToolArgumentsHash({ options: { reverse: true, limit: 5 }, query: "demo" }));
    expect(computeToolArgumentsHash({ query: "other" })).not.toBe(computeToolArgumentsHash({ query: "demo" }));

    const sameDefinition = {
      ...tool,
      inputSchema: { properties: { query: { type: "string" } }, type: "object" },
    };
    expect(computeToolDefinitionHash(tool)).toBe(computeToolDefinitionHash(sameDefinition));
    expect(computeToolDefinitionHash(tool)).not.toBe(computeToolDefinitionHash({
      ...tool,
      inputSchema: { type: "object", properties: { query: { type: "number" } } },
    }));
    expect(computeToolDefinitionHash(tool)).not.toBe(computeToolDefinitionHash({ ...tool, resourceUri: "mcp://demo/search" }));
    expect(computeToolDefinitionHash(tool)).not.toBe(computeToolDefinitionHash({ ...tool, uiResourceUri: "ui://demo/other" }));
  });

  it("writes only versioned names and hashes through the Pi custom-entry sink", () => {
    const appendEntry = vi.fn();
    const writer = createSessionApprovalWriter(appendEntry);
    const identity = getToolApprovalIdentity("demo", tool, { query: "private" });
    const record: SessionApprovalEntry = {
      version: 1,
      kind: "tool",
      decision: "allow_for_session",
      serverName: "demo",
      originalToolName: tool.originalName,
      definitionHash: identity.definitionHash,
      argsHash: identity.argsHash,
    };

    writer(record);

    expect(appendEntry).toHaveBeenCalledWith(MCP_APPROVAL_CUSTOM_TYPE, record);
  });

  it("restores only strict records from the active branch and does not re-emit them", () => {
    const appendEntry = vi.fn();
    const state = createState("once-per-server", (record) => appendEntry(MCP_APPROVAL_CUSTOM_TYPE, record));
    state.approvedToolCalls.set("stale", true);
    state.consentManager.registerDecision("stale-server", true);
    appendEntry.mockClear();

    const identity = getToolApprovalIdentity("demo", tool, { query: "safe" });
    const entries = [
      custom({
        version: 1,
        kind: "tool",
        decision: "allow_for_session",
        serverName: "demo",
        originalToolName: tool.originalName,
        definitionHash: identity.definitionHash,
        argsHash: identity.argsHash,
      }),
      custom({ version: 1, kind: "iframe", decision: "allow", serverName: "demo" }),
      custom({ version: 1, kind: "iframe", decision: "deny", serverName: "denied" }),
      custom({ version: 1, kind: "iframe", decision: "allow", serverName: "denied" }),
      custom({
        version: 1,
        kind: "tool",
        decision: "allow_for_session",
        serverName: "malformed",
        originalToolName: "search",
        definitionHash: identity.definitionHash,
        argsHash: identity.argsHash,
        rawArgs: { secret: "must not be accepted" },
      }),
      custom({ version: 2, kind: "iframe", decision: "allow", serverName: "unknown-version" }),
      { type: "custom", customType: "other-extension", data: { allow: true } },
    ];

    restoreSessionApprovalState(state, entries);

    expect(state.approvedToolCalls).toEqual(new Map([
      [makeToolApprovalKey("demo", tool.originalName, identity.definitionHash, identity.argsHash), true],
    ]));
    expect(() => state.consentManager.ensureApproved("demo")).not.toThrow();
    expect(() => state.consentManager.ensureApproved("denied")).not.toThrow();
    expect(() => state.consentManager.ensureApproved("stale-server")).toThrow(/approval required/);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("replays only the selected session branch", () => {
    const manager = SessionManager.inMemory("/tmp/pi-mcp-adapter-approvals");
    const first = getToolApprovalIdentity("demo", tool, { query: "ancestor" });
    const abandoned = getToolApprovalIdentity("demo", tool, { query: "abandoned" });
    const selected = getToolApprovalIdentity("demo", tool, { query: "selected" });
    const record = (identity: typeof first): SessionApprovalEntry => ({
      version: 1,
      kind: "tool",
      decision: "allow_for_session",
      serverName: "demo",
      originalToolName: tool.originalName,
      definitionHash: identity.definitionHash,
      argsHash: identity.argsHash,
    });

    const ancestorId = manager.appendCustomEntry(MCP_APPROVAL_CUSTOM_TYPE, record(first));
    manager.appendCustomEntry(MCP_APPROVAL_CUSTOM_TYPE, record(abandoned));
    manager.branch(ancestorId);
    manager.appendCustomEntry(MCP_APPROVAL_CUSTOM_TYPE, record(selected));

    const state = createState();
    restoreSessionApprovalState(state, manager.getBranch());

    expect(state.approvedToolCalls).toEqual(new Map([
      [makeToolApprovalKey("demo", tool.originalName, first.definitionHash, first.argsHash), true],
      [makeToolApprovalKey("demo", tool.originalName, selected.definitionHash, selected.argsHash), true],
    ]));
    expect(state.approvedToolCalls.has(makeToolApprovalKey(
      "demo",
      tool.originalName,
      abandoned.definitionHash,
      abandoned.argsHash,
    ))).toBe(false);
  });

  it("restores a persisted grant after reopening the session", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-mcp-adapter-approvals-"));
    try {
      const manager = SessionManager.create(root, join(root, "sessions"));
      const identity = getToolApprovalIdentity("demo", tool, { query: "persisted" });
      const record: SessionApprovalEntry = {
        version: 1,
        kind: "tool",
        decision: "allow_for_session",
        serverName: "demo",
        originalToolName: tool.originalName,
        definitionHash: identity.definitionHash,
        argsHash: identity.argsHash,
      };
      manager.appendCustomEntry(MCP_APPROVAL_CUSTOM_TYPE, record);
      manager.appendMessage({
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "openai",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });

      const resumed = SessionManager.open(manager.getSessionFile()!, join(root, "sessions"));
      const state = createState();
      restoreSessionApprovalState(state, resumed.getBranch());

      expect(state.approvedToolCalls).toEqual(new Map([
        [makeToolApprovalKey("demo", tool.originalName, identity.definitionHash, identity.argsHash), true],
      ]));
      const persistedEntry = resumed.getBranch().find(entry => entry.type === "custom");
      expect(persistedEntry).toMatchObject({
        type: "custom",
        customType: MCP_APPROVAL_CUSTOM_TYPE,
        data: record,
      });
      expect(persistedEntry).not.toHaveProperty("data.args");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves always and never consent mode semantics after restore", () => {
    const always = createState("always");
    restoreSessionApprovalState(always, [custom({ version: 1, kind: "iframe", decision: "allow", serverName: "demo" })]);
    expect(always.consentManager.requiresPrompt("demo")).toBe(true);
    expect(() => always.consentManager.ensureApproved("demo")).toThrow(/approval required/);

    const never = createState("never");
    restoreSessionApprovalState(never, [custom({ version: 1, kind: "iframe", decision: "deny", serverName: "demo" })]);
    expect(never.consentManager.requiresPrompt("demo")).toBe(false);
    expect(() => never.consentManager.ensureApproved("demo")).not.toThrow();
  });

  it("keeps an explicit in-memory grant when persistence fails", () => {
    const state = createState();
    state.persistSessionApproval = vi.fn(() => {
      throw new Error("no session");
    });
    const identity = getToolApprovalIdentity("demo", tool, {});

    rememberToolApproval(state, "demo", tool, {});

    expect(state.approvedToolCalls).toEqual(new Map([
      [makeToolApprovalKey("demo", tool.originalName, identity.definitionHash, identity.argsHash), true],
    ]));
  });
});
