import { describe, expect, it, vi } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall, executeDescribe } from "../proxy-modes.ts";

function stateWith(results: unknown[], outputSchema?: unknown) {
  const callTool = vi.fn(async () => results.shift());
  const tools = [{ name: "list", description: "List things", inputSchema: { type: "object" }, ...(outputSchema ? { outputSchema } : {}) }];
  return {
    config: { settings: { toolPrefix: "server" }, mcpServers: { demo: { command: "node" } } },
    manager: {
      getConnection: vi.fn(() => ({ status: "connected", client: { callTool }, tools, resources: [] })),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
      getRequestOptions: vi.fn(() => undefined),
    },
    toolMetadata: new Map([["demo", [{ name: "demo_list", originalName: "list", description: "List things", outputSchema }]]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    completedUiSessions: [],
  } as any;
}

const describeText = (state: any) => executeDescribe(state, "demo_list").content[0]!.text;

describe("observed output shapes", () => {
  it("merges shapes across calls into optional fields without keeping values", async () => {
    const state = stateWith([
      { content: [], structuredContent: { id: "secret-id-1", tags: ["alpha"], owner: { name: "Ada" } } },
      { content: [], structuredContent: { id: "secret-id-2", count: 3 } },
    ]);
    await executeCall(state, "demo_list", {});
    await executeCall(state, "demo_list", {});

    const text = describeText(state);
    expect(text).toContain("Observed output (structuredContent, from 2 calls this session, not a contract):\n"
      + "{ id: string; tags?: string[]; owner?: { name: string; }; count?: number; }");
    expect(text).not.toMatch(/secret-id|alpha|Ada/);
  });

  it("renders a wide JSON text result from a direct tool as a map without its keys", async () => {
    const wide = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`user${index}@example.com`, index]));
    const state = stateWith([{ content: [{ type: "text", text: JSON.stringify(wide) }] }]);
    const execute = createDirectToolExecutor(() => state, () => null, {
      serverName: "demo", originalName: "list", prefixedName: "demo_list", description: "List things",
    });
    await execute("call-1", {}, undefined, undefined, {} as any);

    const text = describeText(state);
    expect(text).toContain("Observed output (JSON text result, from 1 call this session, not a contract):\nRecord<string, number>");
    expect(text).not.toContain("example.com");
  });

  it("renders a small object keyed by data as a map without its keys", async () => {
    const state = stateWith([{ content: [], structuredContent: {
      results: { "alice@example.com": { score: 1 }, "550e8400-e29b-41d4-a716-446655440000": { score: 2 } },
    } }]);
    await executeCall(state, "demo_list", {});

    const text = describeText(state);
    expect(text).toContain("{ results: Record<string, { score: number; }>; }");
    expect(text).not.toMatch(/alice|550e8400/);
  });

  it("shows nothing for tools that declare an output schema", async () => {
    const state = stateWith([{ content: [], structuredContent: { id: "x" } }], { type: "object" });
    await executeCall(state, "demo_list", {});

    expect(describeText(state)).not.toContain("Observed output");
  });

  it("starts over when the server is replaced under the same name", async () => {
    const state = stateWith([{ content: [], structuredContent: { id: "x" } }]);
    await executeCall(state, "demo_list", {});
    expect(describeText(state)).toContain("Observed output");

    state.config.mcpServers.demo = { command: "node" };
    expect(describeText(state)).not.toContain("Observed output");
  });

  it("renders an own __proto__ key as a map", async () => {
    const state = stateWith([{ content: [], structuredContent: JSON.parse('{ "__proto__": { "id": "x" } }') }]);
    await executeCall(state, "demo_list", {});

    expect(describeText(state)).toContain("\nRecord<string, { id: string; }>");
  });
});
