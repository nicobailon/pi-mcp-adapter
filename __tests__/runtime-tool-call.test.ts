import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpRuntimeToolCallResult } from "../index.ts";
import { computeServerHash } from "../metadata-cache.ts";

const mocks = vi.hoisted(() => ({
  initializeMcp: vi.fn(),
  loadMcpConfig: vi.fn(),
  loadMetadataCache: vi.fn(),
  executeCall: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  initializeMcp: mocks.initializeMcp,
  updateStatusBar: vi.fn(),
  flushMetadataCache: vi.fn(),
  notifyToolMetadataUpdated: vi.fn(),
}));

vi.mock("../mcp-auth-flow.ts", () => ({
  initializeOAuth: vi.fn().mockResolvedValue(undefined),
  createOAuthRuntime: vi.fn((signal: AbortSignal) => ({ signal })),
  shutdownOAuth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../config.ts", () => ({
  loadMcpConfig: mocks.loadMcpConfig,
  cloneMcpConfig: (config: unknown) => structuredClone(config),
  discoverConfiguredClaudePluginSkills: () => [],
  resolveConfiguredClaudePluginMcp: (config: unknown) => structuredClone(config),
  getLegacyMcpMigrationNotices: () => [],
  setPiMcpConfigEnabled: vi.fn(),
  writeProjectServerDisabledOverride: vi.fn(),
}));

vi.mock("../metadata-cache.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metadata-cache.ts")>()),
  loadMetadataCache: mocks.loadMetadataCache,
}));

vi.mock("../proxy-modes.ts", () => ({
  executeCall: mocks.executeCall,
}));

function createState() {
  return {
    manager: {
      close: vi.fn().mockResolvedValue(undefined),
    },
    lifecycle: {
      gracefulShutdown: vi.fn().mockResolvedValue(undefined),
    },
    toolMetadata: new Map(),
    config: { mcpServers: {} },
  } as any;
}

function createEventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(data);
    },
    on(channel: string, listener: (data: unknown) => void) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(listener);
    },
  };
}

function createPi(events: ReturnType<typeof createEventBus>) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools = ["mcp"];
  const api = {
    registerTool: vi.fn(),
    unregisterTool: vi.fn(() => true),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler)),
    events,
    getAllTools: vi.fn(() => []),
    getActiveTools: vi.fn(() => activeTools),
    setActiveTools: vi.fn((next: string[]) => { activeTools = next; }),
  } as any;
  return { api, handlers };
}

async function startAdapter() {
  const { default: mcpAdapter, MCP_RUNTIME_TOOL_CALL_EVENT } = await import("../index.ts");
  const events = createEventBus();
  const { api, handlers } = createPi(events);
  mcpAdapter(api);
  const callTool = (request: Record<string, unknown>) => {
    events.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);
    return request.result as Promise<McpRuntimeToolCallResult> | undefined;
  };
  return { handlers, callTool };
}

describe("runtime MCP tool-call event", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {} });
    mocks.loadMetadataCache.mockReturnValue(null);
    mocks.initializeMcp.mockResolvedValue(createState());
  });

  it("calls the tool through executeCall and resolves ok:true", async () => {
    const state = createState();
    mocks.initializeMcp.mockResolvedValue(state);
    const toolResult = { content: [{ type: "text", text: "ok" }], details: { mode: "call" } };
    mocks.executeCall.mockResolvedValue(toolResult);
    const { handlers, callTool } = await startAdapter();
    await handlers.get("session_start")?.({}, {});

    const result = await callTool({ version: 1, tool: "search", args: { query: "hello" }, server: "docs" });

    expect(result).toEqual({ ok: true, result: toolResult });
    expect(mocks.executeCall).toHaveBeenCalledWith(
      state, "search", { query: "hello" }, "docs", expect.any(Function), undefined, "script",
    );
  });

  it("starts a deferred warm-cache runtime on the first call", async () => {
    const definition = { command: "demo" };
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: definition } });
    mocks.loadMetadataCache.mockReturnValue({
      version: 1,
      servers: { demo: { configHash: computeServerHash(definition), cachedAt: Date.now(), tools: [{ name: "search" }], resources: [] } },
    });
    const state = createState();
    let finishInit!: (value: unknown) => void;
    mocks.initializeMcp.mockReturnValue(new Promise((resolve) => { finishInit = resolve; }));
    mocks.executeCall.mockResolvedValue({ content: [], details: { mode: "call" } });
    const { handlers, callTool } = await startAdapter();
    await handlers.get("session_start")?.({}, { cwd: "/project" });
    expect(mocks.initializeMcp).not.toHaveBeenCalled();

    const pending = callTool({ version: 1, tool: "search" });
    await vi.waitFor(() => expect(mocks.initializeMcp).toHaveBeenCalledTimes(1));
    expect(mocks.executeCall).not.toHaveBeenCalled();
    finishInit(state);

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(mocks.executeCall).toHaveBeenCalledWith(state, "search", undefined, undefined, expect.any(Function), undefined, "script");
  });

  it("refuses without a live session and never starts initialization", async () => {
    const { handlers, callTool } = await startAdapter();

    await expect(callTool({ version: 1, tool: "search" })).resolves.toMatchObject({ ok: false });

    await handlers.get("session_start")?.({}, {});
    await handlers.get("session_shutdown")?.({}, {});
    mocks.initializeMcp.mockClear();

    await expect(callTool({ version: 1, tool: "search" })).resolves.toMatchObject({ ok: false });
    expect(mocks.initializeMcp).not.toHaveBeenCalled();
    expect(mocks.executeCall).not.toHaveBeenCalled();
  });

  it("reports a tool error that executeCall resolves as ok:false", async () => {
    mocks.executeCall.mockResolvedValue({
      content: [{ type: "text", text: "The user declined approval" }],
      details: { mode: "call", error: "approval_denied" },
    });
    const { handlers, callTool } = await startAdapter();
    await handlers.get("session_start")?.({}, {});

    await expect(callTool({ version: 1, tool: "search" }))
      .resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("approval_denied") } });
  });

  it("reports an executeCall rejection as ok:false", async () => {
    mocks.executeCall.mockRejectedValue(new Error("connection closed"));
    const { handlers, callTool } = await startAdapter();
    await handlers.get("session_start")?.({}, {});

    await expect(callTool({ version: 1, tool: "search" }))
      .resolves.toMatchObject({ ok: false, error: { message: "connection closed" } });
  });

  it("rejects unsupported versions and empty tool names", async () => {
    const { handlers, callTool } = await startAdapter();
    await handlers.get("session_start")?.({}, {});

    await expect(callTool({ version: 2, tool: "search" })).resolves.toMatchObject({ ok: false });
    await expect(callTool({ version: 1, tool: "  " })).resolves.toMatchObject({ ok: false });
    expect(mocks.executeCall).not.toHaveBeenCalled();
  });

  it("leaves a result set by an earlier listener untouched", async () => {
    const { callTool } = await startAdapter();
    const prefilled = Promise.resolve({ ok: true });
    const request = { version: 1, tool: "search", result: prefilled };

    callTool(request);

    expect(request.result).toBe(prefilled);
  });
});
