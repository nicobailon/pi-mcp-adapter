import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ mcpServers: {} })),
  loadCache: vi.fn(() => null),
}));

vi.mock("../config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.ts")>();
  return { ...actual, loadMcpConfig: spies.loadConfig };
});

vi.mock("../metadata-cache.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../metadata-cache.ts")>();
  return { ...actual, loadMetadataCache: spies.loadCache };
});

import mcpAdapter from "../index.ts";
import { createMcpAdapter } from "../programmatic.ts";

function initialSource() {
  return {
    source: {
      identity: { id: "com.example.ordering:workspace", revision: "revision-1" },
      servers: {
        qualified: {
          transport: "stdio" as const,
          requestTimeoutMs: 500,
        },
      },
    },
    launchValues: {
      resolve: vi.fn(async () => ({ transport: "stdio" as const, command: "command", args: [] })),
      dispose: vi.fn(async () => undefined),
    },
  };
}

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const tools: any[] = [];
  const api = {
    registerTool: vi.fn((tool: unknown) => tools.push(tool)),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler)),
    getAllTools: vi.fn(() => []),
    sendMessage: vi.fn(),
  } as any;
  return { api, handlers, tools };
}

beforeEach(() => {
  spies.loadConfig.mockClear();
  spies.loadCache.mockClear();
  spies.loadConfig.mockReturnValue({ mcpServers: {} });
  spies.loadCache.mockReturnValue(null);
});

describe("programmatic adapter construction", () => {
  it("installs initial sources before tool registration without file/cache discovery", async () => {
    const initial = initialSource();
    const adapter = createMcpAdapter({ fileDiscovery: "disabled", initialSources: [initial] });
    expect(await adapter.runtime.inspectSources(new AbortController().signal)).toHaveLength(1);
    expect(initial.launchValues.resolve).not.toHaveBeenCalled();

    const pi = createPi();
    adapter.extension(pi.api);

    expect(spies.loadConfig).not.toHaveBeenCalled();
    expect(spies.loadCache).not.toHaveBeenCalled();
    expect(pi.api.registerTool).toHaveBeenCalledTimes(1);
    expect(pi.api.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  });

  it("uses the isolated source through the Pi gateway after session startup", async () => {
    const initial = initialSource();
    const adapter = createMcpAdapter({ fileDiscovery: "disabled", initialSources: [initial] });
    const pi = createPi();
    adapter.extension(pi.api);

    await pi.handlers.get("session_start")?.({}, {
      cwd: process.cwd(),
      hasUI: false,
      signal: new AbortController().signal,
    });
    const gateway = pi.tools[0];
    const result = await gateway.execute("call-1", { action: "status" }, new AbortController().signal);

    expect(result.details).toEqual([
      expect.objectContaining({ identity: initial.source.identity }),
    ]);
  });

  it("serializes rapid session starts so an older completion cannot detach the latest session", async () => {
    const adapter = createMcpAdapter({ fileDiscovery: "disabled" });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const firstAttached = new Promise<void>((resolve) => { firstStarted = resolve; });
    let active: string | undefined;
    const runtime = adapter.runtime as any;
    runtime.attachSession = vi.fn(async (context: { name: string }) => {
      if (context.name === "first") {
        firstStarted();
        await firstBlocked;
      }
      active = context.name;
    });
    runtime.detachSession = vi.fn(async () => { active = undefined; });

    const pi = createPi();
    adapter.extension(pi.api);
    const first = pi.handlers.get("session_start")?.({}, { name: "first" });
    await firstAttached;
    const second = pi.handlers.get("session_start")?.({}, { name: "second" });
    releaseFirst();
    await Promise.all([first, second]);

    expect(active).toBe("second");
    expect(runtime.attachSession).toHaveBeenCalledTimes(2);
    expect(runtime.detachSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the ordinary default extension behavior unchanged", () => {
    const direct = createPi();
    mcpAdapter(direct.api);
    const directCalls = {
      config: spies.loadConfig.mock.calls.length,
      cache: spies.loadCache.mock.calls.length,
      flags: direct.api.registerFlag.mock.calls,
      commands: direct.api.registerCommand.mock.calls.map((call: unknown[]) => call[0]),
      tools: direct.api.registerTool.mock.calls.map((call: any[]) => call[0].name),
    };

    spies.loadConfig.mockClear();
    spies.loadCache.mockClear();
    const composed = createPi();
    createMcpAdapter({ fileDiscovery: "enabled" }).extension(composed.api);

    expect(spies.loadConfig).toHaveBeenCalledTimes(directCalls.config);
    expect(spies.loadCache).toHaveBeenCalledTimes(directCalls.cache);
    expect(composed.api.registerFlag.mock.calls).toEqual(directCalls.flags);
    expect(composed.api.registerCommand.mock.calls.map((call: unknown[]) => call[0]))
      .toEqual(directCalls.commands);
    expect(composed.api.registerTool.mock.calls.map((call: any[]) => call[0].name))
      .toEqual([...directCalls.tools, "mcp_sources"]);
  });

  it("rejects malformed initial sources before any Pi tool can be registered", () => {
    expect(() => createMcpAdapter({
      fileDiscovery: "disabled",
      initialSources: [{
        source: { identity: { id: "", revision: "" }, servers: {} },
        launchValues: { resolve: vi.fn(), dispose: vi.fn() },
      } as any],
    })).toThrow("MCP programmatic runtime operation failed");
  });
});
