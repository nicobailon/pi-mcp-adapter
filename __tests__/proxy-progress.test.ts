import { describe, expect, it, vi } from "vitest";
import { executeCall } from "../proxy-modes.ts";

function connectedState(client: Record<string, unknown>, ui?: { notify: ReturnType<typeof vi.fn> }) {
  return {
    config: {
      settings: { toolPrefix: "server" },
      mcpServers: { demo: { command: "node", args: ["server.js"] } },
    },
    manager: {
      getConnection: vi.fn(() => ({ status: "connected", client, tools: [], resources: [] })),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      close: vi.fn(async () => undefined),
      getRequestOptions: vi.fn(() => ({ timeout: 5_000 })),
    },
    toolMetadata: new Map([
      [
        "demo",
        [
          {
            name: "demo_long",
            originalName: "long",
            description: "Long-running tool",
          },
        ],
      ],
    ]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    ui,
  } as any;
}

describe("request-local progress bridging", () => {
  it("attaches an onprogress bridge to callTool when a UI is available", async () => {
    const notify = vi.fn();
    const callTool = vi.fn(
      (_params: unknown, options?: { onprogress?: (p: { progress: number; total?: number; message?: string }) => void }) => {
        options?.onprogress?.({ progress: 3, total: 10 });
        options?.onprogress?.({ progress: 9, total: 10, message: "indexing" });
        return Promise.resolve({ content: [{ type: "text", text: "done" }] });
      },
    );
    const state = connectedState({ callTool }, { notify });

    await executeCall(state, "demo_long", {});

    expect(callTool).toHaveBeenCalledWith(
      { name: "long", arguments: {}, _meta: undefined },
      expect.objectContaining({ timeout: 5_000, onprogress: expect.any(Function) }),
    );
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, "MCP long: 3/10", "info");
    expect(notify).toHaveBeenNthCalledWith(2, "indexing (9/10)", "info");
  });

  it("does not attach onprogress when no UI is available", async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "done" }] }));
    const state = connectedState({ callTool });

    await executeCall(state, "demo_long", {});

    const options = callTool.mock.calls[0][1] as Record<string, unknown> | undefined;
    expect(options).toEqual({ timeout: 5_000 });
    expect(Object.hasOwn(options ?? {}, "onprogress")).toBe(false);
  });

  it("preserves the manager request options alongside the progress bridge", async () => {
    const notify = vi.fn();
    let capturedOptions: { signal?: AbortSignal; onprogress?: unknown } | undefined;
    const callTool = vi.fn((_params: unknown, options?: typeof capturedOptions) => {
      capturedOptions = options;
      return Promise.resolve({ content: [{ type: "text", text: "done" }] });
    });
    const controller = new AbortController();
    const state = connectedState({ callTool }, { notify });
    state.manager.getRequestOptions = vi.fn((_server: string, signal?: AbortSignal) =>
      signal ? { signal } : undefined,
    );

    await executeCall(state, "demo_long", {}, undefined, undefined, controller.signal);

    expect(capturedOptions?.signal).toBe(controller.signal);
    expect(typeof capturedOptions?.onprogress).toBe("function");
  });
});
