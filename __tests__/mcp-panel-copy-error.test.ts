import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(async (_text: string) => undefined),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("mcp-panel ctrl+y copy error", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("copies the failure message to the clipboard when the failed server is under the cursor", async () => {
    const { createMcpPanel } = await import("../mcp-panel.ts");
    const { computeServerHash } = await import("../metadata-cache.ts");

    const config = { mcpServers: { atlassian: { command: "npx", args: ["-y", "atlassian-mcp"] } } };
    const cache = {
      version: 1 as const,
      servers: {
        atlassian: {
          configHash: computeServerHash(config.mcpServers.atlassian),
          cachedAt: Date.now(),
          tools: [],
          resources: [],
        },
      },
    };

    const reason = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.";
    const requestRender = vi.fn();
    const panel = createMcpPanel(
      config as any,
      cache as any,
      new Map(),
      {
        reconnect: async () => true,
        canAuthenticate: () => false,
        authenticate: async () => ({ ok: false }),
        getConnectionStatus: () => "failed",
        getFailureMessage: () => reason,
        refreshCacheAfterReconnect: () => null,
      },
      { requestRender },
      () => {},
    );

    panel.handleInput("\x19"); // ctrl+y
    await flush();

    expect(mocks.copyToClipboard).toHaveBeenCalledWith(reason);
    const output = stripAnsi(panel.render(60).join("\n"));
    expect(output).toContain("Copied error");
    panel.dispose();
  });

  it("does nothing when the selected server has no failure message", async () => {
    const { createMcpPanel } = await import("../mcp-panel.ts");
    const { computeServerHash } = await import("../metadata-cache.ts");

    const config = { mcpServers: { atlassian: { command: "npx", args: ["-y", "atlassian-mcp"] } } };
    const cache = {
      version: 1 as const,
      servers: {
        atlassian: {
          configHash: computeServerHash(config.mcpServers.atlassian),
          cachedAt: Date.now(),
          tools: [],
          resources: [],
        },
      },
    };

    const panel = createMcpPanel(
      config as any,
      cache as any,
      new Map(),
      {
        reconnect: async () => true,
        canAuthenticate: () => false,
        authenticate: async () => ({ ok: false }),
        getConnectionStatus: () => "idle",
        getFailureMessage: () => null,
        refreshCacheAfterReconnect: () => null,
      },
      { requestRender: () => {} },
      () => {},
    );

    panel.handleInput("\x19"); // ctrl+y
    await flush();

    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    panel.dispose();
  });
});
