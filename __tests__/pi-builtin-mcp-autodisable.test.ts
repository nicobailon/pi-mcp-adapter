import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadOnboardingState } from "../onboarding-state.ts";

const VERSION = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")).version as string;

describe("turning off Pi's built-in MCP", () => {
  let root: string;
  let agentDir: string;
  let settingsPath: string;
  let stops: Array<() => unknown>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-builtin-mcp-")));
    agentDir = join(root, "agent");
    settingsPath = join(agentDir, "settings.json");
    mkdirSync(join(root, "project"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.resetModules();
    stops = [];
  });

  afterEach(async () => {
    for (const stop of stops) await stop();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const writeSettings = (settings: object) => writeFileSync(settingsPath, JSON.stringify(settings));
  const readSettings = () => JSON.parse(readFileSync(settingsPath, "utf-8"));
  const handledVersion = () => loadOnboardingState().piBuiltinMcpHandledVersion;

  async function startSession(options: { config?: object; piMcp?: boolean } = {}) {
    const { createMcpAdapter } = await import("../index.ts");
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const notify = vi.fn();
    createMcpAdapter(options.config ? { config: options.config as any } : {})({
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
      getMcpServers: () => [],
      ...(options.piMcp === false ? {} : { registerMcpServer: vi.fn() }),
    } as any);
    const ctx = { hasUI: true, cwd: join(root, "project"), ui: { notify, setStatus: vi.fn(), select: vi.fn() } };
    await handlers.get("session_start")?.({}, ctx);
    stops.push(() => handlers.get("session_shutdown")?.({}, ctx));
    return notify;
  }

  it("adds -builtin:mcp once per version, keeping other settings", async () => {
    writeSettings({ theme: "dark", extensions: ["./mine.ts"] });

    const notify = await startSession();

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("Turned off Pi's built-in MCP"), "info"));
    expect(readSettings()).toEqual({ theme: "dark", extensions: ["./mine.ts", "-builtin:mcp"] });
    expect(handledVersion()).toBe(VERSION);

    writeSettings({ theme: "dark" });
    await startSession();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readSettings()).toEqual({ theme: "dark" });
  }, 20_000);

  it("writes again after an update", async () => {
    writeFileSync(join(agentDir, "mcp-onboarding.json"), JSON.stringify({ version: 1, piBuiltinMcpHandledVersion: "0.0.1" }));

    await startSession();

    await vi.waitFor(() => expect(handledVersion()).toBe(VERSION));
    expect(readSettings()).toEqual({ extensions: ["-builtin:mcp"] });
  }, 20_000);

  it("leaves a +builtin:mcp entry alone", async () => {
    writeSettings({ extensions: ["+builtin:mcp"] });

    const notify = await startSession();

    await vi.waitFor(() => expect(handledVersion()).toBe(VERSION));
    expect(readSettings()).toEqual({ extensions: ["+builtin:mcp"] });
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("built-in MCP"), expect.anything());
  }, 20_000);

  // Read-only files stay writable for root, so the write cannot fail there.
  it.skipIf(process.getuid?.() === 0)("retries on the next start when Pi's settings can't be written", async () => {
    writeSettings({});
    chmodSync(settingsPath, 0o444);

    const notify = await startSession();

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("could not turn off Pi's built-in MCP"), "warning"));
    expect(readSettings()).toEqual({});
    expect(handledVersion()).toBeUndefined();

    chmodSync(settingsPath, 0o644);
    await startSession();
    await vi.waitFor(() => expect(readSettings()).toEqual({ extensions: ["-builtin:mcp"] }));
  }, 20_000);

  it("does nothing for a host-supplied config or on Pi without MCP support", async () => {
    await startSession({ config: { mcpServers: {} } });
    await startSession({ piMcp: false });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(() => readFileSync(settingsPath)).toThrow();
    expect(handledVersion()).toBeUndefined();
  }, 20_000);
});
