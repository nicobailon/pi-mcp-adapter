import { beforeEach, describe, expect, it, vi } from "vitest";

// These tests lock in that the agent's AbortSignal (raised when the user hits
// Esc / Ctrl+C) is forwarded to the MCP SDK's callTool/readResource as
// RequestOptions.signal. Without it, the SDK never emits notifications/cancelled
// and long-running tool calls keep running after the user cancels (issue #40).

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
}));

describe("abort signal forwarding", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("executeCall forwards the abort signal to callTool", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    const callTool = vi.fn(async () => ({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    }));
    const connection = { status: "connected", client: { callTool } };

    const state = {
      config: {
        settings: { toolPrefix: "server" },
        mcpServers: { demo: { command: "npx", args: ["demo"] } },
      },
      toolMetadata: new Map([
        [
          "demo",
          [
            {
              name: "demo_search",
              originalName: "search",
              description: "Search",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        ],
      ]),
      manager: {
        getConnection: vi.fn(() => connection),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
    } as any;

    const signal = new AbortController().signal;
    const result = await executeCall(state, "demo_search", { q: "hi" }, "demo", undefined, signal);

    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { q: "hi" }, _meta: undefined },
      undefined,
      { signal },
    );
    expect(result.content[0].text).toContain("ok");
  });

  it("executeCall forwards the abort signal to readResource for resource tools", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    const readResource = vi.fn(async () => ({
      contents: [{ uri: "res://x", text: "hello" }],
    }));
    const connection = { status: "connected", client: { readResource } };

    const state = {
      config: {
        settings: { toolPrefix: "server" },
        mcpServers: { demo: { command: "npx", args: ["demo"] } },
      },
      toolMetadata: new Map([
        [
          "demo",
          [
            {
              name: "demo_doc",
              originalName: "doc",
              description: "Doc",
              resourceUri: "res://x",
            },
          ],
        ],
      ]),
      manager: {
        getConnection: vi.fn(() => connection),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
    } as any;

    const signal = new AbortController().signal;
    await executeCall(state, "demo_doc", undefined, "demo", undefined, signal);

    expect(readResource).toHaveBeenCalledWith({ uri: "res://x" }, { signal });
  });

  it("createDirectToolExecutor forwards the abort signal to callTool", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const callTool = vi.fn(async () => ({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    }));
    const connection = { status: "connected", client: { callTool } };

    const state = {
      config: {
        settings: {},
        mcpServers: { demo: { command: "npx", args: ["demo"] } },
      },
      manager: {
        getConnection: vi.fn(() => connection),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const signal = new AbortController().signal;
    const result = await executor("id", { q: "hello" }, signal, () => {}, undefined as any);

    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { q: "hello" }, _meta: undefined },
      undefined,
      { signal },
    );
    expect(result.content[0].text).toContain("ok");
  });
});
