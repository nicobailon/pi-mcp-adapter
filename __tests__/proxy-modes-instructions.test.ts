import { describe, expect, it } from "vitest";
import { executeInstructions, executeList } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";

const SHORT_INSTRUCTIONS = "Call read_skill with a skill name before answering.";
const LONG_INSTRUCTIONS = `Available skills: ${Array.from({ length: 40 }, (_, i) => `skill-${i}`).join(", ")}. Call read_skill with a skill name to load one.`;

function createState(overrides: { instructions?: string; connected?: boolean } = {}): McpExtensionState {
  return {
    config: {
      mcpServers: {
        demo: { command: "npx", args: ["demo"] },
      },
    },
    toolMetadata: new Map([
      [
        "demo",
        [
          {
            name: "demo_read_skill",
            originalName: "read_skill",
            description: "Read a skill listed in this server's instructions",
          },
        ],
      ],
    ]),
    serverInstructions: new Map(overrides.instructions ? [["demo", overrides.instructions]] : []),
    manager: {
      getConnection: () => (overrides.connected ? { status: "connected" } : undefined),
    },
    failureTracker: new Map(),
  } as unknown as McpExtensionState;
}

describe("proxy instructions", () => {
  it("includes short server instructions in full in the listing", () => {
    const result = executeList(createState({ instructions: SHORT_INSTRUCTIONS }), "demo");

    expect(result.content[0].text).toContain(`Server instructions:\n${SHORT_INSTRUCTIONS}`);
    expect(result.content[0].text).not.toContain("mcp({ instructions:");
    expect(result.details).toMatchObject({ mode: "list", hasInstructions: true });
  });

  it("truncates long instructions in the listing and points at the instructions mode", () => {
    const result = executeList(createState({ instructions: LONG_INSTRUCTIONS }), "demo");

    expect(result.content[0].text).toContain("Server instructions:");
    expect(result.content[0].text).not.toContain(LONG_INSTRUCTIONS);
    expect(result.content[0].text).toContain('Use mcp({ instructions: "demo" }) for the full text.');
  });

  it("leaves the listing unchanged when a server has no instructions", () => {
    const result = executeList(createState(), "demo");

    expect(result.content[0].text).not.toContain("Server instructions");
    expect(result.details).toMatchObject({ mode: "list", hasInstructions: false });
  });

  it("returns the full instructions text", () => {
    const result = executeInstructions(createState({ instructions: LONG_INSTRUCTIONS }), "demo");

    expect(result.content[0].text).toBe(`demo instructions:\n\n${LONG_INSTRUCTIONS}`);
    expect(result.details).toMatchObject({ mode: "instructions", server: "demo", length: LONG_INSTRUCTIONS.length });
  });

  it("reports unknown servers", () => {
    const result = executeInstructions(createState(), "missing");

    expect(result.content[0].text).toContain('Server "missing" not found');
    expect(result.details).toMatchObject({ mode: "instructions", error: "not_found" });
  });

  it("reports connected servers that provide no instructions", () => {
    const result = executeInstructions(createState({ connected: true }), "demo");

    expect(result.content[0].text).toBe('Server "demo" does not provide instructions.');
    expect(result.details).toMatchObject({ mode: "instructions", error: "no_instructions" });
  });

  it("suggests connecting when no instructions are cached", () => {
    const result = executeInstructions(createState(), "demo");

    expect(result.content[0].text).toContain('mcp({ connect: "demo" })');
    expect(result.details).toMatchObject({ mode: "instructions", error: "not_connected" });
  });
});
