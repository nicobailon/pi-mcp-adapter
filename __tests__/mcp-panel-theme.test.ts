import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createMcpPanel } from "../mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks } from "../types.ts";

function createTheme() {
  const colors: Record<string, number> = {
    accent: 31,
    border: 32,
    success: 33,
    warning: 34,
    muted: 35,
    dim: 36,
    error: 37,
  };
  const fg = vi.fn((color: string, text: string) => `\x1b[38;5;${colors[color] ?? 38}m${text}\x1b[39m`);
  const theme = {
    fg,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
    inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
  } as unknown as Theme;
  return { fg, theme };
}

function createCallbacks(): McpPanelCallbacks {
  return {
    reconnect: async () => true,
    canAuthenticate: () => true,
    authenticate: async () => ({ ok: true }),
    getConnectionStatus: () => "idle",
    refreshCacheAfterReconnect: () => null,
  };
}

function createPanelThemeFixture() {
  const config: McpConfig = {
    mcpServers: {
      github: { command: "node", args: ["server.js"], directTools: ["search"] },
    },
  };
  const cache: MetadataCache = {
    version: 1,
    servers: {
      github: {
        configHash: computeServerHash(config.mcpServers.github),
        cachedAt: Date.now(),
        tools: [{ name: "search", description: "Search repositories" }],
        resources: [],
      },
    },
  };
  return { config, cache };
}

describe("mcp-panel theme and component rendering", () => {
  it("renders normal MCP rows through the supplied Pi theme", () => {
    const { fg, theme } = createTheme();
    const { config, cache } = createPanelThemeFixture();
    const panel = createMcpPanel(
      config,
      cache,
      new Map(),
      createCallbacks(),
      { requestRender: () => {} },
      () => {},
      { theme },
    );

    const lines = panel.render(80);
    const output = lines.join("\n");

    expect(fg).toHaveBeenCalledWith("border", expect.any(String));
    expect(fg).toHaveBeenCalledWith("accent", expect.stringContaining(" MCP Servers "));
    expect(fg).toHaveBeenCalledWith("success", "●");
    expect(fg).toHaveBeenCalledWith("muted", expect.stringContaining("1/1"));
    expect(output).not.toContain("\x1b[0m");
    expect(Math.max(...lines.map((line) => visibleWidth(line)))).toBeLessThanOrEqual(80);
    panel.dispose();
  });

  it("keeps auth-only rendering themed without changing the public panel behavior", () => {
    const { fg, theme } = createTheme();
    const { config } = createPanelThemeFixture();
    const panel = createMcpPanel(
      config,
      null,
      new Map(),
      { ...createCallbacks(), getConnectionStatus: () => "needs-auth" },
      { requestRender: () => {} },
      () => {},
      { authOnly: true, theme },
    );

    const output = panel.render(80).join("\n");

    expect(output).toContain("MCP OAuth");
    expect(output).toContain("github");
    expect(fg).toHaveBeenCalledWith("accent", expect.stringContaining(" MCP OAuth "));
    expect(fg).toHaveBeenCalledWith("warning", "needs auth");
    expect(output).not.toContain("\x1b[0m");
    panel.dispose();
  });
});
