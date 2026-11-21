import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("MCP SDK warnings in the TUI", () => {
  let root: string;
  let agentDir: string;
  const originalWarn = console.warn;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-sdk-warnings-")));
    agentDir = join(root, "agent");
    mkdirSync(join(root, "project"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.resetModules();
  });

  afterEach(() => {
    console.warn = originalWarn;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-mcp-adapter.sdkWarnings")];
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function loadSession(mode: string) {
    const { createMcpAdapter } = await import("../index.ts");
    const handlers = new Map<string, (...args: any[]) => unknown>();
    createMcpAdapter({ config: { mcpServers: {} } })({
      registerTool: vi.fn(),
      unregisterTool: vi.fn(() => true),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      getFlag: () => undefined,
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools: vi.fn(),
    } as any);
    const ctx = { hasUI: true, mode, cwd: join(root, "project"), ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn() } };
    return {
      start: () => handlers.get("session_start")?.({}, ctx),
      stop: () => handlers.get("session_shutdown")?.({}, ctx),
    };
  }

  const sdkLine = '[mcp-sdk] OAuth "invalid_grant" — invalidating the stored tokens and retrying authorization. Cause: "invalid_grant"';
  const logPath = () => join(agentDir, "mcp.log");

  it("writes SDK warnings to mcp.log instead of the terminal and passes other warnings through", async () => {
    const terminal = vi.fn();
    console.warn = terminal;
    const session = await loadSession("tui");
    await session.start();
    await session.start();

    console.warn(sdkLine);
    console.warn("MCP: something else", 42);

    expect(terminal.mock.calls).toEqual([["MCP: something else", 42]]);
    const lines = readFileSync(logPath(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\S+ \[mcp-sdk\] warning OAuth "invalid_grant" — invalidating the stored tokens/);

    await session.stop();
    expect(console.warn).toBe(terminal);
  }, 20_000);

  it("keeps routing until the last TUI session that asked for it shuts down", async () => {
    const terminal = vi.fn();
    console.warn = terminal;
    const first = await loadSession("tui");
    const second = await loadSession("tui");
    const headless = await loadSession("rpc");
    await first.start();
    await second.start();
    await headless.start();

    await headless.stop();
    await first.stop();
    await first.stop();
    console.warn(sdkLine);
    expect(terminal).not.toHaveBeenCalled();
    expect(readFileSync(logPath(), "utf-8")).toContain("[mcp-sdk] warning OAuth");

    await second.stop();
    expect(console.warn).toBe(terminal);
  }, 20_000);

  it("leaves SDK warnings on the terminal outside the TUI", async () => {
    const terminal = vi.fn();
    console.warn = terminal;
    const session = await loadSession("rpc");
    await session.start();

    console.warn(sdkLine);

    expect(terminal).toHaveBeenCalledWith(sdkLine);
    expect(existsSync(logPath())).toBe(false);
    await session.stop();
  }, 20_000);
});
