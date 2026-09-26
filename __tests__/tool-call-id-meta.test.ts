import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { computeServerHash } from "../metadata-cache.ts";
import { syncNamespaceProxyTools } from "../namespace-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { UI_STREAM_REQUEST_META_KEY } from "../ui-stream-types.ts";
import { TOOL_CALL_ID_REQUEST_META_KEY, withToolCallIdMeta } from "../utils.ts";

function connectedState(client: Record<string, unknown>) {
  return {
    config: {
      settings: { toolPrefix: "server" },
      mcpServers: { demo: { command: "node", args: ["server.js"] } },
    },
    manager: {
      getConnection: vi.fn(() => ({ status: "connected", client, tools: [], resources: [] })),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    },
    toolMetadata: new Map([["demo", [{ name: "demo_search", originalName: "search", description: "Search" }]]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    ui: undefined,
  } as any;
}

describe("withToolCallIdMeta", () => {
  it("adds the tool call id under the adapter's _meta namespace", () => {
    expect(TOOL_CALL_ID_REQUEST_META_KEY).toBe("pi-mcp-adapter/toolCallId");
    expect(withToolCallIdMeta(undefined, "call-1")).toEqual({ "pi-mcp-adapter/toolCallId": "call-1" });
  });

  it("keeps the UI stream token alongside the tool call id", () => {
    const uiMeta = { [UI_STREAM_REQUEST_META_KEY]: "stream-token" };
    expect(withToolCallIdMeta(uiMeta, "call-1")).toEqual({
      [UI_STREAM_REQUEST_META_KEY]: "stream-token",
      "pi-mcp-adapter/toolCallId": "call-1",
    });
    expect(uiMeta).toEqual({ [UI_STREAM_REQUEST_META_KEY]: "stream-token" });
  });

  it("leaves _meta untouched without a tool call id", () => {
    const uiMeta = { [UI_STREAM_REQUEST_META_KEY]: "stream-token" };
    expect(withToolCallIdMeta(uiMeta, undefined)).toBe(uiMeta);
    expect(withToolCallIdMeta(undefined, "")).toBeUndefined();
  });
});

describe("tool call id forwarding", () => {
  it("direct tools forward Pi's tool call id to callTool", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const state = connectedState({ callTool });
    const execute = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "search",
      prefixedName: "demo_search",
      description: "Search",
    });

    await execute("toolu_01abc", { q: "hello" }, undefined, undefined, {} as any);

    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { q: "hello" }, _meta: { "pi-mcp-adapter/toolCallId": "toolu_01abc" } },
      undefined,
    );
  });

  it("proxy calls forward the tool call id they are given", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const state = connectedState({ callTool });

    await executeCall(state, "demo_search", { q: "hello" }, undefined, undefined, undefined, undefined, undefined, "toolu_02def");

    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { q: "hello" }, _meta: { "pi-mcp-adapter/toolCallId": "toolu_02def" } },
      undefined,
    );
  });

  it("calls without a Pi tool call (mcp-code scripts) send no _meta", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const state = connectedState({ callTool });

    await executeCall(state, "demo_search", {}, undefined, undefined, undefined, "script");

    expect(callTool).toHaveBeenCalledWith({ name: "search", arguments: {}, _meta: undefined }, undefined);
  });

  it("namespace proxy tools pass their tool call id to executeCall", async () => {
    const registered = new Map<string, { execute: (...args: unknown[]) => unknown }>();
    const pi = { registerTool: vi.fn((tool: any) => registered.set(tool.name, tool)), unregisterTool: vi.fn() };
    const executeCallMock = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }], details: {} }));
    const state = { owner: { isActive: () => true, signal: new AbortController().signal } } as any;

    syncNamespaceProxyTools({
      config: { mcpServers: { demo: { command: "demo" } } },
      cache: {
        version: 1,
        servers: {
          demo: { tools: [{ name: "search" }], resources: [], configHash: computeServerHash({ command: "demo" }), cachedAt: Date.now() },
        },
      } as any,
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi: pi as unknown as ExtensionAPI,
      getState: () => state,
      getInitPromise: () => null,
      getPiTools: () => [],
      executeCall: executeCallMock,
    });

    await registered.get("mcp__demo")!.execute("toolu_03ghi", { tool: "search", args: { q: "x" } }, undefined);

    expect(executeCallMock).toHaveBeenCalledWith(
      state, "search", { q: "x" }, "demo", expect.any(Function), undefined, "proxy", undefined, "toolu_03ghi",
    );
  });
});
