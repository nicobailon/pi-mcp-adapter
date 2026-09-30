import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { DirectToolSpec } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

const fixture = fileURLToPath(new URL("./fixtures/progress-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
});

describe("progress-aware tool call timeouts with the real MCP SDK", () => {
  // The fixture tool runs for 1 s and reports progress every 100 ms.
  it.each([
    ["proxy", false],
    ["direct", false],
    ["proxy", true],
    ["direct", true],
  ] as const)("keeps a %s call alive past the timeout while the tool reports progress (elicitation handler: %s)", async (adapter, withElicitation) => {
    const manager = new McpServerManager();
    managers.push(manager);
    if (withElicitation) {
      manager.setElicitationConfig({
        ui: { select: vi.fn(), input: vi.fn(), notify: vi.fn() } as unknown as ExtensionUIContext,
        allowUrl: false,
      });
    }
    await manager.connect("real", definition);
    // Set after connecting so a slow runner's spawn and handshake do not use up the call's timeout.
    manager.setDefaultRequestTimeoutMs(500);
    const state = {
      manager,
      config: { settings: {}, mcpServers: { real: definition } },
      toolMetadata: new Map([["real", [{ name: "real_slow", originalName: "slow", description: "slow" }]]]),
      serverInstructions: new Map(),
      failureTracker: new Map(),
      uiResourceHandler: new UiResourceHandler(manager),
      completedUiSessions: [],
      uiServer: null,
    } as McpExtensionState;
    const spec = { serverName: "real", prefixedName: "real_slow", originalName: "slow", description: "slow" } as DirectToolSpec;

    const result = adapter === "proxy"
      ? await executeCall(state, "real_slow", {}, "real")
      : await createDirectToolExecutor(() => state, () => null, spec)("id", {});

    expect(result.details).not.toHaveProperty("error");
    expect(result.content).toEqual([{ type: "text", text: "finished" }]);
  });
});
