import { describe, expect, it } from "vitest";
import { createMcpPanel } from "../mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import type { McpConfig } from "../types.ts";

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("mcp-panel include/exclude tools", () => {
  it("hides excluded tools from the panel view", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          excludeTools: ["figma_get_screenshot", "read_figjam"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [
            { name: "figjam", uri: "ui://figjam", description: "FigJam" },
          ],
        },
      },
    };

    const panel = createMcpPanel(
      config,
      cache,
      new Map(),
      {
        reconnect: async () => true,
        canAuthenticate: () => false,
        authenticate: async () => ({ ok: false }),
        getConnectionStatus: () => "idle",
        refreshCacheAfterReconnect: () => null,
      },
      { requestRender: () => {} },
      () => {},
    );

    panel.handleInput("g");
    panel.handleInput("e");
    panel.handleInput("t");
    panel.handleInput("_");

    const output = stripAnsi(panel.render(120).join("\n"));

    expect(output).toContain("get_nodes");
    expect(output).not.toContain("get_screenshot");
    expect(output).not.toContain("read_figjam");

    panel.dispose();
  });

  it("keeps tools whose legacy exclusion collides with another current server tool", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        "my-server": { command: "hyphen", excludeTools: ["my_2d_server_do_thing"] },
        my_2d_server: { command: "escaped" },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: Object.fromEntries(Object.entries(config.mcpServers).map(([name, definition]) => [name, {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools: [{ name: "do_thing", description: name }],
        resources: [],
      }])),
    };
    const panel = createMcpPanel(
      config, cache, new Map(),
      { reconnect: async () => true, canAuthenticate: () => false, authenticate: async () => ({ ok: false }), getConnectionStatus: () => "idle", refreshCacheAfterReconnect: () => cache.servers["my-server"]! },
      { requestRender: () => {} }, () => {},
    );

    panel.handleInput("d");
    panel.handleInput("o");
    const output = stripAnsi(panel.render(120).join("\n"));
    expect(output).toContain("my-server");
    expect(output).toContain("my_2d_server");
    expect((output.match(/do_thing/g) ?? []).length).toBe(2);
    panel.handleInput("ctrl+r");
    const refreshed = stripAnsi(panel.render(120).join("\n"));
    expect((refreshed.match(/do_thing/g) ?? []).length).toBe(2);
    panel.dispose();
  });

  it("does not show cached app-only tools after initial load or reconnect", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: { demo: { command: "demo" } },
    };
    const entry = {
      configHash: computeServerHash(config.mcpServers.demo),
      cachedAt: Date.now(),
      tools: [{ name: "app_only", description: "App", uiVisibility: ["app"] }],
      resources: [],
    };
    const cache: MetadataCache = { version: 1, servers: { demo: entry } };
    const panel = createMcpPanel(
      config, cache, new Map(),
      { reconnect: async () => true, canAuthenticate: () => false, authenticate: async () => ({ ok: false }), getConnectionStatus: () => "idle", refreshCacheAfterReconnect: () => entry },
      { requestRender: () => {} }, () => {},
    );

    expect(stripAnsi(panel.render(120).join("\n"))).not.toContain("app_only");
    panel.handleInput("ctrl+r");
    expect(stripAnsi(panel.render(120).join("\n"))).not.toContain("app_only");
    panel.dispose();
  });

  it("ignores invalid cache entries for panel display and collision context", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        "my-server": { command: "current", excludeTools: ["my_server_do_thing"] },
        my_server: { command: "other" },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        "my-server": {
          configHash: computeServerHash(config.mcpServers["my-server"]),
          cachedAt: Date.now(),
          tools: [{ name: "do_thing", description: "Current" }],
          resources: [],
        },
        my_server: {
          configHash: "stale",
          cachedAt: Date.now(),
          tools: [{ name: "do_thing", description: "Stale" }],
          resources: [],
        },
      },
    };
    const panel = createMcpPanel(
      config, cache, new Map(),
      { reconnect: async () => true, canAuthenticate: () => false, authenticate: async () => ({ ok: false }), getConnectionStatus: () => "idle", refreshCacheAfterReconnect: () => null },
      { requestRender: () => {} }, () => {},
    );

    const output = stripAnsi(panel.render(120).join("\n"));
    expect(output).toContain("my-server");
    expect(output).toContain("my_server  (not cached)");
    expect(output).not.toContain("my-server  0/1");
    expect(output).not.toContain("do_thing");
    panel.dispose();
  });

  it("hides non-included tools from the panel view", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          includeTools: ["get_node*"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
        },
      },
    };

    const panel = createMcpPanel(
      config,
      cache,
      new Map(),
      {
        reconnect: async () => true,
        canAuthenticate: () => false,
        authenticate: async () => ({ ok: false }),
        getConnectionStatus: () => "idle",
        refreshCacheAfterReconnect: () => null,
      },
      { requestRender: () => {} },
      () => {},
    );

    panel.handleInput("g");
    panel.handleInput("e");
    panel.handleInput("t");
    panel.handleInput("_");

    const output = stripAnsi(panel.render(120).join("\n"));

    expect(output).toContain("get_nodes");
    expect(output).not.toContain("get_screenshot");
    expect(output).not.toContain("read_figjam");

    panel.dispose();
  });
});
