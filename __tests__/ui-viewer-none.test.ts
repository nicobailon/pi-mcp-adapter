import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsentManager } from "../consent-manager.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { maybeStartUiSession } from "../ui-session.ts";

const glimpseMocks = vi.hoisted(() => ({
  isGlimpseAvailable: vi.fn(() => true),
  openGlimpseWindow: vi.fn(),
}));

vi.mock("../glimpse-ui.ts", () => glimpseMocks);

function textOf(result: any): string {
  return result.content.map((entry: any) => entry.text ?? "").join("\n");
}

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
  glimpseMocks.isGlimpseAvailable.mockClear();
  glimpseMocks.openGlimpseWindow.mockClear();
});

describe("MCP_UI_VIEWER=none", () => {
  it.each(["none", "off", "disabled"])("suppresses window opening for %s", async (value) => {
    process.env.MCP_UI_VIEWER = value;
    const { state } = makeState();

    const runtime = await maybeStartUiSession(state, {
      serverName: "demo",
      toolName: "app",
      toolArgs: {},
      uiResourceUri: "ui://app",
    });

    expect(runtime).toMatchObject({ viewer: "suppressed", windowOpen: false });
    expect(runtime?.url).toContain("http://localhost:");
    expect(state.openBrowser).not.toHaveBeenCalled();
    expect(glimpseMocks.isGlimpseAvailable).not.toHaveBeenCalled();
    expect(glimpseMocks.openGlimpseWindow).not.toHaveBeenCalled();
    expect(state.ui.notify).toHaveBeenCalledWith(expect.stringContaining("MCP UI window suppressed"), "info");
    expect(state.ui.notify).toHaveBeenCalledWith(expect.not.stringContaining("Tool still ran"), "info");

    runtime?.close("test-cleanup");
  });

  it("reports suppressed UI state in proxy tool results", async () => {
    process.env.MCP_UI_VIEWER = "none";
    const { state } = makeState();

    const result = await executeCall(state, "demo_app", {}, "demo");

    expect(textOf(result)).toContain("tool output");
    expect(textOf(result)).toContain("MCP UI window was suppressed");
    expect(textOf(result)).not.toContain("open in your browser");
    expect(result.details).toMatchObject({ uiOpen: false, uiViewer: "suppressed" });
    expect(result.details.uiUrl).toContain("http://localhost:");
    expect(state.openBrowser).not.toHaveBeenCalled();

    state.uiServer?.close("test-cleanup");
  });

  it("reports suppressed UI state in direct tool results", async () => {
    process.env.MCP_UI_VIEWER = "none";
    const { state } = makeState();
    const execute = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "app", prefixedName: "demo_app", description: "App", uiResourceUri: "ui://app" },
    );

    const result = await execute("call-1", {}, undefined as any, () => {}, undefined as any);

    expect(textOf(result)).toContain("tool output");
    expect(textOf(result)).toContain("MCP UI window was suppressed");
    expect(textOf(result)).not.toContain("open in your browser");
    expect(result.details).toMatchObject({ uiOpen: false, uiViewer: "suppressed" });
    expect(result.details.uiUrl).toContain("http://localhost:");
    expect(state.openBrowser).not.toHaveBeenCalled();

    state.uiServer?.close("test-cleanup");
  });
});
