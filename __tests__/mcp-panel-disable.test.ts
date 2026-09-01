import { describe, expect, it } from "vitest";
import { createMcpPanel } from "../mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks, McpPanelResult } from "../types.ts";

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function createCallbacks(): McpPanelCallbacks {
  return {
    reconnect: async () => true,
    canAuthenticate: () => false,
    authenticate: async () => ({ ok: false }),
    getConnectionStatus: () => "idle",
    refreshCacheAfterReconnect: () => null,
  };
}

const CTRL_D = "\x04";
const CTRL_S = "\x13";

function openPanel(
  config: McpConfig,
  callbacks: McpPanelCallbacks = createCallbacks(),
  cache: MetadataCache | null = null,
): { panel: ReturnType<typeof createMcpPanel>; results: McpPanelResult[] } {
  const results: McpPanelResult[] = [];
  const panel = createMcpPanel(config, cache, new Map(), callbacks, { requestRender: () => {} }, (r) => {
    results.push(r);
  });
  return { panel, results };
}

describe("mcp-panel server disable toggle", () => {
  it("shows disabled status for disabled servers and includes hint", () => {
    const config: McpConfig = {
      mcpServers: {
        datadog: { command: "npx", args: ["-y", "dd-mcp"], disabled: true },
      },
    };
    const callbacks: McpPanelCallbacks = {
      ...createCallbacks(),
      getConnectionStatus: () => "disabled",
    };
    const { panel } = openPanel(config, callbacks);

    const output = stripAnsi(panel.render(120).join("\n"));
    expect(output).toContain("disabled");
    expect(output).toContain("disable/enable");
    panel.dispose();
  });

  it("save with no toggle reports no disabledChanges", () => {
    const config: McpConfig = {
      mcpServers: {
        alpha: { command: "npx", args: ["-y", "alpha-mcp"] },
      },
    };
    const { panel, results } = openPanel(config);

    panel.handleInput("\x13"); // ctrl+s
    expect(results[0]).toEqual({ changes: new Map(), disabledChanges: new Map(), cancelled: false });
    panel.dispose();
  });

  it("ctrl+d toggles disabled and save reports disabledChanges", () => {
    const config: McpConfig = {
      mcpServers: {
        alpha: { command: "npx", args: ["-y", "alpha-mcp"] },
        beta: { command: "npx", args: ["-y", "beta-mcp"], disabled: true },
      },
    };
    const { panel, results } = openPanel(config);

    panel.handleInput(CTRL_D);
    const output = stripAnsi(panel.render(120).join("\n"));
    expect(output).toContain("(unsaved)");

    panel.handleInput("\x13"); // ctrl+s

    expect(results).toHaveLength(1);
    expect(results[0]?.cancelled).toBe(false);
    expect(results[0]?.disabledChanges.get("alpha")).toBe(true);
    expect(results[0]?.changes.size).toBe(0);
    panel.dispose();
  });

  it("ctrl+d on a tool row does not toggle the server", () => {
    const config: McpConfig = {
      mcpServers: {
        alpha: { command: "npx", args: ["-y", "alpha-mcp"] },
      },
    };
    const cache = {
      version: 1,
      servers: {
        alpha: {
          configHash: computeServerHash(config.mcpServers.alpha),
          cachedAt: Date.now(),
          tools: [{ name: "do_thing", description: "Does a thing" }],
          resources: [],
        },
      },
    };
    const { panel, results } = openPanel(config, undefined, cache as MetadataCache);
    panel.handleInput("\r");
    panel.handleInput("\x1b[B"); // down
    panel.handleInput(CTRL_D);
    panel.handleInput("\x13"); // ctrl+s

    expect(results[0]?.disabledChanges.size).toBe(0);
    panel.dispose();
  });

  it("re-enabling a disabled server reports disabledChanges false", () => {
    const config: McpConfig = {
      mcpServers: {
        datadog: { command: "npx", args: ["-y", "dd-mcp"], disabled: true },
      },
    };
    const { panel, results } = openPanel(config);

    panel.handleInput(CTRL_D);
    panel.handleInput("\x13");

    expect(results[0]?.disabledChanges.get("datadog")).toBe(false);
    panel.dispose();
  });

  it("escape after toggle offers discard, discarding reports cancelled", () => {
    const config: McpConfig = {
      mcpServers: {
        alpha: { command: "npx", args: ["-y", "alpha-mcp"] },
      },
    };
    const { panel, results } = openPanel(config);

    panel.handleInput(CTRL_D);
    panel.handleInput("\x1b"); // escape → discard confirm (default selection is Keep)
    panel.handleInput("y"); // discard
    expect(results[0]?.cancelled).toBe(true);
    panel.dispose();
  });
});
