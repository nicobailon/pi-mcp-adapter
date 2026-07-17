import { describe, expect, it, vi } from "vitest";
import { abortable } from "../abort.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeConnect } from "../proxy-modes.ts";
import { lazyConnect } from "../init.ts";
import { McpServerManager } from "../server-manager.ts";

function connectedState(client: Record<string, unknown>) {
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
      getRequestOptions: vi.fn((_server: string, signal?: AbortSignal) => signal ? { signal } : undefined),
    },
    toolMetadata: new Map([
      [
        "demo",
        [
          {
            name: "demo_slow",
            originalName: "slow",
            description: "Slow tool",
          },
        ],
      ],
    ]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    ui: undefined,
  } as any;
}

describe("AbortSignal propagation", () => {
  it("abortable rejects promptly when the host signal aborts", async () => {
    const controller = new AbortController();
    const inFlight = abortable(new Promise<never>(() => {}), controller.signal);

    controller.abort(new Error("user cancelled"));

    await expect(inFlight).rejects.toThrow("user cancelled");
  });

  it("direct tools pass AbortSignal to MCP callTool and settle if the MCP SDK promise hangs", async () => {
    const controller = new AbortController();
    const callTool = vi.fn(() => new Promise<never>(() => {}));
    const state = connectedState({ callTool });
    const execute = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "slow",
        prefixedName: "demo_slow",
        description: "Slow tool",
      },
    );

    const inFlight = execute("call-1", {}, controller.signal, undefined, {} as any);
    await Promise.resolve();
    controller.abort(new Error("user cancelled"));

    const result = await inFlight;
    expect(result.content[0].text).toContain("Failed to call tool: user cancelled");
    expect(result.details.error).toBe("call_failed");
    expect(callTool).toHaveBeenCalledWith(
      { name: "slow", arguments: {}, _meta: undefined },
      undefined,
      { signal: controller.signal },
    );
    expect(state.manager.decrementInFlight).toHaveBeenCalledWith("demo");
  });

  it("proxy tool calls pass AbortSignal to MCP callTool and settle if the MCP SDK promise hangs", async () => {
    const controller = new AbortController();
    const callTool = vi.fn(() => new Promise<never>(() => {}));
    const state = connectedState({ callTool });

    const inFlight = executeCall(state, "demo_slow", {}, undefined, undefined, controller.signal);
    await Promise.resolve();
    controller.abort(new Error("user cancelled"));

    const result = await inFlight;
    expect(result.content[0].text).toContain("Failed to call tool: user cancelled");
    expect(result.details.error).toBe("call_failed");
    expect(callTool).toHaveBeenCalledWith(
      { name: "slow", arguments: {}, _meta: undefined },
      undefined,
      { signal: controller.signal },
    );
    expect(state.manager.decrementInFlight).toHaveBeenCalledWith("demo");
  });

  it("proxy connect passes AbortSignal to manager.connect and does not record aborts as server failures", async () => {
    const controller = new AbortController();
    const state = {
      config: { mcpServers: { demo: { command: "node", args: ["server.js"] } } },
      manager: {
        connect: vi.fn(async (_name, _definition, signal?: AbortSignal) => {
          controller.abort(new Error("user cancelled"));
          signal?.throwIfAborted();
          return { status: "connected", tools: [], resources: [] };
        }),
        getAllConnections: vi.fn(() => new Map()),
      },
      toolMetadata: new Map(),
      failureTracker: new Map(),
      ui: undefined,
    } as any;

    const result = await executeConnect(state, "demo", controller.signal);

    expect(result.details.error).toBe("aborted");
    expect(state.manager.connect).toHaveBeenCalledWith("demo", state.config.mcpServers.demo, controller.signal);
    expect(state.failureTracker.size).toBe(0);
  });

  it("lazyConnect rethrows host aborts without updating the failure backoff", async () => {
    const controller = new AbortController();
    const state = {
      config: { mcpServers: { demo: { command: "node", args: ["server.js"] } } },
      manager: {
        getConnection: vi.fn(() => undefined),
        connect: vi.fn(async (_name, _definition, signal?: AbortSignal) => {
          signal?.throwIfAborted();
          return { status: "connected", tools: [], resources: [] };
        }),
      },
      toolMetadata: new Map(),
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
    } as any;

    controller.abort(new Error("user cancelled"));

    await expect(lazyConnect(state, "demo", controller.signal)).rejects.toThrow("user cancelled");
    expect(state.failureTracker.size).toBe(0);
  });

  it("server-manager resource discovery does not swallow host aborts", async () => {
    const controller = new AbortController();
    const client = {
      listResources: vi.fn(async (_params, options?: { signal?: AbortSignal }) => {
        options?.signal?.throwIfAborted();
        return { resources: [] };
      }),
    };
    const manager = new McpServerManager({} as any);

    controller.abort(new Error("user cancelled"));

    await expect((manager as any).fetchAllResources(client, { signal: controller.signal })).rejects.toThrow("user cancelled");
  });

  it("server-manager readResource passes AbortSignal through the MCP SDK request options", async () => {
    const controller = new AbortController();
    const readResource = vi.fn(async () => ({ contents: [] }));
    const manager = new McpServerManager({} as any);
    (manager as any).connections.set("demo", {
      status: "connected",
      client: { readResource },
    });

    await manager.readResource("demo", "resource://demo", controller.signal);

    expect(readResource).toHaveBeenCalledWith(
      { uri: "resource://demo" },
      { signal: controller.signal },
    );
  });
});
