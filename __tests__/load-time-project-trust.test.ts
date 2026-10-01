import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const connect = vi.hoisted(() => vi.fn(async (name: string) => {
  throw new Error(`${name} offline`);
}));

vi.mock("../server-manager.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server-manager.ts")>(),
  McpServerManager: vi.fn().mockImplementation(function (this: any) {
    this.setDefaultRequestTimeoutMs = vi.fn();
    this.setAuthStorageOptions = vi.fn();
    this.setSamplingConfig = vi.fn();
    this.setElicitationConfig = vi.fn();
    this.getConnection = vi.fn();
    this.getAllConnections = vi.fn(() => new Map());
    this.isConnecting = vi.fn(() => false);
    this.connect = connect;
    this.close = vi.fn(async () => {});
    this.closeAll = vi.fn(async () => {});
  }),
}));

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools: string[] = [];
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      unregisterTool: vi.fn(() => true),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      events: { on: vi.fn(), emit: vi.fn() },
      getAllTools: vi.fn(() => []),
      getCommands: vi.fn(() => []),
      getActiveTools: vi.fn(() => activeTools),
      setActiveTools: vi.fn((next: string[]) => {
        activeTools = next;
      }),
    } as any,
  };
}

describe("load-time initialization with project server overrides", () => {
  let root: string;
  let cwd: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-load-time-trust-")));
    const home = join(root, "home");
    cwd = join(root, "project");
    vi.resetModules();
    connect.mockClear();
    vi.stubEnv("HOME", home);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
    vi.stubEnv("MCP_DIRECT_TOOLS", undefined);
    // Issue #713: global servers, one of them starting at load, and a project file that only enables one.
    writeJson(join(home, ".pi", "agent", "mcp-adapter.json"), { mcpServers: {
      equibles: { command: "equibles-server", lifecycle: "keep-alive", disabled: true },
      always: { command: "always-server", lifecycle: "keep-alive" },
    } });
    writeJson(join(cwd, ".pi", "mcp-adapter.json"), { mcpServers: { equibles: { disabled: false } } });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not report trusted-project servers as blocked by project trust before session_start", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: mcpAdapter } = await import("../index.ts");
    const pi = createPi();
    mcpAdapter(pi.api);

    // The load-time runtime starts the global keep-alive server without a Pi context.
    const connected = () => connect.mock.calls.map(call => call[0]);
    await vi.waitFor(() => expect(connected()).toContain("always"));
    const warnings = () => warn.mock.calls.map(call => String(call[0]));
    expect(warnings().filter(message => message.includes("Project servers blocked"))).toEqual([]);
    expect(connected()).not.toContain("equibles");

    // session_start still gates the project-enabled server, and connects it once approved.
    const select = vi.fn(async () => "Allow");
    await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
      cwd,
      hasUI: true,
      mode: "rpc",
      isProjectTrusted: () => true,
      ui: { select, notify: vi.fn(), setStatus: vi.fn(), theme: undefined },
      modelRegistry: {},
      signal: undefined,
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0]).toContain("equibles");
    expect(warnings().filter(message => message.includes("blocked by project trust"))).toEqual([]);
    await vi.waitFor(() => expect(connected()).toContain("equibles"));

    await pi.handlers.get("session_shutdown")?.({ type: "session_shutdown" });
  });
});
