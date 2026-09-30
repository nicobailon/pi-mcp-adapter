import { describe, expect, it, vi } from "vitest";
import { createMcpPanel } from "../mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks } from "../types.ts";

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function createCache(config: McpConfig): MetadataCache {
  return {
    version: 1,
    servers: {
      github: {
        configHash: computeServerHash(config.mcpServers.github),
        cachedAt: Date.now(),
        tools: [{ name: "search", description: "Search" }],
        resources: [],
      },
    },
  };
}

function createCallbacks(status: "connected" | "idle" | "failed" | "needs-auth" | "disabled" = "needs-auth") {
  let currentStatus = status;
  const callbacks: McpPanelCallbacks = {
    reconnect: vi.fn(async () => {
      currentStatus = "connected";
      return true;
    }),
    canAuthenticate: (serverName) => serverName === "github",
    authenticate: vi.fn(async () => {
      currentStatus = "idle";
      return { ok: true };
    }),
    getConnectionStatus: () => currentStatus,
    refreshCacheAfterReconnect: () => null,
  };
  return callbacks;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("mcp-panel auth actions", () => {
  it("authenticates a needs-auth server when pressing enter", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    const tui = { requestRender: vi.fn() };
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, tui, () => {});

    panel.handleInput("\r");
    await Promise.resolve();

    expect(callbacks.authenticate).toHaveBeenCalledWith("github");
    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("OAuth finished for github");
    panel.dispose();
  });

  it("authenticates OAuth-capable idle servers with ctrl+a", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("idle");
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\x01");
    await Promise.resolve();

    expect(callbacks.authenticate).toHaveBeenCalledWith("github");
    panel.dispose();
  });

  it("ignores the auth shortcut for a disabled server", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth", disabled: true },
      },
    };
    const callbacks = createCallbacks("disabled");
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\x01");
    await Promise.resolve();

    expect(callbacks.authenticate).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("automatically reconnects after successful OAuth", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks.authenticate).toHaveBeenCalledWith("github");
    expect(callbacks.reconnect).toHaveBeenCalledWith("github");
    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("OAuth finished for github. Reconnected.");
    expect(output).toContain("connected");
    panel.dispose();
  });

  it("shows a retry notice when OAuth succeeds but reconnect does not", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.reconnect = vi.fn(async () => false);
    callbacks.getConnectionStatus = () => "needs-auth";
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks.authenticate).toHaveBeenCalledWith("github");
    expect(callbacks.reconnect).toHaveBeenCalledWith("github");
    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("OAuth finished for github, but reconnect did not complete. Press ctrl+r to retry.");
    panel.dispose();
  });

  it("uses the reconnect callback for ctrl+r", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("idle");
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\x12");
    await Promise.resolve();

    expect(callbacks.reconnect).toHaveBeenCalledWith("github");
    expect(callbacks.authenticate).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("shows concrete auth failure messages in the panel", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.authenticate = vi.fn(async () => ({ ok: false, message: "browser launch failed" }));
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    await Promise.resolve();

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("OAuth failed for github: browser launch failed");
    expect(callbacks.reconnect).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("sanitizes OSC sequences in auth notice server names and messages", async () => {
    const serverName = "git\x9d8;;https://example.invalid/server\x1b\\hub\x9d8;;\x1b\\";
    const config: McpConfig = {
      mcpServers: {
        [serverName]: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.canAuthenticate = () => true;
    callbacks.authenticate = vi.fn(async () => ({
      ok: false,
      message: "browser \x9d8;;https://example.invalid/error\x1b\\launch\x9d8;;\x1b\\ failed",
    }));
    callbacks.getConnectionStatus = () => "needs-auth";
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    await Promise.resolve();

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("OAuth failed for github: browser launch failed");
    expect(output).not.toContain("\x1b]");
    expect(output).not.toContain("\x9d");
    expect(output).not.toContain("https://example.invalid/server");
    expect(output).not.toContain("https://example.invalid/error");
    panel.dispose();
  });

  it("does not start duplicate auth while auth is already in flight", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    const auth = deferred<{ ok: boolean }>();
    callbacks.authenticate = vi.fn(() => auth.promise);
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\r");
    panel.handleInput("\r");
    panel.handleInput("\x01");

    expect(callbacks.authenticate).toHaveBeenCalledTimes(1);
    auth.resolve({ ok: true });
    await Promise.resolve();
    panel.dispose();
  });

  it("filters the auth picker to OAuth-capable servers", () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
        local: { command: "node", args: ["server.js"] },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {}, {
      authOnly: true,
      noticeLines: ["Select an OAuth MCP server"],
    });

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("MCP OAuth");
    expect(output).toContain("github");
    expect(output).not.toContain("local");
    panel.dispose();
  });

  it("treats Space as a no-op in auth-only mode", () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {}, {
      authOnly: true,
    });

    panel.handleInput(" ");

    expect(callbacks.authenticate).not.toHaveBeenCalled();
    panel.dispose();
  });

  it("searches server rows directly in auth-only mode", () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
        gitlab: { url: "https://gitlab.example.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.canAuthenticate = () => true;
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {}, {
      authOnly: true,
    });

    panel.handleInput("l");
    panel.handleInput("a");
    panel.handleInput("b");

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).toContain("gitlab");
    expect(output).not.toContain("github");
    panel.dispose();
  });

  it("ignores description-search shortcut in auth-only mode", () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
        gitlab: { url: "https://gitlab.example.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.canAuthenticate = () => true;
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {}, {
      authOnly: true,
    });

    panel.handleInput("?");
    panel.handleInput("l");
    panel.handleInput("a");
    panel.handleInput("b");

    const output = stripAnsi(panel.render(100).join("\n"));
    expect(output).not.toContain("desc:");
    expect(output).toContain("gitlab");
    expect(output).not.toContain("github");
    panel.dispose();
  });

  it("imports sign-ins from Pi with ctrl+p and reconnects the imported servers", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.importPiSignIns = vi.fn(() => ({ imported: ["github"], failed: [] }));
    const panel = createMcpPanel(config, createCache(config), new Map(), callbacks, { requestRender: () => {} }, () => {});
    expect(stripAnsi(panel.render(160).join("\n"))).toContain("ctrl+p import sign-ins from Pi");

    panel.handleInput("\x10");
    await Promise.resolve();

    expect(callbacks.importPiSignIns).toHaveBeenCalledTimes(1);
    expect(callbacks.reconnect).toHaveBeenCalledWith("github");
    const output = stripAnsi(panel.render(160).join("\n"));
    expect(output).toContain("Imported sign-ins from Pi for github");
    expect(output).not.toContain("ctrl+p import sign-ins from Pi");
    panel.dispose();
  });

  it("reconnects the servers that imported and keeps the action when another import fails", async () => {
    const config: McpConfig = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp", auth: "oauth" },
        gitlab: { url: "https://gitlab.example.com/mcp", auth: "oauth" },
      },
    };
    const callbacks = createCallbacks("needs-auth");
    callbacks.importPiSignIns = vi.fn(() => ({ imported: ["github"], failed: [{ server: "gitlab", error: "store unavailable" }] }));
    const panel = createMcpPanel(config, null, new Map(), callbacks, { requestRender: () => {} }, () => {});

    panel.handleInput("\x10");
    await Promise.resolve();

    expect(callbacks.reconnect).toHaveBeenCalledTimes(1);
    expect(callbacks.reconnect).toHaveBeenCalledWith("github");
    const output = stripAnsi(panel.render(200).join("\n"));
    expect(output).toContain("Imported sign-ins from Pi for github");
    expect(output).toContain("Failed to import the sign-in from Pi for gitlab: store unavailable");
    expect(output).toContain("ctrl+p import sign-ins from Pi");
    panel.dispose();
  });
});
