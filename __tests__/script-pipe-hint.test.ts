import { describe, expect, it, vi } from "vitest";
import { executeCall } from "../proxy-modes.ts";

async function callText(text: string, scriptTool: boolean, origin?: "script") {
  const client = { callTool: vi.fn(async () => ({ content: [{ type: "text", text }] })) };
  const state = {
    config: { mcpServers: { demo: { command: "node" } } },
    manager: {
      getConnection: () => ({ status: "connected", client, tools: [], resources: [] }),
      touch() {}, incrementInFlight() {}, decrementInFlight() {}, getRequestOptions() {},
    },
    toolMetadata: new Map([["demo", [{ name: "demo_get", originalName: "get", description: "Get" }]]]),
    scriptTool,
  } as any;
  const result = await executeCall(state, "demo_get", {}, undefined, undefined, undefined, origin);
  return result.content.map((block: { text?: string }) => block.text ?? "").join("");
}

describe("script pipe hint", () => {
  it("points large model-facing results at mcpScript only when the tool is registered", async () => {
    const large = "x".repeat(10 * 1024);
    expect(await callText(large, true)).toContain("Use mcpScript");
    expect(await callText(large, false)).not.toContain("mcpScript");
    expect(await callText(large, true, "script")).not.toContain("mcpScript");
    expect(await callText("short", true)).not.toContain("mcpScript");
  });

  it("measures the threshold in UTF-8 bytes and keeps the hint when output is truncated", async () => {
    expect(await callText("界".repeat(3000), true)).toContain("Use mcpScript");

    const truncated = await callText("x\n".repeat(40_000), true);
    expect(truncated).toContain("truncated");
    expect(truncated.trimEnd().endsWith("without copying it through the conversation.]")).toBe(true);
  });
});
