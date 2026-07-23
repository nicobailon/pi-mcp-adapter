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

  it("enables form and URL elicitation in TUI mode", async () => {
    const { initializeMcp } = await import("../init.ts");
    const { McpServerManager } = await import("../server-manager.ts");
    const ctx = context();

    await initializeMcp(extensionApi(), ctx);

    expect(McpServerManager).toHaveBeenCalledWith(ctx.cwd);
    expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
      ui: ctx.ui,
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

  it("keeps RPC elicitation form-only so the backend never opens a browser", async () => {
    const { initializeMcp } = await import("../init.ts");
    const ctx = context({ mode: "rpc" });

    await initializeMcp(extensionApi(), ctx);

    expect(mocks.managers[0].setElicitationConfig).toHaveBeenCalledWith({
      ui: ctx.ui,
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
});
