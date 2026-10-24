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
});
