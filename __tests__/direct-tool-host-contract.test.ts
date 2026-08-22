import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  clearFailure: vi.fn(),
}));

vi.mock("../init.ts", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  clearFailure: mocks.clearFailure,
}));

describe("direct tool host contracts", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset().mockResolvedValue(true);
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.clearFailure.mockReset();
  });

  it("recovers one JSON layer for schema-declared containers and validates the result", async () => {
    const { prepareDirectToolArguments } = await import("../direct-tools.ts");
    const schema = {
      type: "object",
      required: ["filter", "columns"],
      properties: {
        filter: { type: "object", required: ["site"], properties: { site: { type: "string" } } },
        columns: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    };

    expect(prepareDirectToolArguments(schema, {
      filter: '{"site":"north"}',
      columns: '["temperature","salinity"]',
    })).toEqual({
      filter: { site: "north" },
      columns: ["temperature", "salinity"],
    });
    expect(() => prepareDirectToolArguments(schema, {
      filter: '{"site":7}',
      columns: '["temperature"]',
    })).toThrow("MCP direct tool arguments do not match the advertised input schema");
  });

  it("returns a bounded raw MCP result when configured", async () => {
    const rawResult = {
      content: [{ type: "text", text: "accepted" }],
      structuredContent: {
        contract: "reserve_governed_tool_result_v1",
        operation_receipt: {
          contract: "agent_tool_operation_receipt_v1",
          tool_call_id: "call-19",
        },
      },
    };
    const connection = {
      status: "connected",
      client: { callTool: vi.fn().mockResolvedValue(rawResult) },
    };
    const state = {
      config: {
        settings: { directToolResultDetails: "bounded" },
        mcpServers: { demo: { command: "demo" } },
      },
      manager: {
        getConnection: vi.fn(() => connection),
        getRequestOptions: vi.fn(() => undefined),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      completedUiSessions: [],
    } as any;
    const { createDirectToolExecutor } = await import("../direct-tools.ts");
    const execute = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "commit",
      prefixedName: "demo_commit",
      description: "Commit one operation",
    });

    const result = await execute("call-19", {}, undefined, undefined, undefined as any);

    expect(result.details).toMatchObject({
      server: "demo",
      tool: "commit",
      mcpResult: rawResult,
    });
  });
});
