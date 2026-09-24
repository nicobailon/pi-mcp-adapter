import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { ConsentManager } from "../consent-manager.ts";
import { maybeStartUiSession } from "../ui-session.ts";

const glimpseMocks = vi.hoisted(() => ({
  isGlimpseAvailable: vi.fn(() => true),
  openGlimpseWindow: vi.fn(),
}));

vi.mock("../glimpse-ui.ts", () => glimpseMocks);
vi.mock("node:child_process", () => ({
  execFile: vi.fn((...args: any[]) => {
    const callback = args[args.length - 1];
    callback(null, "");
  }),
}));

function makeState() {
  const callTool = vi.fn(async () => ({
    isError: false,
    content: [{ type: "text" as const, text: "tool output" }],
  }));
  const connection = {
    status: "connected" as const,
    client: { callTool },
    tools: [{ name: "app", description: "App", inputSchema: { type: "object" } }],
    resources: [],
  };
  const state = {
    config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "demo" } } },
    manager: {
      getConnection: vi.fn(() => connection),
      getAllConnections: vi.fn(() => new Map([["demo", connection]])),
      getRequestOptions: vi.fn(() => undefined),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      registerUiStreamListener: vi.fn(),
      removeUiStreamListener: vi.fn(),
    },
    lifecycle: {},
    toolMetadata: new Map([
      ["demo", [{ name: "demo_app", originalName: "app", description: "App", uiResourceUri: "ui://app" }]],
    ]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    uiResourceHandler: {
      readUiResource: vi.fn(async () => ({
        uri: "ui://app",
        html: "<main>App</main>",
        mimeType: "text/html",
        meta: {},
      })),
    },
    consentManager: new ConsentManager("never"),
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(async () => undefined),
    sendMessage: vi.fn(),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_name: string, value: string) => value },
    },
  } as any;

  return { state, callTool };
}

afterEach(() => {
  delete process.env.MCP_UI_VIEWER;
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_TTY;
  vi.mocked(execFile).mockClear();
  vi.mocked(execFile).mockImplementation((...args: any[]) => {
    const callback = args[args.length - 1];
    callback(null, "");
  });
  glimpseMocks.isGlimpseAvailable.mockClear();
  glimpseMocks.openGlimpseWindow.mockClear();
});

describe("MCP_UI_VIEWER=orca", () => {
  it("opens the UI in the Orca browser when `orca goto` succeeds", async () => {
    process.env.MCP_UI_VIEWER = "orca";
    const { state } = makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "orca", windowOpen: true });
    expect(runtime?.url).toContain("http://localhost:");
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      "orca",
      ["goto", "--url", expect.stringContaining("http://")],
      expect.objectContaining({ timeout: 10000, signal: expect.anything() }),
      expect.any(Function),
    );
    expect(state.openBrowser).not.toHaveBeenCalled();
    expect(glimpseMocks.isGlimpseAvailable).not.toHaveBeenCalled();
    expect(glimpseMocks.openGlimpseWindow).not.toHaveBeenCalled();

    runtime?.close("test-cleanup");
  });

  it("falls back to the system browser when `orca goto` fails", async () => {
    process.env.MCP_UI_VIEWER = "orca";
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const command = args[0];
      const callback = args[args.length - 1];
      if (command === "orca") {
        callback(Object.assign(new Error("spawn orca ENOENT"), { code: "ENOENT" }));
        return;
      }
      callback(null, "");
    });
    const { state } = makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "browser", windowOpen: true });
    expect(state.openBrowser).toHaveBeenCalledWith(expect.stringContaining("http://localhost:"));
    expect(glimpseMocks.isGlimpseAvailable).not.toHaveBeenCalled();
    expect(glimpseMocks.openGlimpseWindow).not.toHaveBeenCalled();

    runtime?.close("test-cleanup");
  });

  it("does not fall back to the system browser after cancellation", async () => {
    process.env.MCP_UI_VIEWER = "orca";
    process.env.SSH_CONNECTION = "test";
    const controller = new AbortController();
    vi.mocked(execFile).mockImplementation((...args: any[]) => {
      const options = args[2] as { signal: AbortSignal };
      const callback = args[args.length - 1];
      options.signal.addEventListener("abort", () => callback(options.signal.reason), { once: true });
      return undefined as any;
    });
    const { state } = makeState();

    const pending = maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledWith("orca", expect.anything(), expect.anything(), expect.anything()));
    controller.abort(new Error("test cancellation"));

    await expect(pending).rejects.toThrow("test cancellation");
    expect(state.openBrowser).not.toHaveBeenCalled();
    state.uiServer?.close("test-cleanup");
  });

  it("ignores the Orca viewer preference when suppressed", async () => {
    process.env.MCP_UI_VIEWER = "none";
    const { state } = makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "suppressed", windowOpen: false });
    expect(vi.mocked(execFile)).not.toHaveBeenCalledWith("orca", expect.any(Array), expect.anything(), expect.anything());
    expect(state.openBrowser).not.toHaveBeenCalled();

    runtime?.close("test-cleanup");
  });
});
