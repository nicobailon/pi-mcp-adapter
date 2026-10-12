import { registerMcpProtocol } from "../runtime-protocol.ts";
const testProtocols = new WeakMap<object, ReturnType<typeof registerMcpProtocol>>();
const testProtocolSession = (pi: any, name: string) => {
  let protocol = testProtocols.get(pi);
  if (!protocol) {
    protocol = registerMcpProtocol(pi, { namespace: "demo", requests: ["demo/list"], streams: ["demo/stream"], notifications: ["notifications/demo/event"] });
    testProtocols.set(pi, protocol);
  }
  return protocol.connect(name);
};
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const connect = vi.hoisted(() => vi.fn(async (name: string) => {
  throw new Error(`${name} offline`);
}));

const makeManager = vi.hoisted(() => function (this: any) {
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
});
vi.mock("../server-manager.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server-manager.ts")>(),
  McpServerManager: vi.fn().mockImplementation(makeManager),
}));

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let activeTools: string[] = [];
  const listeners = new Map<string, (data: unknown) => void>();
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
      events: { on: (name: string, fn: (data: unknown) => void) => listeners.set(name, fn), emit: (name: string, data: unknown) => listeners.get(name)?.(data) },
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

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-load-time-trust-")));
    const home = join(root, "home");
    cwd = join(root, "project");
    vi.resetModules();
    vi.mocked((await import("../server-manager.ts")).McpServerManager).mockImplementation(makeManager);
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
      mode: "tui",
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

  it.each([false, true])("protocol extensions do not bypass project approval (trusted=%s)", async trusted => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: mcpAdapter } = await import("../index.ts");
    const pi = createPi();
    mcpAdapter(pi.api);
    await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
      cwd, hasUI: false, mode: "rpc", isProjectTrusted: () => trusted, modelRegistry: {},
    });
    await expect(testProtocolSession(pi.api, "equibles")).rejects.toThrow("not configured or enabled");
    expect(connect.mock.calls.map(call => call[0])).not.toContain("equibles");
    await pi.handlers.get("session_shutdown")?.({ type: "session_shutdown" });
  });

});
