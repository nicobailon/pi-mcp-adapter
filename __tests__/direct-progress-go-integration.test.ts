import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { McpServerManager, type ServerConnection } from "../server-manager.ts";

const hubRoot = process.env.PI_MCP_ADAPTER_A6_HUB_ROOT;
const integration = hubRoot ? describe : describe.skip;
const fixtureTimeoutMs = 60_000;

type FixtureReady = {
  mcpUrl: string;
  controlUrl: string;
  identityHeader: string;
  sources: string[];
  container: string;
  maxLifetimeMs: number;
};

type FixtureState = {
  sources: Record<string, {
    opened: number;
    sourceClosed: boolean;
    handlerStarted: number;
    handlerExited: number;
  }>;
};

type RunningFixture = {
  ready: FixtureReady;
  process: ChildProcess;
  tempDir: string;
  managers: McpServerManager[];
  output: () => string;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, message: string, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await sleep(20);
    value = await read();
  }
  if (!accept(value)) throw new Error(`${message}: ${JSON.stringify(value)}`);
  return value;
}

async function startFixture(): Promise<RunningFixture> {
  const apiCwd = path.join(hubRoot!, "api");
  const tempDir = await mkdtemp(path.join(tmpdir(), "pi-a6-go-fixture-"));
  const readyPath = path.join(tempDir, "ready.json");
  const child = spawn("go", [
    "test", "./internal/mcp", "-run", "^TestA6CrossClientFixture$", "-count=1", "-v",
    "-args", `-a6-fixture-ready=${readyPath}`, "-a6-fixture-lifetime=60s",
  ], { cwd: apiCwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", chunk => { output += chunk; });
  child.stderr?.on("data", chunk => { output += chunk; });

  try {
    const ready = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(readyPath, "utf8")) as FixtureReady;
      } catch {
        if (child.exitCode !== null) throw new Error(`Go fixture exited ${child.exitCode}:\n${output}`);
        return null;
      }
    }, (value): value is FixtureReady => value !== null, "Go fixture did not become ready", 30_000);
    return { ready, process: child, tempDir, managers: [], output: () => output };
  } catch (error) {
    child.kill("SIGKILL");
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function stopFixture(fixture: RunningFixture): Promise<void> {
  await fetch(`${fixture.ready.controlUrl}/stop`, { method: "POST" }).catch(() => {});
  await Promise.all(fixture.managers.map(manager => manager.close().catch(() => {})));
  const exit = fixture.process.exitCode ?? await Promise.race([
    new Promise<number | null>(resolve => fixture.process.once("exit", resolve)),
    sleep(5_000).then(() => null),
  ]);
  if (fixture.process.exitCode === null) fixture.process.kill("SIGKILL");
  await rm(fixture.tempDir, { recursive: true, force: true });
  if (exit !== 0) throw new Error(`Go fixture exited ${exit}:\n${fixture.output()}`);
}

async function postControl(fixture: RunningFixture, route: string, body?: string): Promise<void> {
  const response = await fetch(`${fixture.ready.controlUrl}${route}`, { method: "POST", body });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
}

async function getState(fixture: RunningFixture): Promise<FixtureState> {
  const response = await fetch(`${fixture.ready.controlUrl}/state`);
  if (!response.ok) throw new Error(`state: ${response.status} ${await response.text()}`);
  return response.json() as Promise<FixtureState>;
}

async function createExecutor(fixture: RunningFixture, identity: string) {
  const manager = new McpServerManager();
  fixture.managers.push(manager);
  const definition = {
    url: fixture.ready.mcpUrl,
    headers: { [fixture.ready.identityHeader]: identity },
    auth: false as const,
    httpTransport: "streamable-http" as const,
    requestTimeoutMs: fixtureTimeoutMs,
  };
  const connection = await manager.connect("hub-fixture", definition);
  const state = {
    config: { settings: { toolPrefix: "server" }, mcpServers: { "hub-fixture": definition } },
    manager,
    toolMetadata: new Map(),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    completedUiSessions: [],
  } as any;
  const execute = createDirectToolExecutor(() => state, () => null, {
    serverName: "hub-fixture",
    originalName: "stream_service_logs",
    prefixedName: "hub-fixture_stream_service_logs",
    description: "Stream synthetic fixture logs",
    inputSchema: { type: "object", properties: {} },
  });
  return { manager, connection, execute };
}

function logArgs(pod: string) {
  return { service: "payments", environment: "development", pod, container: "api" };
}

function updateText(update: unknown): string {
  return ((update as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
    .filter(block => block.type === "text")
    .map(block => block.text ?? "")
    .join("\n");
}

function resultText(result: unknown): string {
  return updateText(result);
}

async function withFixture(run: (fixture: RunningFixture) => Promise<void>): Promise<void> {
  const fixture = await startFixture();
  try {
    await run(fixture);
  } finally {
    await stopFixture(fixture);
  }
}

integration("Pi direct executor against the real Go live-log handler", () => {
  it("delivers two Go progress chunks through onUpdate before EOF and settlement", async () => {
    await withFixture(async fixture => {
      const { execute } = await createExecutor(fixture, "pi-precompletion");
      const updates: unknown[] = [];
      let settled = false;
      const call = execute("pi-go-progress", logArgs("payments-a"), undefined, update => updates.push(update), {} as any)
        .finally(() => { settled = true; });
      await waitFor(() => getState(fixture), state => state.sources["payments-a"]?.opened === 1, "source did not open");

      await postControl(fixture, "/sources/payments-a/append", "first synthetic line\n");
      await waitFor(() => updates.length, count => count >= 1, "first update missing");
      expect(settled).toBe(false);
      expect(updateText(updates[0])).toContain("first synthetic line");

      await postControl(fixture, "/sources/payments-a/append", "second synthetic line\n");
      await waitFor(() => updates.length, count => count >= 2, "second update missing");
      expect(settled).toBe(false);
      expect(updateText(updates[1])).toContain("second synthetic line");

      await postControl(fixture, "/sources/payments-a/eof");
      const result = await call;
      expect(resultText(result)).toContain('"terminalReason":"eof"');
      expect(resultText(result)).not.toContain("first synthetic line");
      expect(resultText(result)).not.toContain("second synthetic line");
    });
  }, 70_000);

  it("aborts only A, observes Go cleanup, and keeps B plus the connection usable", async () => {
    await withFixture(async fixture => {
      const { manager, connection, execute } = await createExecutor(fixture, "pi-concurrent");
      const controller = new AbortController();
      const updatesA: unknown[] = [];
      const updatesB: unknown[] = [];
      const callA = execute("pi-go-a", logArgs("payments-a"), controller.signal, update => updatesA.push(update), {} as any);
      const callB = execute("pi-go-b", logArgs("payments-b"), undefined, update => updatesB.push(update), {} as any);
      await waitFor(() => getState(fixture), state =>
        state.sources["payments-a"]?.opened === 1 && state.sources["payments-b"]?.opened === 1,
      "concurrent sources did not open");

      controller.abort(new Error("Pi cancelled A"));
      await expect(callA).resolves.toMatchObject({ details: { error: "aborted" } });

      const resetLine = `${"x".repeat(16 * 1024 - 1)}\n`;
      let closedState: FixtureState | undefined;
      for (let write = 0; write < 64; write++) {
        await postControl(fixture, "/sources/payments-a/append", resetLine).catch(() => {});
        const state = await getState(fixture);
        if (state.sources["payments-a"]?.sourceClosed && state.sources["payments-a"]?.handlerExited === 1) {
          closedState = state;
          break;
        }
      }
      closedState ??= await waitFor(() => getState(fixture), state =>
        state.sources["payments-a"]?.sourceClosed === true && state.sources["payments-a"]?.handlerExited === 1,
      "Go did not observe A socket reset", 2_000);
      expect(closedState.sources["payments-b"]?.sourceClosed).toBe(false);
      expect(closedState.sources["payments-b"]?.handlerExited).toBe(0);
      expect(connection.status).toBe("connected");

      await postControl(fixture, "/sources/payments-b/append", "B stayed active\n");
      await waitFor(() => updatesB.length, count => count >= 1, "B update missing after A abort");
      expect(updateText(updatesB.at(-1))).toContain("B stayed active");

      await postControl(fixture, "/sources/payments-b/eof");
      const resultB = await callB;
      expect(resultText(resultB)).toContain('"terminalReason":"eof"');
      expect(resultText(resultB)).not.toContain("B stayed active");
      expect(updatesA).toHaveLength(0);

      const listed = await connection.client.listTools(undefined, manager.getRequestOptions("hub-fixture"));
      expect(listed.tools.some(tool => tool.name === "stream_service_logs")).toBe(true);
      expect(connection.status).toBe("connected");
    });
  }, 70_000);
});
