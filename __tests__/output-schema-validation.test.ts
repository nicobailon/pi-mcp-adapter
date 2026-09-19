import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { DirectToolSpec, ToolMetadata } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

const fixture = fileURLToPath(new URL("./fixtures/output-schema-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];

function createState(manager: McpServerManager, names: string[]): McpExtensionState {
  const metadata = names.map((name): ToolMetadata => ({
    name: `real_${name}`,
    originalName: name,
    description: "integration test",
    inputSchema: { type: "object" },
  }));
  return {
    manager,
    config: { settings: {}, mcpServers: { real: definition } },
    toolMetadata: new Map([["real", metadata]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    completedUiSessions: [],
    uiServer: null,
  } as McpExtensionState;
}

function directSpec(originalName: string): DirectToolSpec {
  return {
    serverName: "real",
    originalName,
    prefixedName: `real_${originalName}`,
    description: "integration test",
    inputSchema: { type: "object" },
  };
}

describe("MCP output schema validation", () => {
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  });

  it.each([
    ["draft07-valid", "proxy"],
    ["draft2020-valid", "proxy"],
    ["draft07-valid", "direct"],
    ["draft2020-valid", "direct"],
  ] as const)("accepts valid %s output through the %s path", async (name, path) => {
    const manager = new McpServerManager();
    await manager.connect("real", definition);
    managers.push(manager);
    const state = createState(manager, [name]);

    const result = path === "proxy"
      ? await executeCall(state, `real_${name}`, {})
      : await createDirectToolExecutor(() => state, () => null, directSpec(name))("id", {});

    expect(result.details).not.toMatchObject({ error: "call_failed" });
    expect(result.content).toEqual([
      { type: "text", text: name },
      { type: "text", text: 'structuredContent:\n{\n  "values": [\n    "ok",\n    1\n  ]\n}' },
    ]);
  });

  it.each([
    ["draft07-invalid", "proxy"],
    ["draft2020-invalid", "proxy"],
    ["draft07-invalid", "direct"],
    ["draft2020-invalid", "direct"],
  ] as const)("rejects invalid %s output through the %s path", async (name, path) => {
    const manager = new McpServerManager();
    await manager.connect("real", definition);
    managers.push(manager);
    const state = createState(manager, [name]);

    const result = path === "proxy"
      ? await executeCall(state, `real_${name}`, {})
      : await createDirectToolExecutor(() => state, () => null, directSpec(name))("id", {});

    expect(result.details).toMatchObject({ error: "call_failed" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Structured content does not match the tool's output schema"),
    });
  });
});
