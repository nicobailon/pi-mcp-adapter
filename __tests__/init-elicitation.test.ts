import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionMode,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

const mocks = vi.hoisted(() => ({
  loadMcpConfig: vi.fn(),
  managers: [] as any[],
}));

vi.mock("../config.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  loadMcpConfig: mocks.loadMcpConfig,
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: vi.fn().mockImplementation(function (this: any) {
    this.setRuntimeSignal = vi.fn();
    this.setDefaultRequestTimeoutMs = vi.fn();
    this.setSamplingConfig = vi.fn();
    this.setElicitationConfig = vi.fn();
    this.getConnection = vi.fn();
    this.connect = vi.fn();
    mocks.managers.push(this);
  }),
}));

function context(overrides: { hasUI?: boolean; mode?: ExtensionMode } = {}): ExtensionContext {
  return {
    cwd: "/tmp/project",
    hasUI: true,
    mode: "tui",
    ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn() } as unknown as ExtensionUIContext,
    modelRegistry: {},
    model: undefined,
    signal: undefined,
    ...overrides,
  } as unknown as ExtensionContext;
}

function extensionApi(): ExtensionAPI {
  return { getFlag: vi.fn() } as unknown as ExtensionAPI;
}

describe("initializeMcp elicitation config", () => {
  beforeEach(() => {
    mocks.managers.length = 0;
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: {} });
  });

  it("enables form and URL elicitation in TUI mode", async () => {
    const { initializeMcp } = await import("../init.ts");
    const { McpServerManager } = await import("../server-manager.ts");
    const ctx = context();

    await initializeMcp(extensionApi(), ctx);

    expect(McpServerManager).toHaveBeenCalledWith(ctx.cwd);
    expect(mocks.managers[0].setRuntimeSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
      ui: expect.any(Object),
      allowUrl: true,
    });
  });

  it("keeps RPC elicitation form-only so the backend never opens a browser", async () => {
    const { initializeMcp } = await import("../init.ts");
    const ctx = context({ mode: "rpc" });

    await initializeMcp(extensionApi(), ctx);

    expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
      ui: expect.any(Object),
      allowUrl: false,
    });
  });

  it("does not enable elicitation without UI or when disabled", async () => {
    const { initializeMcp } = await import("../init.ts");

    await initializeMcp(extensionApi(), context({ hasUI: false }));
    expect(mocks.managers[0].setElicitationConfig).not.toHaveBeenCalled();

    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: { elicitation: false } });
    await initializeMcp(extensionApi(), context());
    expect(mocks.managers[1].setElicitationConfig).not.toHaveBeenCalled();
  });

  it("snapshots sampling model and signal without retaining guarded context getters", async () => {
    const { createMcpRuntimeOwner } = await import("../runtime-owner.ts");
    const { initializeMcp } = await import("../init.ts");
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {},
      settings: { sampling: true, samplingAutoApprove: true },
    });

    const owner = createMcpRuntimeOwner();
    const initialModel = { provider: "test", id: "model" };
    const initialSignal = new AbortController().signal;
    let stale = false;
    const accesses: string[] = [];
    const ctx = new Proxy({
      cwd: "/tmp/project",
      hasUI: false,
      mode: "print" as ExtensionMode,
      modelRegistry: {},
      model: initialModel,
      signal: initialSignal,
    }, {
      get(target, property, receiver) {
        accesses.push(String(property));
        if (stale) throw new Error(`stale context access: ${String(property)}`);
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as ExtensionContext;

    await initializeMcp(extensionApi(), ctx, owner);
    const sampling = mocks.managers[0].setSamplingConfig.mock.calls[0][0];
    stale = true;

    expect(sampling.getCurrentModel()).toBe(initialModel);
    expect(sampling.getSignal()).toBeInstanceOf(AbortSignal);
    expect(accesses.filter(property => property === "model")).toHaveLength(1);
    expect(accesses.filter(property => property === "signal")).toHaveLength(1);
  });
});
