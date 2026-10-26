import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHostManagedMcpAdapter, HostManagedMcpError, type HostManagedMcpAdapter } from "../host-managed.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";
import {
  MAX_DENY_REASON_BYTES,
  approvalBlockedResult,
  ensureToolCallApproved,
  sanitizeDenyReason,
} from "../tool-approval.ts";
import { startUiServer, type UiServerHandle } from "../ui-server.ts";
import type { ConsentManager } from "../consent-manager.ts";
import type { McpServerManager, ServerConnection } from "../server-manager.ts";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalHandler, type McpToolApprovalRequest, type ToolMetadata } from "../types.ts";

const tool: ToolMetadata = { name: "demo_send", originalName: "send", description: "Send" };

function createState(broker: (request: McpToolApprovalRequest) => void) {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "called" }] });
  const connection = { status: "connected", client: { callTool }, tools: [{ name: "send", description: "Send" }], resources: [], prompts: [] };
  const state = {
    config: { mcpServers: { demo: { command: "demo" } } },
    toolMetadata: new Map([["demo", [tool]]]),
    resourceCounts: new Map(),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    approvedToolCalls: new Map<string, true>(),
    approvalEvents: { emit: vi.fn((channel: string, data: unknown) => {
      expect(channel).toBe(MCP_TOOL_APPROVAL_REQUEST_EVENT);
      broker(data as McpToolApprovalRequest);
    }) },
    manager: {
      getConnection: () => connection,
      getRequestOptions: () => undefined,
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    },
    failureTracker: new Map(),
    failureMessages: new Map(),
  } as unknown as McpExtensionState;
  return { state, callTool };
}

function claiming(handler: McpToolApprovalHandler) {
  return (request: McpToolApprovalRequest) => { request.claim(handler); };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";

describe("broker deny reason", () => {
  it("advertises the capability on every request", async () => {
    let seen: McpToolApprovalRequest | undefined;
    const { state } = createState((request) => { seen = request; request.claim(() => "allow_once"); });
    await executeCall(state, tool.name, {});
    expect(seen?.supportsDenyReason).toBe(true);
  });

  it("puts the reason into the proxy call's own result", async () => {
    const { state, callTool } = createState(claiming(() => ({ decision: "deny", reason: "Nie teraz" })));
    const result = await executeCall(state, tool.name, {});
    expect(text(result)).toBe('MCP tool "send" on server "demo" was blocked by the approval gate; it was not executed. This does not by itself mean the user rejected it.\nReason: Nie teraz');
    expect(result.details).toMatchObject({ mode: "call", error: "approval_denied", server: "demo", tool: "send", reason: "Nie teraz" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("puts the reason into the direct call's own result", async () => {
    const { state, callTool } = createState(claiming(() => ({ decision: "deny", reason: "Zła godzina" })));
    const execute = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo", originalName: "send", prefixedName: "demo_send", description: "Send",
    });
    const result = await execute("call-1", {}, undefined, undefined, {} as never);
    expect(text(result)).toContain("\nReason: Zła godzina");
    expect(result.details).toMatchObject({ error: "approval_denied", reason: "Zła godzina" });
    expect(callTool).not.toHaveBeenCalled();
  });

  describe("iframe", () => {
    let handle: UiServerHandle | undefined;
    afterEach(async () => { await handle?.close(); handle = undefined; });

    it("puts the reason into the iframe call's own result", async () => {
      const { state } = createState(claiming(() => ({ decision: "deny", reason: "Z okna" })));
      const connection = { status: "connected", client: { callTool: vi.fn() }, tools: [{ name: "send" }] } as unknown as ServerConnection;
      const manager = {
        getConnection: vi.fn(() => connection), touch: vi.fn(), incrementInFlight: vi.fn(), decrementInFlight: vi.fn(),
        getRequestOptions: vi.fn(() => undefined),
      } as unknown as McpServerManager;
      handle = await startUiServer({
        serverName: "demo", toolName: "send", toolArgs: {},
        resource: { uri: "ui://demo/w", html: "<p>x</p>", mimeType: "text/html", meta: { permissions: [] } },
        manager, config: state.config, state,
        consentManager: { requiresPrompt: vi.fn().mockReturnValue(false), shouldCacheConsent: vi.fn().mockReturnValue(true),
          ensureApproved: vi.fn(), registerDecision: vi.fn() } as unknown as ConsentManager,
      });
      const body = await new Promise<any>((resolve, reject) => {
        const req = http.request({ hostname: "localhost", port: handle!.port, path: "/proxy/tools/call", method: "POST",
          headers: { "Content-Type": "application/json" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ token: handle!.sessionToken, params: { name: "send", arguments: {} } }));
      });
      expect(body.result.content[0].text).toContain("\nReason: Z okna");
      expect(body.result.details).toMatchObject({ error: "approval_denied", reason: "Z okna" });
      expect(connection.client.callTool).not.toHaveBeenCalled();
    });
  });

  it("leaves legacy string decisions exactly as before", async () => {
    for (const [decision, expected] of [
      ["allow_once", { ok: true }],
      ["allow_for_session", { ok: true }],
      ["deny", { ok: false, reason: "denied" }],
    ] as const) {
      const { state } = createState(claiming(() => decision));
      await expect(ensureToolCallApproved(state, "demo", tool, {})).resolves.toEqual(expected);
    }
    const { state } = createState(claiming(() => "deny"));
    const result = await executeCall(state, tool.name, {});
    expect(text(result)).toBe('MCP tool "send" on server "demo" was blocked by the approval gate; it was not executed. This does not by itself mean the user rejected it.');
    expect(result.details).not.toHaveProperty("reason");
  });

  it("treats every malformed object as a plain deny", async () => {
    for (const bad of [
      { decision: "allow_once", reason: "x" },
      { decision: "allow_for_session" },
      { decision: "deny" },
      { decision: "deny", reason: 42 },
      { decision: "deny", reason: "   " },
      { reason: "no decision" },
      "maybe",
      null,
    ]) {
      const { state } = createState(claiming(() => bad as never));
      await expect(ensureToolCallApproved(state, "demo", tool, {})).resolves.toEqual({ ok: false, reason: "denied" });
    }
  });

  it("still throws on abort and still denies without a reason when the handler throws", async () => {
    const controller = new AbortController();
    const { state } = createState(claiming(() => new Promise(() => {})));
    const waiting = ensureToolCallApproved(state, "demo", tool, {}, controller.signal);
    controller.abort(new Error("aborted"));
    await expect(waiting).rejects.toThrow();

    const failing = createState(claiming(() => { throw new Error("broker down"); }));
    await expect(ensureToolCallApproved(failing.state, "demo", tool, {})).resolves.toEqual({ ok: false, reason: "denied" });
  });

  it("abstains to the adapter's own policy when nobody claims", async () => {
    const { state, callTool } = createState(() => {});
    await executeCall(state, tool.name, {});
    expect(callTool).toHaveBeenCalledOnce();
  });
});

describe("sanitizeDenyReason", () => {
  it("keeps Polish letters, newlines and tabs; drops escapes and control characters", () => {
    const raw = "Zażółć\tgęślą\r\njaźń\x1b[31m czerwony\x1b[0m\x1b]8;;http://evil\x07link\x1b]8;;\x07\x00\x08\x7f";
    expect(sanitizeDenyReason(raw)).toBe("Zażółć\tgęślą\njaźń czerwonylink");
  });

  it("keeps a reason up to the limit whole", () => {
    const reason = "ż".repeat(MAX_DENY_REASON_BYTES / 2);
    expect(sanitizeDenyReason(reason)).toBe(reason);
  });

  it("cuts an over-long reason on a character boundary and marks it", () => {
    const result = sanitizeDenyReason("ż".repeat(MAX_DENY_REASON_BYTES))!;
    // 8192 bytes minus the 23-byte marker leaves room for 4084 two-byte letters.
    expect(result).toBe(`${"ż".repeat(4084)}\n[… reason truncated]`);
  });

  it("returns undefined for a reason that is empty after cleaning", () => {
    expect(sanitizeDenyReason("\x1b[0m \n\t")).toBeUndefined();
  });

  it("formats the headless gate unchanged", () => {
    expect(approvalBlockedResult({ ok: false, reason: "approval_required_headless" }, "demo", "send")).toEqual({
      content: [{ type: "text", text: 'MCP tool "send" on server "demo" is approval-gated and requires an interactive session.' }],
      details: { error: "approval_required", server: "demo", tool: "send" },
    });
  });
});

describe("host-managed linked read denial", () => {
  const uri = "file:///chart.png";
  const adapters: HostManagedMcpAdapter[] = [];
  afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.close())); });

  async function readDenied(answer: (request: McpToolApprovalRequest) => unknown, dropAfterDispatch = false, directAnswer: unknown = "allow_once") {
    const reads: string[] = [];
    let calls = 0;
    const caught: { error?: unknown } = {};
    const adapter = createHostManagedMcpAdapter({
      servers: {
        fixture: {
          tools: ["echo"],
          createTransport: async () => {
            const [client, serverSide] = InMemoryTransport.createLinkedPair();
            const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
            server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] }));
            server.setRequestHandler(CallToolRequestSchema, async () => {
              calls += 1;
              return { content: [{ type: "resource_link", uri, name: "chart" }] };
            });
            server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
              reads.push(request.params.uri);
              return { contents: [{ uri: request.params.uri, text: "x" }] };
            });
            await server.connect(serverSide as never);
            return client;
          },
        },
      },
      async onToolCall(call) {
        const result = await call.dispatch();
        try {
          await call.linkedResource(uri);
        } catch (error) {
          caught.error = error;
        }
        return result;
      },
    });
    adapters.push(adapter);
    await adapter.ready();
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    const events = createEventBus();
    events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (event) => {
      const request = event as McpToolApprovalRequest;
      if (request.origin === "direct") { request.claim(() => directAnswer as never); return; }
      if (dropAfterDispatch) return;
      request.claim(() => answer(request) as never);
    });
    adapter.extensionFactory({ events, registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
    const result = await tools.get("fixture_echo")!.execute("call-1", {}, undefined, undefined, {}) as { content: Array<{ type: string; text?: string }>; details?: unknown };
    return { error: caught.error, reads, calls, result };
  }
  it("puts the reason into a denied host-managed call's own result", async () => {
    const { result, calls } = await readDenied(() => "allow_once", false, { decision: "deny", reason: "Poza godzinami" });
    expect(text(result)).toBe('MCP tool "echo" on server "fixture" was blocked by the approval gate; it was not executed. This does not by itself mean the user rejected it.\nReason: Poza godzinami');
    expect(result.details).toMatchObject({ error: "approval_denied", server: "fixture", tool: "echo", reason: "Poza godzinami" });
    expect(calls).toBe(0);
  });

  it("carries the approver's reason on a denied linked read", async () => {
    const { error, reads } = await readDenied(() => ({ decision: "deny", reason: "No charts today" }));
    expect(error).toBeInstanceOf(HostManagedMcpError);
    expect(error).toMatchObject({ delivery: "not_sent", denied: true, denyReason: "No charts today" });
    expect((error as Error).message).toBe('MCP server "fixture": the request was not sent (blocked by the approval gate). Reason: No charts today');
    expect(reads).toEqual([]);
  });

  it("marks a denial without a reason as denied only", async () => {
    for (const answer of ["deny", { decision: "deny", reason: "\x1b[31m\x07" }]) {
      const { error } = await readDenied(() => answer);
      expect(error).toMatchObject({ delivery: "not_sent", denied: true });
      expect((error as HostManagedMcpError).denyReason).toBeUndefined();
      expect((error as Error).message).toBe('MCP server "fixture": the request was not sent (blocked by the approval gate)');
    }
  });

  it("leaves abstain and an unclaimed request without denied", async () => {
    for (const run of [readDenied(() => "abstain"), readDenied(() => "abstain", true)]) {
      const { error } = await run;
      expect(error).toMatchObject({ delivery: "not_sent" });
      expect((error as HostManagedMcpError).denied).toBeUndefined();
      expect((error as HostManagedMcpError).denyReason).toBeUndefined();
      expect((error as Error).message).toBe('MCP server "fixture": the request was not sent');
    }
  });

  it("does not let a caller forge a reason without denied", () => {
    const error = new HostManagedMcpError("not_sent", "s", { denyReason: "x" });
    expect(error.denyReason).toBeUndefined();
  });
});
