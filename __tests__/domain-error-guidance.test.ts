import { describe, expect, it, vi } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";

function connectedState() {
  const callTool = vi.fn(async () => ({
    isError: true,
    content: [{ type: "text", text: "domain failure" }],
  }));
  const metadata = {
    name: "demo_lookup",
    originalName: "lookup",
    description: "Lookup",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  };
  const state = {
    config: {
      settings: { toolPrefix: "server" },
      mcpServers: { demo: { command: "node", args: ["server.js"] } },
    },
    manager: {
      getConnection: vi.fn(() => ({ status: "connected", client: { callTool }, tools: [], resources: [] })),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      close: vi.fn(async () => undefined),
      getRequestOptions: vi.fn(() => undefined),
    },
    toolMetadata: new Map([["demo", [metadata]]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    completedUiSessions: [],
    ui: undefined,
  } as any;
  return { state, metadata, callTool };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
}

describe("server-returned domain errors", () => {
  it.each(["direct", "proxy", "proxy-ui"] as const)("does not append input guidance on the %s path", async (path) => {
    const { state, metadata, callTool } = connectedState();
    if (path === "proxy-ui") metadata.uiResourceUri = "ui://demo/lookup";
    const result = path.startsWith("proxy")
      ? await executeCall(state, metadata.name, { id: "missing" }, "demo")
      : await createDirectToolExecutor(() => state, () => null, {
          serverName: "demo",
          prefixedName: metadata.name,
          originalName: metadata.originalName,
          description: metadata.description,
          inputSchema: metadata.inputSchema,
        })("call-1", { id: "missing" }, undefined, undefined, undefined as any);

    expect(text(result)).toBe("Error: domain failure");
    expect(result.details).toMatchObject({ error: "tool_error", server: "demo" });
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("rejects schema-invalid proxy arguments before dispatch with corrective guidance", async () => {
    const { state, metadata, callTool } = connectedState();

    const result = await executeCall(state, metadata.name, {}, "demo");

    expect(text(result)).toContain("Expected parameters:");
    expect(text(result)).toContain("id (string) *required*");
    expect(result.details).toMatchObject({ error: "call_failed", server: "demo" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("isolates and safely reuses proxy validation for schemas sharing an id", async () => {
    const { state, callTool } = connectedState();
    state.toolMetadata.set("demo", [
      {
        name: "demo_first",
        originalName: "first",
        description: "First",
        inputSchema: {
          $id: "https://example.test/shared-tool-schema",
          type: "object",
          properties: { first: { type: "string" } },
          required: ["first"],
        },
      },
      {
        name: "demo_second",
        originalName: "second",
        description: "Second",
        inputSchema: {
          $id: "https://example.test/shared-tool-schema",
          type: "object",
          properties: { second: { type: "string" } },
          required: ["second"],
        },
      },
    ]);

    await executeCall(state, "demo_first", { first: "one" }, "demo");
    await executeCall(state, "demo_second", { second: "two" }, "demo");
    await executeCall(state, "demo_second", { first: "wrong schema" }, "demo");

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      { name: "second", arguments: { second: "two" } },
      undefined,
    );
  });
});
