import { beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end coverage for the structuredContent fallback.

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  updateStatusBar: vi.fn(),
}));

function textOf(result: any): string {
  return result.content.map((c: any) => c.text ?? "").join("\n");
}

function makeState(callToolResult: unknown, toolName = "tool") {
  const connection = {
    status: "connected",
    client: { callTool: vi.fn(async () => callToolResult) },
  };
  return {
    config: { settings: {}, mcpServers: { demo: { command: "demo" } } },
    toolMetadata: new Map([
      ["demo", [{ name: `demo_${toolName}`, originalName: toolName, description: toolName }]],
    ]),
    manager: {
      getConnection: vi.fn(() => connection),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    },
    failureTracker: new Map(),
    ui: undefined,
    completedUiSessions: [],
  } as any;
}

describe("structuredContent fallback — direct tool executor", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("surfaces structuredContent to the model when content is empty", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const structured = { status: "available", summary: "## Notes" };
    const state = makeState({ isError: false, content: [], structuredContent: structured });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "get-summary", prefixedName: "demo_get-summary", description: "Get summary" },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

    expect(textOf(result)).toBe(JSON.stringify(structured, null, 2));
    expect(textOf(result)).not.toContain("(empty result)");
  });

  it("still shows (empty result) when both content and structuredContent are empty", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const state = makeState({ isError: false, content: [] });

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      { serverName: "demo", originalName: "noop", prefixedName: "demo_noop", description: "Noop" },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

    expect(textOf(result)).toBe("(empty result)");
  });
});

describe("structuredContent fallback — proxy executeCall", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
  });

  it("surfaces structuredContent to the model when content is empty", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const structured = { status: "available", summary: "## Notes" };
    const state = makeState({ isError: false, content: [], structuredContent: structured }, "get-summary");

    const result = await executeCall(state, "demo_get-summary", {}, "demo");

    expect(textOf(result)).toContain(JSON.stringify(structured, null, 2));
    expect(textOf(result)).not.toContain("(empty result)");
  });

  it("still shows (empty result) when both content and structuredContent are empty", async () => {
    const { executeCall } = await import("../proxy-modes.ts");
    const state = makeState({ isError: false, content: [] }, "noop");

    const result = await executeCall(state, "demo_noop", {}, "demo");

    expect(textOf(result)).toContain("(empty result)");
  });
});
