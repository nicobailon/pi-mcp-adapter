import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import open from "open";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { connectProgram, findAccountGap } from "../executor-accounts.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";

vi.mock("open", () => ({ default: vi.fn(async () => undefined) }));

type Calls = { path: string; input: unknown } | Array<{ path: string; input: unknown }>;

function request(calls: Calls) {
  return { name: "call", arguments: { calls } };
}

function failed(path: string, code?: string) {
  return {
    path,
    ok: false,
    error: {
      kind: "ToolFailure",
      message: "This app needs an account, and none is linked to it for you.",
      ...(code ? { response: { code, status: 409, message: "This app needs an account.", retryable: false } } : {}),
    },
  };
}

function completed(value: unknown, toolCalls: Array<{ name: string; outcome: string }> = []) {
  return {
    content: [{ type: "text", text: "{}" }],
    structuredContent: { status: "completed", execution: { ok: true, value, toolCalls }, unavailableApps: [] },
  };
}

const single = request({ path: 'tools["needs-account"].read', input: {} });

describe("findAccountGap", () => {
  it("names the app from the request path of a single call with no linked account", () => {
    expect(findAccountGap(single, completed(failed('tools["needs-account"].read', "AppAccountRequired"))))
      .toEqual({ code: "AppAccountRequired", slug: "needs-account", retrySafe: true });
  });

  it("reads the slug from the caller's path, not Executor's echo, when binding an account fails", () => {
    const result = completed(failed("tools.other.read", "AccountRequired"), [{ name: "tools.github.issues.list", outcome: "failure" }]);
    expect(findAccountGap(request({ path: " github.issues.list ", input: {} }), result))
      .toEqual({ code: "AccountRequired", slug: "github", retrySafe: true });
  });

  it.each([
    ["a tool call that succeeded", [{ name: "tools.a.b", outcome: "success" }]],
    ["a tool call that may have run", [{ name: "tools.a.b", outcome: "interrupted" }]],
    ["a tool call awaiting approval", [{ name: "tools.a.b", outcome: "awaiting-approval" }]],
    ["two failed tool calls", [{ name: "tools.a.b", outcome: "failure" }, { name: "tools.a.c", outcome: "failure" }]],
  ])("is not retry-safe after %s", (_label, toolCalls) => {
    expect(findAccountGap(single, completed(failed("x", "AccountRequired"), toolCalls))?.retrySafe).toBe(false);
  });

  it("finds no gap in a batch, which is never retried, even with a malformed sibling", () => {
    const calls = request([{ path: "tools.broken.read", input: {} }, { path: "needs-account.read", input: {} }]);
    const gap = failed("needs-account.read", "AppAccountRequired");
    expect(findAccountGap(calls, completed([failed("tools.broken.read"), gap]))).toBeUndefined();
    expect(findAccountGap(calls, completed([{ ok: "maybe" }, gap]))).toBeUndefined();
  });

  it.each([
    ["an execute result", { name: "execute", arguments: { code: "x" } }, {
      structuredContent: {
        status: "completed",
        execution: { ok: false, error: { kind: "ToolFailure", message: "m", response: { code: "AppAccountRequired" } }, toolCalls: [] },
        unavailableApps: [],
      },
    }],
    ["a successful call", single, completed({ path: "x", ok: true, value: 1 })],
    ["another error code", single, completed(failed("x", "Forbidden"))],
    ["a failure with no response", single, completed(failed("x"))],
    ["a batch where another call succeeded", request([{ path: "a.b", input: {} }, { path: "c.d", input: {} }]),
      completed([{ path: "a.b", ok: true, value: null }, failed("c.d", "AppAccountRequired")])],
    ["a failed call execution", single, {
      structuredContent: { status: "completed", execution: { ok: false, error: { kind: "TimeoutExceeded", message: "m" }, toolCalls: [] } },
    }],
    ["a result that is not completed", single, { structuredContent: { status: "busy", requestId: "r" } }],
    ["a result with no structured content", single, { content: [{ type: "text", text: "boom" }], isError: true }],
  ])("finds no gap in %s", (_label, params, result) => {
    expect(findAccountGap(params, result)).toBeUndefined();
  });

  const malformed = (code?: string) => [
    ["an execution that is neither shape", { structuredContent: { status: "completed", execution: { ok: "yes", value: failed("x", code), toolCalls: [] } } }],
    ["an execution without toolCalls", { structuredContent: { status: "completed", execution: { ok: true, value: failed("x", code) } } }],
    ["an unknown tool call outcome", completed(failed("x", code), [{ name: "a", outcome: "skipped" }])],
    ["an outcome without a path", completed({ ...failed("x", code), path: undefined })],
    ["a sibling response without a code", completed([failed("x", code), { ...failed("y"), error: { kind: "ToolFailure", message: "m", response: {} } }])],
  ] as const;

  it.each(malformed())("passes through %s when no account is missing", (_label, result) => {
    expect(findAccountGap(single, result)).toBeUndefined();
  });

  it.each([
    ...malformed("AppAccountRequired"),
    ["a batch answer to a single call", completed([failed("x", "AppAccountRequired")])],
  ])("throws on %s with a missing account", (_label, result) => {
    expect(() => findAccountGap(single, result)).toThrow("Executor returned a malformed call result");
  });

  it("throws when the request path names no app", () => {
    expect(() => findAccountGap(request({ path: "tools", input: {} }), completed(failed("tools", "AppAccountRequired"))))
      .toThrow("which names no app");
  });
});

// Executor runs a program as async code with a top-level `return`; this runs the adapter's
// connect program the same way, against fake Executor-app tools that record each call.
async function runConnectProgram(mode: "local" | "hosted", accounts: Record<string, { scope: string; cardinality: string }>, linked: string[]) {
  const userConnect = vi.fn(async () => ({ connection: "conn_1", url: "http://127.0.0.1/connect" }));
  const executor = {
    ...(mode === "hosted"
      ? { context: { get: async () => ({ organization: "org_1" }) }, accounts: { connection: vi.fn() } }
      : { accountConnections: { get: vi.fn() } }),
    appManagement: { list: async () => [{ id: "app_2", slug: "other", requirements: { accounts: {} } }, { id: "app_1", slug: "needs-account", requirements: { accounts } }] },
    appAccounts: { userList: vi.fn(async () => linked.map(requirement => ({ requirement }))), userConnect },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (tools: unknown) => Promise<unknown>;
  const value = await new AsyncFunction("tools", connectProgram("needs-account"))({ executor });
  return { value, userConnect, userList: executor.appAccounts.userList };
}

describe("the connect program", () => {
  const one = { scope: "user", cardinality: "one" };

  it.each(["local", "hosted"] as const)("connects the one missing user account of the named app on %s Executor", async (mode) => {
    const accounts = { service: one, linkedAlready: one, shared: { scope: "app", cardinality: "one" }, many: { scope: "user", cardinality: "many" } };

    const { value, userConnect, userList } = await runConnectProgram(mode, accounts, ["linkedAlready"]);

    const path = mode === "hosted" ? { organization: "org_1", app: "app_1" } : { app: "app_1" };
    expect(userList).toHaveBeenCalledExactlyOnceWith({ path });
    expect(userConnect).toHaveBeenCalledExactlyOnceWith({ path: { ...path, requirement: "service" }, body: {} });
    expect(value).toMatchObject({ hosted: mode === "hosted", requirement: "service" });
  });

  it.each([
    ["local", "no user account is", { service: one }, ["service"]],
    ["hosted", "no user account is", { service: one }, ["service"]],
    ["local", "two user accounts are", { service: one, mail: one }, []],
    ["hosted", "two user accounts are", { service: one, mail: one }, []],
  ] as const)("on %s Executor connects nothing when %s missing", async (mode, _count, accounts, linked) => {
    const { value, userConnect } = await runConnectProgram(mode, accounts, [...linked]);

    expect(userConnect).not.toHaveBeenCalled();
    expect(value).toBeNull();
  });
});

const fixture = fileURLToPath(new URL("./fixtures/executor-server.mjs", import.meta.url));
const managers: McpServerManager[] = [];
const tempDirs: string[] = [];
const fixtureLinks = {
  local: { url: "http://127.0.0.1:4788/account-connect#token=fixture-secret", id: "conn_local_1" },
  hosted: { url: "https://executor.test/org/acme/connections/conn_hosted_1", id: "conn_hosted_1" },
};
const callArgs = { calls: { path: 'tools["needs-account"].read', input: {} } };
let handOffs = 0;

async function connectAccountExecutor({ mode = "local", select = [], env = {}, session = "tui", approve = false }: {
  mode?: "local" | "hosted";
  select?: Array<string | undefined>;
  env?: Record<string, string>;
  session?: "tui" | "non-tui" | "headless";
  approve?: boolean;
} = {}) {
  const ui = { select: vi.fn(async () => select.shift()), input: vi.fn(), notify: vi.fn() };
  const tempDir = await mkdtemp(`${tmpdir()}/pi-mcp-executor-accounts-`);
  tempDirs.push(tempDir);
  const logPath = `${tempDir}/events.jsonl`;
  const definition = {
    command: process.execPath,
    args: [fixture],
    protocolVersion: "2026-07-28" as const,
    env: { EXECUTOR_LOG_FILE: logPath, EXECUTOR_ACCOUNT_MODE: mode, ...env },
    ...(approve ? { approveTools: ["call"] } : {}),
  };
  const manager = new McpServerManager();
  manager.setDefaultRequestTimeoutMs(2_000);
  if (session !== "headless") manager.setElicitationConfig({ ui, allowUrl: session === "tui" });
  await manager.connect("executor", definition);
  managers.push(manager);
  const state = {
    manager,
    config: { settings: { toolPrefix: "server" }, mcpServers: { executor: definition } },
    toolMetadata: new Map([["executor", ["execute", "call", "resume"].map(name => ({
      name: `executor_${name}`, originalName: name, description: name, inputSchema: { type: "object", properties: {} },
    }))]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    ui,
    completedUiSessions: [],
    uiServer: null,
  } as unknown as McpExtensionState;
  const sent = async (name: string) => (await readFile(logPath, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.name === name).length;
  return { state, ui, sent };
}

// proxy: the in-proxy call (frozen or `__none__` surface); direct: the registered `mcp__executor__call`,
// built with structuredContent as the deferred surface registers it; hand-off: `mcp({ tool })` handed
// to that registered tool, which runs it as the proxy would; script: a codemode script's nested call
// to the registered tool, which gets the whole result.
function runCall(state: McpExtensionState, path: "proxy" | "direct" | "hand-off" | "script" = "proxy") {
  if (path === "proxy") return executeCall(state, "executor_call", callArgs, "executor");
  if (path === "hand-off") {
    const handOff = async ({ serverName, toolMeta, args }: { serverName: string; toolMeta: { name: string }; args: Record<string, unknown> | undefined }) => {
      handOffs++;
      return executeCall(state, toolMeta.name, args, serverName);
    };
    return executeCall(state, "executor_call", callArgs, "executor", undefined, undefined, undefined, undefined, undefined, handOff);
  }
  if (path === "script") state.deliversToScript = toolCallId => toolCallId?.includes("/") === true;
  return createDirectToolExecutor(() => state, () => null, {
    serverName: "executor",
    prefixedName: "executor_call",
    originalName: "call",
    description: "Executor call",
    inputSchema: { type: "object", properties: {} },
  }, true)(path === "script" ? "codemode-1/1" : "call-1", callArgs, undefined, undefined, undefined as never);
}

function visible(result: { content?: Array<{ type: string; text?: string }>; details?: unknown }): string {
  return `${result.content?.map(block => block.text ?? "").join("\n")} ${JSON.stringify(result.details)}`;
}

afterEach(async () => {
  handOffs = 0;
  vi.mocked(open).mockClear();
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("connecting a missing Executor account", () => {
  it.each([
    ["local", "proxy"],
    ["local", "direct"],
    ["hosted", "proxy"],
    ["hosted", "direct"],
  ] as const)("connects a %s account on the %s path and retries the call once", async (mode, path) => {
    const { state, ui, sent } = await connectAccountExecutor({ mode, select: ["Open", "Continue"] });

    const result = await runCall(state, path);

    expect(visible(result)).toContain("needs-account data");
    expect(open).toHaveBeenCalledExactlyOnceWith(fixtureLinks[mode].url);
    expect(ui.select).toHaveBeenNthCalledWith(1, expect.stringContaining("needs-account needs your service account"), ["Open", "Decline"]);
    expect(await sent("call")).toBe(2);
    expect(visible(result)).not.toMatch(/fixture-secret|token=|conn_|executor\.test|127\.0\.0\.1/);
    expect(JSON.stringify(ui.notify.mock.calls)).not.toMatch(/fixture-secret|token=|conn_|executor\.test|127\.0\.0\.1/);
  });

  it.each(["proxy", "direct", "hand-off", "script"] as const)("asks approval once and connects once on the %s path", async (path) => {
    const { state, ui, sent } = await connectAccountExecutor({ approve: true, select: ["Allow once", "Open", "Continue"] });

    const result = await runCall(state, path);

    expect(visible(result)).toContain("needs-account data");
    expect(ui.select).toHaveBeenCalledTimes(3);
    expect(handOffs).toBe(path === "hand-off" ? 1 : 0);
    expect(ui.select).toHaveBeenNthCalledWith(1, expect.stringContaining("MCP: executor wants to run call"), expect.any(Array));
    expect(ui.select).toHaveBeenNthCalledWith(2, expect.stringContaining("needs-account needs your service account"), ["Open", "Decline"]);
    expect(open).toHaveBeenCalledOnce();
    expect(await sent("call")).toBe(2);
    expect(await sent("execute")).toBe(2);
    if (path === "direct" || path === "script") {
      expect(result.structuredContent).toMatchObject({ status: "completed", execution: { ok: true, value: { ok: true, value: "needs-account data" } } });
    }
  });

  it.each(["direct", "script"] as const)("returns the pending message without structuredContent on the %s path", async (path) => {
    const { state } = await connectAccountExecutor({ select: ["Open", "Continue"], env: { EXECUTOR_ACCOUNT_STATE: "pending" } });

    const result = await runCall(state, path);

    expect(visible(result)).toContain("The needs-account account has not finished connecting in Executor");
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("rethrows an abort during the Continue dialog without retrying the call", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped by the operator");
    const { state, ui, sent } = await connectAccountExecutor();
    ui.select.mockImplementationOnce(async () => "Open").mockImplementationOnce(async () => {
      controller.abort(reason);
      return "Continue";
    });

    const result = await executeCall(state, "executor_call", callArgs, "executor", undefined, controller.signal);

    expect(result.details).toMatchObject({ error: "aborted", message: "stopped by the operator" });
    expect(await sent("call")).toBe(1);
    expect(await sent("execute")).toBe(1);
  });

  it.each([
    ["the browser link", ["Decline"], 0],
    ["Continue", ["Open", "Decline"], 1],
  ])("returns the original result when the operator declines %s", async (_label, select, opened) => {
    const { state, sent } = await connectAccountExecutor({ select });

    const result = await runCall(state);

    expect(visible(result)).toContain("AppAccountRequired");
    expect(open).toHaveBeenCalledTimes(opened);
    expect(await sent("call")).toBe(1);
  });

  it.each(["headless", "non-tui"] as const)("returns the original result in a %s session without asking Executor", async (session) => {
    const { state, sent } = await connectAccountExecutor({ session, select: ["Open", "Continue"] });

    const result = await runCall(state);

    expect(visible(result)).toContain("AppAccountRequired");
    expect(open).not.toHaveBeenCalled();
    expect(await sent("execute")).toBe(0);
  });

  it.each(["local", "hosted"] as const)("says a %s connection still pending has not finished, naming no link", async (mode) => {
    const { state, sent } = await connectAccountExecutor({ mode, select: ["Open", "Continue"], env: { EXECUTOR_ACCOUNT_STATE: "pending" } });

    const result = await runCall(state);

    expect(visible(result)).toContain("The needs-account account has not finished connecting in Executor");
    expect(visible(result)).not.toMatch(/fixture-secret|token=|conn_|executor\.test|127\.0\.0\.1/);
    expect(await sent("call")).toBe(1);
  });

  it.each([
    ["an expired connection", { EXECUTOR_ACCOUNT_STATE: "expired" }, 1, 1],
    ["no Executor app", { EXECUTOR_NO_EXECUTOR_APP: "1" }, 0, 1],
    ["a retried call still missing the account", { EXECUTOR_ACCOUNT_LINKS: "never" }, 1, 2],
  ])("returns Executor's own result for %s", async (_label, env, opened, calls) => {
    const { state, sent } = await connectAccountExecutor({ select: ["Open", "Continue", "Open", "Continue"], env });

    const result = await runCall(state);

    expect(visible(result)).toContain("AppAccountRequired");
    expect(open).toHaveBeenCalledTimes(opened);
    expect(await sent("call")).toBe(calls);
  });
});
