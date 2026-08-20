import { describe, expect, it, vi } from "vitest";
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

function createConfig(): McpConfig {
  return {
    mcpServers: {
      atlassian: { command: "npx", args: ["-y", "atlassian-mcp"] },
    },
  };
}

function createFailedPanel(
  connectionStatus: "failed" | "idle",
  failureMessage: string | null,
  width: number,
): string {
  const config = createConfig();
  const callbacks: McpPanelCallbacks = {
    ...createCallbacks(),
    getConnectionStatus: () => connectionStatus,
    getFailureMessage: () => failureMessage,
  };
  const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});
  const output = stripAnsi(panel.render(width).join("\n"));
  panel.dispose();
  return output;
}

function createCache(config: McpConfig): MetadataCache {
  return {
    version: 1,
    servers: {
      atlassian: {
        configHash: computeServerHash(config.mcpServers.atlassian),
        cachedAt: Date.now(),
        tools: [
          {
            name: "search\u0007issues",
            description: "Search\r\n\x1b[31m\x9d8;;https://example.invalid/issues\x1b\\issues\x9d8;;\x1b\\\x1b[0m\tby query\u0000now",
          },
          { name: "list_projects", description: "List projects" },
        ],
        resources: [],
      },
    },
  };
}

describe("mcp-panel rendering", () => {
  it("renders MCP metadata as single-line display text", () => {
    const config = createConfig();
    const panel = createMcpPanel(
      config,
      createCache(config),
      new Map(),
      createCallbacks(),
      { requestRender: () => {} },
      () => {},
    );

    panel.handleInput("\r");

    const lines = panel.render(120);
    const output = stripAnsi(lines.join("\n"));

    expect(output).toContain("search issues");
    expect(output).toContain("Search issues by query now");
    expect(lines.some((line) => /[\r\n\u0000-\u001f\u007f-\u009f]/.test(stripAnsi(line)))).toBe(false);
    expect(output).not.toContain("[31m");
    expect(output).not.toContain("\x1b]");
    expect(output).not.toContain("\x9d");
    expect(output).not.toContain("https://example.invalid/issues");
    panel.dispose();
  });

  it("sanitizes OSC sequences in notice lines before styling", () => {
    const config = createConfig();
    const panel = createMcpPanel(
      config,
      createCache(config),
      new Map(),
      createCallbacks(),
      { requestRender: () => {} },
      () => {},
      { noticeLines: ["Open \x1b]8;;https://example.invalid/notice\x07docs\x1b]8;;\x07 now"] },
    );

    const output = stripAnsi(panel.render(120).join("\n"));

    expect(output).toContain("Open docs now");
    expect(output).not.toContain("\x1b]");
    expect(output).not.toContain("https://example.invalid/notice");
    panel.dispose();
  });

  it("strips an unterminated OSC payload from notices", () => {
    const config = createConfig();
    const panel = createMcpPanel(
      config,
      createCache(config),
      new Map(),
      createCallbacks(),
      { requestRender: () => {} },
      () => {},
      { noticeLines: ["Open \x1b]8;;https://secret.invalid/truncated"] },
    );

    const output = stripAnsi(panel.render(120).join("\n"));

    expect(output).toContain("Open");
    expect(output).not.toContain("https://secret.invalid/truncated");
    panel.dispose();
  });

  it("renders the selected failure reason wrapped without truncating useful context", () => {
    const reason = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is it running?";
    const output = createFailedPanel("failed", reason, 60);

    expect(output).toContain("failed");
    for (const word of reason.split(/\s+/)) expect(output).toContain(word);
    expect(output.split("\n").filter((line) => /docker/i.test(line)).length).toBeGreaterThan(1);
    expect(output).not.toContain("…");
  });

  it("does not render a failure reason when the server is not failed", () => {
    expect(createFailedPanel("idle", "should not appear", 60)).not.toContain("should not appear");
  });

  it("updates direct counts and token totals after each toggle", () => {
    const config: McpConfig = {
      mcpServers: {
        example: { command: "mock", directTools: ["alpha"] },
      },
    };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        example: {
          configHash: computeServerHash(config.mcpServers.example),
          cachedAt: Date.now(),
          tools: [{ name: "alpha" }, { name: "beta" }],
          resources: [],
        },
      },
    };
    const panel = createMcpPanel(config, cache, new Map(), createCallbacks(), { requestRender: () => {} }, () => {});

    expect(stripAnsi(panel.render(100).join("\n"))).toContain("1 direct  ~12 tokens");
    panel.handleInput("\r");
    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    expect(stripAnsi(panel.render(100).join("\n"))).toContain("no direct tools");

    panel.handleInput("\x1b[B");
    panel.handleInput(" ");
    expect(stripAnsi(panel.render(100).join("\n"))).toContain("1 direct  ~12 tokens");

    panel.handleInput("\x1b[A");
    panel.handleInput("\x1b[A");
    panel.handleInput(" ");
    const allDirect = stripAnsi(panel.render(100).join("\n"));
    expect(allDirect).toContain("2/2  ~24");
    expect(allDirect).toContain("2 direct  ~24 tokens");
    panel.dispose();
  });

  it("rebuilds derived totals before requesting a render after reconnect", async () => {
    const config: McpConfig = {
      mcpServers: {
        example: { command: "mock", directTools: ["alpha"] },
      },
    };
    const initialCache: MetadataCache = {
      version: 1,
      servers: {
        example: {
          configHash: computeServerHash(config.mcpServers.example),
          cachedAt: Date.now(),
          tools: [{ name: "alpha" }],
          resources: [],
        },
      },
    };
    let status: "idle" | "connected" = "idle";
    const callbacks: McpPanelCallbacks = {
      ...createCallbacks(),
      reconnect: async () => {
        status = "connected";
        return true;
      },
      getConnectionStatus: () => status,
      refreshCacheAfterReconnect: () => ({
        configHash: computeServerHash(config.mcpServers.example),
        cachedAt: Date.now(),
        tools: [{ name: "alpha", description: "Expanded alpha description" }, { name: "beta" }],
        resources: [],
      }),
    };
    const snapshots: string[] = [];
    let panel!: ReturnType<typeof createMcpPanel>;
    panel = createMcpPanel(config, initialCache, new Map(), callbacks, {
      requestRender: () => snapshots.push(stripAnsi(panel.render(100).join("\n"))),
    }, () => {});

    panel.handleInput("\x12");
    await Promise.resolve();

    expect(snapshots.at(-1)).toContain("1/2  ~19");
    expect(snapshots.at(-1)).toContain("1 direct  ~19 tokens");
    panel.dispose();
  });

  it("keeps dirty changes and closes when Keep & Close is confirmed", () => {
    const config = createConfig();
    const done = vi.fn<(result: McpPanelResult) => void>();
    const panel = createMcpPanel(
      config,
      createCache(config),
      new Map(),
      createCallbacks(),
      { requestRender: () => {} },
      done,
    );

    panel.handleInput("\r");
    panel.handleInput("\x1b[B");
    panel.handleInput("\r");
    panel.handleInput("\x1b");

    expect(stripAnsi(panel.render(120).join("\n"))).toContain("Keep & Close");

    panel.handleInput("\r");

    expect(done).toHaveBeenCalledTimes(1);
    const result = done.mock.calls[0][0];
    expect(result.cancelled).toBe(false);
    expect(result.changes.get("atlassian")).toEqual(["search\u0007issues"]);
    panel.dispose();
  });
});
