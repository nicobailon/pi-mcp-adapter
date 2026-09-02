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
    this.setDefaultRequestTimeoutMs = vi.fn();
    this.setAuthStorageOptions = vi.fn();
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

  it("uses an isolated programmatic config without reading flags or files", async () => {
    const config = {
      mcpServers: {},
      settings: { sampling: false as const },
    };
    const api = extensionApi();
    const { initializeMcp } = await import("../init.ts");
    const { createMcpRuntimeOwner } = await import("../runtime-owner.ts");
    const state = await initializeMcp(api, context({ hasUI: false }), createMcpRuntimeOwner(), { config });

    expect(api.getFlag).not.toHaveBeenCalled();
    expect(mocks.loadMcpConfig).not.toHaveBeenCalled();
    expect(state.config).toEqual(config);
    expect(state.config).not.toBe(config);
    expect(state.programmaticConfig).toBe(true);
  });

  it("enables form and URL elicitation in TUI mode", async () => {
    const { initializeMcp } = await import("../init.ts");
    const { McpServerManager } = await import("../server-manager.ts");
    const ctx = context();

    await initializeMcp(extensionApi(), ctx);

    expect(McpServerManager).toHaveBeenCalledWith(ctx.cwd);
    expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
      ui: expect.any(Object),
      allowUrl: true,
    });
  });

  it("binds oauthDir storage to the active context cwd", async () => {
    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: { oauthDir: ".pi/oauth" } });
    const { initializeMcp } = await import("../init.ts");
    const ctx = context();

    await initializeMcp(extensionApi(), ctx);

    expect(mocks.managers[0].setAuthStorageOptions).toHaveBeenCalledWith({
      baseDir: "/tmp/project/.pi/oauth",
    });
  });

  it("creates a distinct in-memory OAuth store for session persistence", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {},
      settings: { oauthPersistence: "session" },
    });
    const { initializeMcp } = await import("../init.ts");

    const first = await initializeMcp(extensionApi(), context());
    const second = await initializeMcp(extensionApi(), context());

    expect(first.authStorageOptions).toMatchObject({
      persistence: "session",
      sessionId: expect.any(String),
      sessionEntries: expect.any(Map),
    });
    expect(second.authStorageOptions).toMatchObject({
      persistence: "session",
      sessionId: expect.any(String),
      sessionEntries: expect.any(Map),
    });
    expect(first.authStorageOptions.sessionId).not.toBe(second.authStorageOptions.sessionId);
    expect(mocks.managers[0].setAuthStorageOptions).toHaveBeenCalledWith(first.authStorageOptions);
    expect(mocks.managers[1].setAuthStorageOptions).toHaveBeenCalledWith(second.authStorageOptions);
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

  it("keeps sampling bound to the current model and turn signal while the runtime is active", async () => {
    const { initializeMcp } = await import("../init.ts");
    const ctx = context() as ExtensionContext & { model: unknown; signal: AbortSignal | undefined };
    const firstSignal = new AbortController();
    const secondSignal = new AbortController();
    ctx.model = { id: "first" };
    ctx.signal = firstSignal.signal;

    const state = await initializeMcp(extensionApi(), ctx);
    const sampling = mocks.managers[0].setSamplingConfig.mock.calls[0][0];

    ctx.model = { id: "second" };
    ctx.signal = secondSignal.signal;
    expect(sampling.getCurrentModel()).toEqual({ id: "second" });
    const activeSignal = sampling.getSignal();
    expect(activeSignal.aborted).toBe(false);
    secondSignal.abort(new Error("turn cancelled"));
    expect(activeSignal.aborted).toBe(true);

    await state.owner.stop("reload");
    expect(sampling.getCurrentModel()).toBeUndefined();
    expect(sampling.getSignal().aborted).toBe(true);
  });

  it("does not enable elicitation without UI or when disabled", async () => {
    const { initializeMcp } = await import("../init.ts");

    await initializeMcp(extensionApi(), context({ hasUI: false }));
    expect(mocks.managers[0].setElicitationConfig).not.toHaveBeenCalled();

    mocks.loadMcpConfig.mockReturnValue({ mcpServers: {}, settings: { elicitation: false } });
    await initializeMcp(extensionApi(), context());
    expect(mocks.managers[1].setElicitationConfig).not.toHaveBeenCalled();
  });
});
