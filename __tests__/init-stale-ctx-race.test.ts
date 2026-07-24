import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const mocks = vi.hoisted(() => ({
  loadMcpConfig: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config.ts")>()),
  loadMcpConfig: mocks.loadMcpConfig,
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: vi.fn().mockImplementation(function (this: any) {
    this.setDefaultRequestTimeoutMs = vi.fn();
    this.setAuthStorageOptions = vi.fn();
    this.setSamplingConfig = vi.fn();
    this.setElicitationConfig = vi.fn();
    this.getConnection = vi.fn();
    this.connect = mocks.connect;
  }),
}));

function extensionApi(): ExtensionAPI {
  return { getFlag: vi.fn() } as unknown as ExtensionAPI;
}

// Mirrors pi-coding-agent's real ExtensionContext getters: each one re-checks
// runner.assertActive() on every read, so a session torn down mid-connect makes
// the *next* read throw — not just future ones. `armed` flips true to simulate
// session.dispose() firing while the eager connect below is still in flight.
function contextThatGoesStale(armed: { value: boolean }): ExtensionContext {
  return {
    cwd: "/tmp/project",
    get hasUI() {
      if (armed.value) {
        throw new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload()."
        );
      }
      return true;
    },
    mode: "tui",
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    modelRegistry: {},
    model: undefined,
    signal: undefined,
  } as unknown as ExtensionContext;
}

describe("initializeMcp vs. a ctx invalidated mid-connect", () => {
  it("does not reject once the session is disposed mid-connect — it should abandon quietly", async () => {
    mocks.loadMcpConfig.mockReturnValue({
      mcpServers: {
        demo: { command: "npx", args: ["-y", "demo-server"], lifecycle: "eager" },
      },
      settings: {},
    });

    let resolveConnect!: (value: unknown) => void;
    mocks.connect.mockImplementation(
      () => new Promise((resolve) => { resolveConnect = resolve; })
    );

    const { initializeMcp } = await import("../init.ts");

    const armed = { value: false };
    const ctx = contextThatGoesStale(armed);

    const pending = initializeMcp(extensionApi(), ctx);

    // Let the synchronous prefix (config load, manager construction, the
    // pre-connect ctx.hasUI reads, and the connect() call itself) run first.
    await Promise.resolve();
    await Promise.resolve();

    // Simulate session.dispose() firing while the "eager" server's connect is
    // still in flight — the exact race from the bug report: a fast, no-MCP-tool
    // turn completes (and the harness disposes the session) before an eager
    // server finishes connecting.
    armed.value = true;
    resolveConnect({ status: "connected", tools: [], resources: [] });

    // A session torn down mid-connect is an ordinary, expected race:
    // initializeMcp should abandon quietly instead of rejecting.
    await pending;
  });
});
