import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ExtensionMode, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const mocks = vi.hoisted(() => ({
  loadMcpConfig: vi.fn(),
}));

vi.mock("../config.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  loadMcpConfig: mocks.loadMcpConfig,
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: vi.fn().mockImplementation(function (this: any) {
    this.setDefaultRequestTimeoutMs = vi.fn();
    this.setAuthStorageOptions = vi.fn();
    this.setSamplingConfig = vi.fn();
    this.setElicitationConfig = vi.fn();
    this.getConnection = vi.fn();
    this.getAllConnections = vi.fn(() => new Map());
    this.getRequestOptions = vi.fn();
    this.decrementInFlight = vi.fn();
    this.touch = vi.fn();
  }),
}));

function context(mode: ExtensionMode, setStatus = vi.fn()): ExtensionContext {
  return {
    cwd: "/tmp/project",
    hasUI: true,
    mode,
    ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn(), setStatus } as unknown as ExtensionUIContext,
    modelRegistry: {},
    model: undefined,
    signal: undefined,
  } as unknown as ExtensionContext;
}

function sessionContext(sessionId: string, branch: unknown[]): ExtensionContext {
  return { ...context("tui"), sessionManager: { getBranch: () => branch, getSessionId: () => sessionId } } as unknown as ExtensionContext;
}

function runningTask() {
  let finish!: () => void;
  const settled = new Promise<unknown>((resolve) => {
    finish = () => resolve({ outcome: { status: "completed", result: { content: [] } }, lastTask: undefined });
  });
  const execution = { kind: "task", handle: { taskId: "t-1", operation: "tools/call" }, cancel: vi.fn(), close: vi.fn(), settle: () => settled };
  return { execution: execution as any, finish };
}

describe("background MCP tasks in initializeMcp", () => {
  beforeEach(() => {
    // A disabled server keeps the footer on without starting a connection.
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: { demo: { command: "demo", disabled: true } }, settings: {} });
  });

  it("adds the running task count to the footer and drops it when the task ends", async () => {
    const { initializeMcp } = await import("../init.ts");
    const setStatus = vi.fn();
    const state = await initializeMcp({ getFlag: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI, context("tui", setStatus));
    const { execution, finish } = runningTask();

    const done = state.backgroundTasks!.start({
      server: "demo", tool: "build", taskId: "t-1", execution, render: async () => ({ content: [], details: {} }),
    });
    expect(setStatus).toHaveBeenLastCalledWith("mcp", "🔌 MCP: 0 servers enabled (1 disabled) · 1 MCP task");

    finish();
    await done;
    expect(setStatus).toHaveBeenLastCalledWith("mcp", "🔌 MCP: 0 servers enabled (1 disabled)");
  });

  it("runs tasks in the background only in the interactive terminal", async () => {
    const { initializeMcp } = await import("../init.ts");
    const api = { getFlag: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;

    expect((await initializeMcp(api, context("tui"))).backgroundTasks).toBeDefined();
    expect((await initializeMcp(api, context("rpc"))).backgroundTasks).toBeUndefined();
  });

  const reference = { endpointId: "endpoint-1", generation: "v2", taskId: "t-1", originalOperation: "tools/call" };
  const pendingEntry = { version: 1, kind: "pending", sessionId: "s-1", key: "demo/t-1", server: "demo", tool: "build", reference };
  const render = async () => ({ content: [], details: {} });
  const guard = async (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

  it("records a running task as pending in the stopping session instead of cancelling it", async () => {
    const { initializeMcp } = await import("../init.ts");
    const appendEntry = vi.fn();
    const state = await initializeMcp({ getFlag: vi.fn(), sendMessage: vi.fn(), appendEntry } as unknown as ExtensionAPI, sessionContext("s-1", []));
    const execution = {
      kind: "task",
      cancel: vi.fn(),
      settle: () => new Promise(() => {}),
      handoff: async (persist: (ref: typeof reference) => void) => persist(reference),
      result: async () => ({ status: "failed" }),
    };
    const done = state.backgroundTasks!.start({ server: "demo", tool: "build", taskId: "t-1", execution: execution as any, render, guard });

    await state.backgroundTasks!.handOffForShutdown();
    await done;

    expect(appendEntry).toHaveBeenCalledWith("mcp-task-v1", pendingEntry);
    expect(execution.cancel).not.toHaveBeenCalled();
  });

  it("resumes a pending task of this session whose outcome was never persisted, and tells the model once", async () => {
    const { initializeMcp } = await import("../init.ts");
    let delivered!: () => void;
    const delivery = new Promise<void>((resolve) => { delivered = resolve; });
    const appendEntry = vi.fn();
    const sendMessage = vi.fn(() => delivered());
    const branch = [{ type: "custom", customType: "mcp-task-v1", data: pendingEntry }];

    await initializeMcp({ getFlag: vi.fn(), sendMessage, appendEntry } as unknown as ExtensionAPI, sessionContext("s-1", branch));
    await delivery;

    expect(sendMessage).toHaveBeenCalledTimes(1);
    // The configured server is disabled, so the task can't be followed again.
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({
      customType: "mcp-task-result",
      content: [
        { type: "text", text: "MCP task t-1 (demo/build) outcome unknown." },
        { type: "text", text: "Server 'demo' is not configured in this session; the task may still be running on it. Calling the tool again may repeat the work." },
      ],
      details: { task: { id: "t-1", status: "unknown" }, error: "task_outcome_unknown" },
    });
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("says the server could not be reached when a restored task's server needs sign-in", async () => {
    const { restoreBackgroundTasks } = await import("../init.ts");
    const { BackgroundTaskRegistry } = await import("../task-jobs.ts");
    const sendMessage = vi.fn();
    const manager = {
      getConnection: vi.fn(() => undefined),
      connect: vi.fn(async () => ({ status: "needs-auth" })),
      getRequestOptions: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      touch: vi.fn(),
    };
    const state = { config: { mcpServers: { demo: { url: "https://demo.test/mcp" } }, settings: {} }, manager, failureTracker: new Map() };
    const registry = new BackgroundTaskRegistry(manager, sendMessage, new AbortController().signal);

    await restoreBackgroundTasks(state as never, registry, [{ key: "demo/t-1", server: "demo", tool: "build", reference: reference as never }]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0].content).toEqual([
      { type: "text", text: "MCP task t-1 (demo/build) outcome unknown." },
      { type: "text", text: "Could not reach 'demo'. Calling the tool again may repeat the work." },
    ]);
    expect(manager.incrementInFlight).not.toHaveBeenCalled();
  });

  it("does not resume a pending task whose outcome message is already in the session", async () => {
    const { initializeMcp } = await import("../init.ts");
    const sendMessage = vi.fn();
    const deliveredMessage = {
      type: "custom_message",
      customType: "mcp-task-result",
      content: [{ type: "text", text: "MCP task t-1 (demo/build) completed." }],
      display: true,
      details: { task: { id: "t-1", server: "demo", tool: "build", status: "completed" } },
    };
    const branch = [{ type: "custom", customType: "mcp-task-v1", data: pendingEntry }, deliveredMessage];

    const state = await initializeMcp({ getFlag: vi.fn(), sendMessage, appendEntry: vi.fn() } as unknown as ExtensionAPI, sessionContext("s-1", branch));

    expect(state.backgroundTasks!.size).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("leaves another session's pending tasks alone, so a fork does not resume them", async () => {
    const { initializeMcp } = await import("../init.ts");
    const appendEntry = vi.fn();
    const sendMessage = vi.fn();
    const branch = [{ type: "custom", customType: "mcp-task-v1", data: pendingEntry }];

    const state = await initializeMcp({ getFlag: vi.fn(), sendMessage, appendEntry } as unknown as ExtensionAPI, sessionContext("fork", branch));

    expect(state.backgroundTasks!.size).toBe(0);
    expect(appendEntry).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
