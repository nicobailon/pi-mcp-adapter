import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import open from "open";
import { showTools } from "../commands.ts";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { unwrapExecutorCallResult } from "../executor-app-tools.ts";
import { refreshExecutorCatalog } from "../init.ts";
import { computeServerHash, executorAppToolMetadata } from "../metadata-cache.ts";
import { executeCall, executeDescribe } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { ServerCacheEntry, ServerEntry } from "../types.ts";

vi.mock("open", () => ({ default: vi.fn(async () => undefined) }));

const catalogFixture = fileURLToPath(new URL("./fixtures/executor-catalog-server.mjs", import.meta.url));
const accountFixture = fileURLToPath(new URL("./fixtures/executor-server.mjs", import.meta.url));
const managers: McpServerManager[] = [];
const tempDirs: string[] = [];

type Leg = "direct" | "script" | "proxy";
type Result = { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; structuredContent?: unknown; isError?: boolean };

afterEach(async () => {
  vi.mocked(open).mockClear();
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const textOf = (result: Result) => result.content?.map(block => block.text ?? "").join("\n") ?? "";
const appTool = (path: string) => ({ path, canonicalPath: path.replace(/^tools\./, "").replace(/^\["([^"]+)"\]/, "$1"), description: "", inputType: "{ id?: string }" });

// An Executor connected the way the adapter connects it, with the given app tools in this session's
// cached catalog, so the app tools' metadata is rebuilt on every metadata refresh.
async function connectExecutor({ fixture = catalogFixture, paths = ["tools.alpha.tool_000", "tools.alpha.tool_001"], env = {}, server = {}, settings = {}, select = [] }: {
  fixture?: string;
  paths?: string[];
  env?: Record<string, string>;
  server?: Partial<ServerEntry>;
  settings?: Record<string, unknown>;
  select?: Array<string | undefined>;
} = {}) {
  const ui = { select: vi.fn(async () => select.shift()), input: vi.fn(), notify: vi.fn() };
  const tempDir = await mkdtemp(`${tmpdir()}/pi-mcp-executor-app-call-`);
  tempDirs.push(tempDir);
  const logPath = `${tempDir}/events.jsonl`;
  const definition = {
    command: process.execPath,
    args: [fixture],
    protocolVersion: "2026-07-28" as const,
    env: { EXECUTOR_LOG_FILE: logPath, EXECUTOR_CATALOG_TOOLS: "2", ...env },
    ...server,
  };
  const manager = new McpServerManager();
  manager.setDefaultRequestTimeoutMs(2_000);
  manager.setElicitationConfig({ ui, allowUrl: true });
  await manager.connect("executor", definition);
  managers.push(manager);
  const entry: ServerCacheEntry = {
    configHash: computeServerHash(definition), cachedAt: Date.now(), tools: [], resources: [],
    executorApps: { tools: paths.map(appTool), total: paths.length, cap: 1000, fetchedAt: Date.now() },
  };
  const state = {
    manager,
    config: { settings: { toolPrefix: "server", ...settings }, mcpServers: { executor: definition } },
    sessionMetadata: new Map([["executor", entry]]),
    toolMetadata: new Map([["executor", executorAppToolMetadata("executor", entry, "server", definition, undefined, new Set())]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    ui,
    completedUiSessions: [],
    owner: { signal: new AbortController().signal, isActive: () => true },
    uiServer: null,
  } as unknown as McpExtensionState;
  const received = async () => (await readFile(logPath, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.method === "tools/call" || event.name);
  const calls = async () => (await received()).filter(event => event.name !== undefined).map(event => ({ name: event.name, arguments: event.arguments }));
  return { state, ui, calls };
}

// direct: the registered deferred tool; script: a codemode script's nested call to it; proxy: the
// in-proxy `mcp({ tool })` leg, as under MCP_DIRECT_TOOLS=__none__, a frozen surface or no ctx.executeTool.
function callApp(state: McpExtensionState, leg: Leg, path: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
  const meta = state.toolMetadata.get("executor")!.find(tool => tool.executorPath === path)!;
  if (leg === "proxy") return executeCall(state, meta.originalName, args, "executor", undefined, signal) as Promise<Result>;
  if (leg === "script") state.deliversToScript = toolCallId => toolCallId?.includes("/") === true;
  return createDirectToolExecutor(() => state, () => null, {
    serverName: "executor",
    prefixedName: meta.name,
    originalName: meta.originalName,
    description: meta.description,
    inputSchema: meta.inputSchema,
    executorPath: path,
  }, true)(leg === "script" ? "codemode-1/1" : "call-1", args, signal, undefined, undefined as never) as Promise<Result>;
}

const legs = ["direct", "script", "proxy"] as const;

describe("calling an Executor app tool", () => {
  it.each(legs)("sends one `call` with the object form of `calls` on the %s leg", async (leg) => {
    const { state, calls } = await connectExecutor();

    await callApp(state, leg, "tools.alpha.tool_001", { id: "7" });

    expect(await calls()).toEqual([{ name: "call", arguments: { calls: { path: "tools.alpha.tool_001", input: { id: "7" } } } }]);
  });

  it.each(legs)("returns the app tool's own value on the %s leg", async (leg) => {
    const { state } = await connectExecutor();

    const object = await callApp(state, leg, "tools.alpha.tool_000", { id: "7" });
    const text = await callApp(state, leg, "tools.alpha.tool_001", { id: "7" });

    const value = { path: "tools.alpha.tool_000", input: { id: "7" } };
    expect(JSON.parse(textOf(object))).toEqual(value);
    if (leg !== "proxy") expect(object.structuredContent).toEqual(value);
    expect(textOf(text)).toBe("tools.alpha.tool_001 record 7");
    expect(text).not.toHaveProperty("structuredContent");
    expect(`${textOf(object)}${textOf(text)}`).not.toMatch(/"status"|"execution"|toolCalls/);
  });

  it.each(legs)("returns a failed app tool as an error with Executor's message and response on the %s leg", async (leg) => {
    const { state } = await connectExecutor();

    const result = await callApp(state, leg, "tools.alpha.tool_000", { fail: true });

    expect(result.details).toMatchObject({ error: "tool_error" });
    expect(textOf(result)).toContain("NotFound (HTTP 404): No such record.");
    expect(textOf(result)).toContain('"code": "NotFound"');
  });

  it.each(legs)("fails a call whose result is not an Executor call outcome on the %s leg", async (leg) => {
    const { state } = await connectExecutor();

    const result = await callApp(state, leg, "tools.alpha.tool_000", { malformed: true });

    expect(result.details).toMatchObject({ error: "call_failed" });
    expect(textOf(result)).toContain("Executor returned a malformed result for tools.alpha.tool_000");
  });

  it("passes Pi's own text, such as a redacted unavailable outcome, through unchanged", () => {
    const redacted = { content: [{ type: "text" as const, text: "That request is no longer waiting." }], isError: false };
    expect(unwrapExecutorCallResult("tools.alpha.tool_000", redacted)).toBe(redacted);
  });

  it("returns Executor being at capacity as an error to try again", () => {
    expect(unwrapExecutorCallResult("tools.alpha.tool_000", { content: [], structuredContent: { status: "capacity-exceeded" } }))
      .toEqual({ content: [{ type: "text", text: "Executor is at capacity for this call; try it again." }], isError: true });
  });

  it.each(["direct", "proxy"] as const)("returns a run Executor failed as a tool error and keeps the connection on the %s leg", async (leg) => {
    const { state, calls } = await connectExecutor();
    const connection = state.manager.getConnection("executor");

    const result = await callApp(state, leg, "tools.alpha.tool_000", { timeout: true });

    expect(result.details).toMatchObject({ error: "tool_error" });
    expect(textOf(result)).toContain("Executor could not run tools.alpha.tool_000: Timed out after 300000 ms");
    expect(state.manager.getConnection("executor")).toBe(connection);
    expect(connection?.status).toBe("connected");
    expect(textOf(await callApp(state, leg, "tools.alpha.tool_001", { id: "7" }))).toBe("tools.alpha.tool_001 record 7");
    expect((await calls()).map(call => call.name)).toEqual(["call", "call"]);
  });

  it.each(["direct", "proxy"] as const)("names the app tool when its approval can't be asked on the %s leg", async (leg) => {
    const { state } = await connectExecutor({ env: { EXECUTOR_CALL_APPROVAL: "1" } });
    // As in a session that can't show dialogs.
    state.manager.promptFormElicitation = async () => undefined;

    const result = await callApp(state, leg, "tools.alpha.tool_001", { id: "7" });

    expect(textOf(result)).toContain('MCP tool "alpha.tool_001" on server "executor" paused for your approval');
  });

  it.each(["direct", "proxy"] as const)("answers Executor's approval pause in Pi and resumes on the %s leg", async (leg) => {
    const { state, ui, calls } = await connectExecutor({ env: { EXECUTOR_CALL_APPROVAL: "1" }, select: ["Continue"] });

    const result = await callApp(state, leg, "tools.alpha.tool_001", { id: "7" });

    expect(textOf(result)).toBe("tools.alpha.tool_001 record 7");
    expect(ui.select).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Approve tools.alpha.tool_001?"), ["Continue", "Decline"]);
    expect((await calls()).map(call => call.name)).toEqual(["call", "resume"]);
  });

  it.each(["direct", "proxy"] as const)("connects a missing account and retries the call once on the %s leg", async (leg) => {
    const { state, ui, calls } = await connectExecutor({
      fixture: accountFixture,
      paths: ['tools["needs-account"].read'],
      env: { EXECUTOR_ACCOUNT_MODE: "local" },
      select: ["Open", "Continue"],
    });

    const result = await callApp(state, leg, 'tools["needs-account"].read', {});

    expect(textOf(result)).toBe("needs-account data");
    expect(open).toHaveBeenCalledOnce();
    expect(ui.select).toHaveBeenNthCalledWith(1, expect.stringContaining("needs-account needs your service account"), ["Open", "Decline"]);
    const sent = (await calls()).map(call => call.name);
    expect(sent.filter(name => name === "call")).toHaveLength(2);
    expect((await calls()).find(call => call.name === "call")!.arguments).toEqual({ calls: { path: 'tools["needs-account"].read', input: {} } });
  });

  it.each([
    ["the canonical path", ["alpha.tool_001"]],
    ["a glob over the app", ["alpha.*"]],
    ["destructive", "destructive"],
  ] as const)("asks approval once, on the app tool's path, for approveTools %s", async (_label, approveTools) => {
    for (const leg of ["direct", "proxy"] as const) {
      const { state, ui, calls } = await connectExecutor({ server: { approveTools: approveTools as ServerEntry["approveTools"] }, select: ["Allow once"] });

      const result = await callApp(state, leg, "tools.alpha.tool_001", { id: "7" });

      expect(textOf(result), leg).toBe("tools.alpha.tool_001 record 7");
      expect(ui.select, leg).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("MCP: executor wants to run alpha.tool_001"), expect.any(Array));
      expect((await calls()).map(call => call.name), leg).toEqual(["call"]);
    }
  });

  it.each(["direct", "proxy"] as const)("sends nothing when the approval is denied on the %s leg", async (leg) => {
    const { state, calls } = await connectExecutor({ server: { approveTools: ["alpha.*"] }, select: ["Deny"] });

    const result = await callApp(state, leg, "tools.alpha.tool_001", { id: "7" });

    expect(result.details).toMatchObject({ error: "approval_denied", tool: "alpha.tool_001" });
    expect(await calls()).toEqual([]);
  });

  it("never asks for Executor's own `call` approval when an app tool runs through it", async () => {
    const { state, ui, calls } = await connectExecutor({ server: { approveTools: ["call"] } });

    const result = await callApp(state, "direct", "tools.alpha.tool_001", { id: "7" });

    expect(textOf(result)).toBe("tools.alpha.tool_001 record 7");
    expect(ui.select).not.toHaveBeenCalled();
    expect((await calls()).map(call => call.name)).toEqual(["call"]);
  });

  it("keeps an app tool's observed output in the session for mcp({ describe })", async () => {
    const { state } = await connectExecutor();

    await callApp(state, "direct", "tools.alpha.tool_000", { id: "7" });

    expect(textOf(executeDescribe(state, "alpha.tool_000", "executor"))).toContain("Observed output (structuredContent");
  });

  it("guards a large result for the model, and gives a script the whole result without the raw MCP result", async () => {
    const { state } = await connectExecutor({ settings: { directToolResultDetails: "bounded" } });

    const model = await callApp(state, "direct", "tools.alpha.tool_001", { big: 60_000 });
    const script = await callApp(state, "script", "tools.alpha.tool_001", { big: 60_000 });

    expect(textOf(model)).toContain("[MCP text output truncated");
    expect(textOf(model)).toContain("Full text saved to");
    expect(textOf(model).length).toBeLessThan(60_000);
    expect(textOf(script)).toBe("x".repeat(60_000));
    expect(JSON.stringify(script.details)).not.toContain("rawMcpResult");
  });

  it.each(["direct", "proxy"] as const)("stops on an abort during the call and leaves nothing in flight on the %s leg", async (leg) => {
    const { state, calls } = await connectExecutor();
    const controller = new AbortController();

    const pending = callApp(state, leg, "tools.alpha.tool_000", { hold: true }, controller.signal);
    await vi.waitFor(async () => expect(await calls()).toHaveLength(1));
    controller.abort(new Error("stopped by the operator"));
    const result = await pending;

    expect(result.details).toMatchObject({ error: "aborted" });
    expect(state.manager.getConnection("executor")?.inFlight).toBe(0);
  });
});

describe("an Executor catalog pass", () => {
  it("keeps the connection busy until the pass settles, so the idle check doesn't close it mid-pass", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pi-mcp-executor-pass-`);
    tempDirs.push(dir);
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    const gate = `${dir}/search-gate`;
    const { state, calls } = await connectExecutor({ env: { EXECUTOR_SEARCH_GATE: gate } });
    const { executorApps: _cached, ...entry } = state.sessionMetadata!.get("executor")!;
    state.sessionMetadata!.set("executor", entry);
    const connection = state.manager.getConnection("executor")!;
    connection.lastUsedAt = 0;

    try {
      const pass = refreshExecutorCatalog(state, "executor")!;
      await vi.waitFor(async () => expect((await calls()).map(call => call.name)).toContain("search"));
      expect(state.manager.isIdle("executor", 1)).toBe(false);

      await writeFile(gate, "");
      await pass;
      expect(state.manager.isIdle("executor", 1)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets an aborted call stop waiting for the re-page of an unknown path, which still finishes", async () => {
    const dir = await mkdtemp(`${tmpdir()}/pi-mcp-executor-pass-`);
    tempDirs.push(dir);
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    const gate = `${dir}/search-gate`;
    const { state, calls } = await connectExecutor({ env: { EXECUTOR_SEARCH_GATE: gate } });
    const controller = new AbortController();

    try {
      const pending = executeCall(state, "alpha.tool_999", {}, "executor", undefined, controller.signal);
      await vi.waitFor(async () => expect((await calls()).map(call => call.name)).toContain("search"));
      controller.abort(new Error("stopped by the operator"));
      await expect(pending).rejects.toThrow("stopped by the operator");

      await writeFile(gate, "");
      // The pass the call started is still the one in flight, and it lands.
      await refreshExecutorCatalog(state, "executor");
      expect(state.sessionMetadata!.get("executor")!.executorApps!.tools).toHaveLength(6);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("listing Executor's tools in /mcp-adapter tools", () => {
  it("counts the app tools in one line instead of naming them", async () => {
    const { state } = await connectExecutor();
    const ui = { notify: vi.fn() };

    await showTools(state, { hasUI: true, ui } as never);

    const text = ui.notify.mock.calls[0]![0] as string;
    expect(text).toContain('  executor: +2 Executor app tools (2 in Executor\'s catalog); find them with mcp({ search: "..." }).');
    expect(text).not.toContain("alpha_tool");
  });
});
