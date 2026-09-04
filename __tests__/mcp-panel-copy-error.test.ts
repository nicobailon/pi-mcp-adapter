import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(async (_text: string) => undefined),
  DynamicBorder: class {
    render(width: number): string[] {
      return ["─".repeat(Math.max(1, width))];
    }

    invalidate(): void {}
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  copyToClipboard: mocks.copyToClipboard,
  DynamicBorder: mocks.DynamicBorder,
}));

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("mcp-panel failure copy", () => {
  afterEach(() => vi.clearAllMocks());

  it("copies a sanitized selected failure reason and shows a notice", async () => {
    const { createMcpPanel } = await import("../mcp-panel.ts");
    const { computeServerHash } = await import("../metadata-cache.ts");
    const config = { mcpServers: { demo: { command: "node", args: ["server.js"] } } };
    const cache = {
      version: 1 as const,
      servers: {
        demo: { configHash: computeServerHash(config.mcpServers.demo), cachedAt: Date.now(), tools: [], resources: [] },
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
        getConnectionStatus: () => "failed",
        getFailureMessage: () => "connection failed\n\x1b]8;;https://secret.invalid\x07details\x1b]8;;\x07",
        refreshCacheAfterReconnect: () => null,
      },
      { requestRender: () => {} },
      () => {},
    );

    panel.handleInput("\x19");
    await flush();

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("connection failed details");
    const output = stripAnsi(panel.render(80).join("\n"));
    expect(output).toContain("Copied error");
    expect(output).not.toContain("https://secret.invalid");
    panel.dispose();
  });

  it("does nothing when the selected server has no failure reason", async () => {
    const { createMcpPanel } = await import("../mcp-panel.ts");
    const config = { mcpServers: { demo: { command: "node" } } };
    const panel = createMcpPanel(
      config as any,
      null,
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

    panel.handleInput("\x19");
    await flush();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    panel.dispose();
  });
});
