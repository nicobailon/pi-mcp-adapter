import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpExtensionState } from "../state.ts";
import type { MetadataCache, ServerEntry, ToolMetadata } from "../types.ts";
import { computeServerHash } from "../metadata-cache.ts";

const cacheState = vi.hoisted(() => ({ value: null as MetadataCache | null }));

vi.mock("../metadata-cache.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metadata-cache.ts")>()),
  loadMetadataCache: () => cacheState.value,
  saveMetadataCache: vi.fn(),
}));

import { executeCall } from "../proxy-modes.ts";

function cacheFor(entries: Array<[string, ServerEntry, Array<{ name: string; inputSchema?: unknown }>, Partial<{ cachedAt: number; configHash: string }>?]>): MetadataCache {
  return {
    version: 1,
    servers: Object.fromEntries(entries.map(([name, definition, tools, overrides]) => [name, {
      configHash: overrides?.configHash ?? computeServerHash(definition),
      cachedAt: overrides?.cachedAt ?? Date.now(),
      tools,
      resources: [],
    }])),
  };
}

function metadata(server: string, originalName: string, inputSchema?: unknown): ToolMetadata {
  return {
    name: `${server}_${originalName}`,
    originalName,
    description: `${originalName} tool`,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
  };
}

function createState(options: {
  settings?: Record<string, unknown>;
  definitions?: Record<string, ServerEntry>;
  metadata?: Array<[string, ToolMetadata[]]>;
  connected?: boolean;
} = {}) {
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  const events: string[] = [];
  const definitions = options.definitions ?? { demo: { command: "demo" } };
  const connectionTools = (options.metadata ?? []).flatMap(([, tools]) => tools
    .filter((tool) => !tool.resourceUri)
    .map((tool) => ({
      name: tool.originalName,
      description: tool.description,
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    })));
  let connection: any = options.connected
    ? { status: "connected", client: { callTool }, tools: connectionTools, resources: [], prompts: [] }
    : undefined;
  const manager = {
    getConnection: vi.fn(() => connection),
    connect: vi.fn(async () => {
      events.push("connect");
      connection = { status: "connected", client: { callTool }, tools: connectionTools, resources: [], prompts: [] };
      return connection;
    }),
    close: vi.fn(),
    touch: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
    getRequestOptions: vi.fn(() => undefined),
    isConnecting: vi.fn(() => false),
  };
  callTool.mockImplementation(async () => {
    events.push("call");
    return { content: [{ type: "text", text: "ok" }] };
  });
  const state = {
    config: {
      settings: { strictProxyToolArguments: true, ...options.settings },
      mcpServers: definitions,
    },
    toolMetadata: new Map(options.metadata ?? []),
    resourceCounts: new Map(),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    manager,
    failureTracker: new Map(),
    failureMessages: new Map(),
    approvedToolCalls: new Map(),
    completedUiSessions: [],
  } as unknown as McpExtensionState;
  return { state, manager, callTool, events };
}

const requiredSchema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
};

beforeEach(() => {
  cacheState.value = null;
});

describe("strict proxy argument preflight", () => {
  it("returns a hard server_not_found failure without connecting", async () => {
    const { state, manager } = createState();

    const result = await executeCall(state, "search", {}, "missing");

    expect(result).toMatchObject({
      isError: true,
      details: {
        mode: "call",
        error: "server_not_found",
        server: "missing",
        requestedTool: "search",
        connectionAttempted: false,
        nextAction: expect.stringContaining("search"),
      },
    });
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("returns server_disabled before metadata or connection work", async () => {
    const definition = { command: "demo", disabled: true };
    const { state, manager } = createState({ definitions: { demo: definition } });

    const result = await executeCall(state, "search", {}, "demo");

    expect(result).toMatchObject({ isError: true, details: { error: "server_disabled", connectionAttempted: false } });
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["hash-invalid", cacheFor([["demo", { command: "demo" }, [{ name: "search", inputSchema: requiredSchema }], { configHash: "stale" }]])],
    ["stale", cacheFor([["demo", { command: "demo" }, [{ name: "search", inputSchema: requiredSchema }], { cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }]])],
  ])("returns metadata_unavailable for %s cached metadata", async (_label, cache) => {
    cacheState.value = cache;
    const { state, manager } = createState({
      metadata: [["demo", [metadata("demo", "search", requiredSchema)]]],
    });

    const result = await executeCall(state, "search", { query: "private-value" }, "demo");

    expect(result).toMatchObject({
      isError: true,
      details: {
        error: "metadata_unavailable",
        server: "demo",
        connectionAttempted: false,
        nextAction: 'mcp({ connect: "demo" })',
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("returns tool_not_found with bounded suggestions and no probe", async () => {
    const definition = { command: "demo" };
    cacheState.value = cacheFor([["demo", definition, [{ name: "search", inputSchema: requiredSchema }]]]);
    const { state, manager } = createState({
      definitions: { demo: definition },
      metadata: [["demo", [metadata("demo", "search", requiredSchema)]]],
    });

    const result = await executeCall(state, "missing-tool", {}, "demo");

    expect(result).toMatchObject({
      isError: true,
      details: {
        error: "tool_not_found",
        server: "demo",
        requestedTool: "missing-tool",
        suggestions: expect.any(Array),
        connectionAttempted: false,
        nextAction: expect.stringContaining("search"),
      },
    });
    expect((result.details.suggestions as unknown[]).length).toBeLessThanOrEqual(5);
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("fails closed for an ambiguous unqualified atomic tool", async () => {
    const first = { command: "first" };
    const second = { command: "second" };
    cacheState.value = cacheFor([
      ["first", first, [{ name: "search", inputSchema: requiredSchema }]],
      ["second", second, [{ name: "search", inputSchema: requiredSchema }]],
    ]);
    const { state, manager } = createState({
      definitions: { first, second },
      metadata: [
        ["first", [metadata("first", "search", requiredSchema)]],
        ["second", [metadata("second", "search", requiredSchema)]],
      ],
    });

    const result = await executeCall(state, "search", { query: "x" });

    expect(result).toMatchObject({
      isError: true,
      details: { error: "ambiguous_tool", connectionAttempted: false, nextAction: expect.stringContaining("server") },
    });
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["missing required property", {}, "/query", "required"],
    ["wrong scalar type", { query: 2026 }, "/query", "type"],
  ])("rejects %s without echoing values or connecting", async (_label, args, path, keyword) => {
    const definition = { command: "demo" };
    cacheState.value = cacheFor([["demo", definition, [{ name: "search", inputSchema: requiredSchema }]]]);
    const { state, manager, callTool } = createState({
      definitions: { demo: definition },
      metadata: [["demo", [metadata("demo", "search", requiredSchema)]]],
    });

    const result = await executeCall(state, "search", args, "demo");

    expect(result).toMatchObject({
      isError: true,
      details: {
        error: "invalid_arguments",
        canonicalTarget: "demo/search",
        issues: [expect.objectContaining({ instancePath: path, keyword })],
        connectionAttempted: false,
        nextAction: 'mcp({ describe: "demo/search" })',
      },
    });
    expect(JSON.stringify(result)).not.toContain("2026");
    expect(manager.connect).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("recovers exactly one JSON layer for declared containers without scalar coercion", async () => {
    const definition = { command: "demo" };
    const schema = {
      type: "object",
      properties: {
        filter: { type: "object", properties: { site: { type: "string" } }, required: ["site"] },
      },
      required: ["filter"],
    };
    cacheState.value = cacheFor([["demo", definition, [{ name: "search", inputSchema: schema }]]]);
    const { state, callTool } = createState({
      definitions: { demo: definition },
      metadata: [["demo", [metadata("demo", "search", schema)]]],
      connected: true,
    });

    const result = await executeCall(state, "search", { filter: '{"site":"north"}' }, "demo");

    expect(result.isError).not.toBe(true);
    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { filter: { site: "north" } }, _meta: undefined },
      undefined,
    );
  });

  it("rejects unsupported schema dialects before connection", async () => {
    const definition = { command: "demo" };
    const schema = { $schema: "https://example.test/schema", type: "object" };
    cacheState.value = cacheFor([["demo", definition, [{ name: "search", inputSchema: schema }]]]);
    const { state, manager } = createState({
      definitions: { demo: definition },
      metadata: [["demo", [metadata("demo", "search", schema)]]],
    });

    const result = await executeCall(state, "search", {}, "demo");

    expect(result).toMatchObject({
      isError: true,
      details: { error: "metadata_unavailable", reason: "unsupported_schema", connectionAttempted: false },
    });
    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("validates before lazy connect and calls the selected atomic tool exactly once", async () => {
    const definition = { command: "demo" };
    cacheState.value = cacheFor([["demo", definition, [{ name: "search", inputSchema: requiredSchema }]]]);
    const { state, manager, callTool, events } = createState({
      definitions: { demo: definition },
      metadata: [["demo", [metadata("demo", "search", requiredSchema)]]],
    });

    const result = await executeCall(state, "search", { query: "ok" }, "demo");

    expect(result.isError).not.toBe(true);
    expect(events).toEqual(["connect", "call"]);
    expect(manager.connect).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
