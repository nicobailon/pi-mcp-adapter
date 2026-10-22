import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
interface PiSession {
  runner: Session["extensionRunner"];
  tool(name: string): ReturnType<Session["extensionRunner"]["getAllRegisteredTools"]>[number]["definition"];
  activeTools(): string[];
  configPath: string;
  requests: McpToolApprovalRequest[];
  toolCalls: Array<{ name: string; id: string; parent: string | undefined }>;
  receipts(): Promise<Array<{ name: string; arguments: Record<string, unknown> }>>;
}

// Real Pi session, nested-call pipeline, tool_call hooks, approval broker, and stdio MCP transport.
async function withPiSession(
  options: { server: string; fixture: string; receiptsEnv: string; directTools?: string; settings?: Record<string, unknown> },
  run: (pi: PiSession) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-proxy-nested-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  const originalArgv = [...process.argv];
  let session: Session | undefined;
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(cwd)]);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    if (options.directTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
    else process.env.MCP_DIRECT_TOOLS = options.directTools;
    const receipts = join(root, "receipts.jsonl");
    await writeFile(receipts, "");
    const configPath = join(agentDir, "mcp-adapter.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        [options.server]: {
          command: process.execPath,
          args: [resolve(`__tests__/fixtures/${options.fixture}`)],
          env: { [options.receiptsEnv]: receipts },
        },
      },
      settings: { approveTools: true, sampling: false, elicitation: false, ...options.settings },
    }));
    process.argv.push("--mcp-config", configPath);
    const requests: McpToolApprovalRequest[] = [];
    const toolCalls: PiSession["toolCalls"] = [];
    const errors: string[] = [];
    let activeTools: (() => string[]) | undefined;
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [resolve("index.ts")],
      extensionFactories: [(pi) => {
        activeTools = () => pi.getActiveTools();
        pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (request: McpToolApprovalRequest) => {
          requests.push(request);
          request.claim(() => "allow_once");
        });
        pi.on("tool_call", (event) => {
          toolCalls.push({ name: event.toolName, id: event.toolCallId, parent: event.parentToolCallId });
        });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
    }));
    await session.bindExtensions({ mode: "print", onError: error => errors.push(error.error) });
    await session.extensionRunner.emit({ type: "agent_start" });
    // Pi runs a nested call on behalf of the assistant message that issued the calling tool.
    session.agent.state.messages = [...session.agent.state.messages, {
      role: "assistant", content: [], api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }];
    const runner = session.extensionRunner;
    // The server's tools are registered once it has been discovered.
    await vi.waitFor(() => expect(runner.getAllRegisteredTools().map(registered => registered.definition.name))
      .toContain(`mcp__${options.server}`), { timeout: 10_000 });
    await run({
      runner,
      tool: (name) => runner.getAllRegisteredTools().find(registered => registered.definition.name === name)!.definition,
      activeTools: () => activeTools!(),
      configPath,
      requests,
      toolCalls,
      receipts: async () => (await readFile(receipts, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    });
    expect(errors).toEqual([]);
  } finally {
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
    } finally {
      session?.dispose();
      process.argv.splice(0, process.argv.length, ...originalArgv);
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
      else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
      await rm(root, { recursive: true, force: true });
    }
  }
}

const brokerFixture = { server: "fixture", fixture: "approval-broker-server.mjs", receiptsEnv: "MCP_APPROVAL_RECEIPTS" };
const handoffFixture = { server: "handoff", fixture: "handoff-server.mjs", receiptsEnv: "MCP_HANDOFF_RECEIPTS" };

describe("proxy calls through Pi's nested tool calls", () => {
  it("runs mcp and mcp__<server> calls under the registered tool name and asks once per call", async () => {
    await withPiSession(brokerFixture, async ({ runner, tool, requests, toolCalls, receipts }) => {
      await vi.waitFor(() => expect(runner.createToolContext("probe", undefined).tools.map(callable => callable.name))
        .toContain("mcp__fixture__echo"), { timeout: 10_000 });

      const proxied = await tool("mcp").execute("proxy-call", { tool: "fixture_echo", args: { value: "a" } }, undefined, undefined, runner.createToolContext("proxy-call", undefined));
      const namespaced = await tool("mcp__fixture").execute("ns-call", { tool: "echo", args: { value: "b" } }, undefined, undefined, runner.createToolContext("ns-call", undefined));
      // Without a nested-call context, the proxy runs the call itself.
      const inProxy = await tool("mcp").execute("plain-call", { tool: "fixture_echo", args: { value: "c" } }, undefined, undefined, runner.createContext());

      expect(toolCalls).toEqual([
        { name: "mcp__fixture__echo", id: "proxy-call/1", parent: "proxy-call" },
        { name: "mcp__fixture__echo", id: "ns-call/1", parent: "ns-call" },
      ]);
      expect(requests.map(request => [request.origin, request.args])).toEqual([
        ["proxy", { value: "a" }], ["proxy", { value: "b" }], ["proxy", { value: "c" }],
      ]);
      requests.forEach(request => expect(request).toMatchObject({ serverName: "fixture", originalToolName: "echo", prefixedToolName: "fixture_echo" }));
      expect((await receipts()).map(receipt => receipt.arguments.value)).toEqual(["a", "b", "c"]);

      for (const [result, value] of [[proxied, "a"], [namespaced, "b"], [inProxy, "c"]] as const) {
        expect(result.content).toEqual([{ type: "text", text: value }]);
        expect(result).not.toHaveProperty("structuredContent");
        expect(result.details).toMatchObject({ mode: "call", server: "fixture", tool: "echo", canonicalTool: "fixture_echo" });
        expect(Object.keys(result.details)).toEqual(Object.keys(inProxy.details));
      }
    });
  }, 30_000);

  it("keeps mcp({ tool }) calls in the proxy with MCP_DIRECT_TOOLS=__none__", async () => {
    await withPiSession({ ...brokerFixture, directTools: "__none__" }, async ({ runner, tool, requests, toolCalls, receipts }) => {
      const result = await tool("mcp").execute("proxy-call", { tool: "fixture_echo", args: { value: "a" } }, undefined, undefined, runner.createToolContext("proxy-call", undefined));

      expect(result.content).toEqual([{ type: "text", text: "a" }]);
      expect(result.details).toMatchObject({ mode: "call", server: "fixture", tool: "echo", canonicalTool: "fixture_echo" });
      expect(toolCalls).toEqual([]);
      expect(requests.map(request => request.origin)).toEqual(["proxy"]);
      expect((await receipts()).map(receipt => receipt.arguments)).toEqual([{ value: "a" }]);
    });
  }, 30_000);

  it("leaves a schema the adapter cannot evaluate to the server instead of handing the call off", async () => {
    await withPiSession(handoffFixture, async ({ runner, tool, requests, toolCalls, receipts }) => {
      await vi.waitFor(() => expect(runner.createToolContext("probe", undefined).tools.map(callable => callable.name))
        .toContain("mcp__handoff__unresolved"), { timeout: 10_000 });

      const result = await tool("mcp").execute("proxy-call", { tool: "handoff_unresolved", args: { v: "x" } }, undefined, undefined, runner.createToolContext("proxy-call", undefined));

      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ v: "x" }) }]);
      expect(result.details).toMatchObject({ mode: "call", server: "handoff", tool: "unresolved", canonicalTool: "handoff_unresolved" });
      expect(toolCalls).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(await receipts()).toMatchObject([{ name: "unresolved", arguments: { v: "x" } }]);
    });
  }, 30_000);

  it("returns the same aborted result for a slow call aborted through the hand-off as in the proxy", async () => {
    await withPiSession(handoffFixture, async ({ runner, tool, toolCalls, receipts }) => {
      await vi.waitFor(() => expect(runner.createToolContext("probe", undefined).tools.map(callable => callable.name))
        .toContain("mcp__handoff__slow"), { timeout: 10_000 });
      const abortedCall = async (id: string, nested: boolean) => {
        const controller = new AbortController();
        const ctx = nested ? runner.createToolContext(id, controller.signal) : runner.createContext();
        const received = (await receipts()).length;
        const pending = tool("mcp").execute(id, { tool: "handoff_slow", args: {} }, controller.signal, undefined, ctx);
        // Abort only once the server has the call, so both legs are cut off mid-call however slow the connect is.
        await vi.waitFor(async () => expect((await receipts()).length).toBe(received + 1), { timeout: 10_000 });
        controller.abort(new Error("user cancelled"));
        return pending;
      };

      const handedOff = await abortedCall("nested-call", true);
      const inProxy = await abortedCall("plain-call", false);

      expect(toolCalls).toEqual([{ name: "mcp__handoff__slow", id: "nested-call/1", parent: "nested-call" }]);
      expect(handedOff.details).toMatchObject({ mode: "call", error: "aborted", server: "handoff", tool: "slow" });
      expect(handedOff).toEqual(inProxy);
    });
  }, 30_000);
});

describe("a config that still sets scriptMode", () => {
  type Surface = { active: string[]; registered: string[]; description: string; status: string; configPath: string; large: string[] };
  const surface = async (settings?: Record<string, unknown>) => {
    let seen: Surface | undefined;
    await withPiSession({ ...brokerFixture, settings }, async ({ runner, tool, activeTools, configPath }) => {
      await vi.waitFor(() => expect(runner.createToolContext("probe", undefined).tools.map(callable => callable.name))
        .toContain("mcp__fixture__echo"), { timeout: 10_000 });
      const status = await tool("mcp").execute("status", {}, undefined, undefined, runner.createContext());
      const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(block => block.text ?? "").join("");
      // Large enough for the removed "[Use mcpScript …]" footer, handed off and in the proxy.
      const args = { tool: "fixture_echo", args: { value: "x".repeat(10 * 1024) } };
      const large = [
        text(await tool("mcp").execute("large-call", args, undefined, undefined, runner.createToolContext("large-call", undefined))),
        text(await tool("mcp").execute("large-plain", args, undefined, undefined, runner.createContext())),
      ];
      seen = {
        active: activeTools(),
        registered: runner.getAllRegisteredTools().map(registered => registered.definition.name),
        description: tool("mcp").description,
        status: text(status),
        configPath,
        large,
      };
    });
    return seen!;
  };
  let plain: Surface;
  let scripted: Surface;
  beforeAll(async () => {
    plain = await surface();
    scripted = await surface({ scriptMode: true });
  }, 30_000);

  it("registers no mcpScript and keeps the same tools", () => {
    expect(scripted.registered).not.toContain("mcpScript");
    expect(plain.active).toContain("mcp");
    expect(scripted.active).toEqual(plain.active);
    expect(scripted.registered).toEqual(plain.registered);
  });

  it("says in mcp({}) to add \"+codemode\", naming the file", () => {
    const notice = `${scripted.configPath}: pi-mcp-adapter no longer has mcpScript, so settings.scriptMode does nothing. Remove it, and add "+codemode" to defaultTools in Pi's settings to script MCP calls with Pi's codemode.`;
    expect(scripted.status).toContain(`⚠ ${notice}`);
    expect(plain.status).not.toContain("mcpScript");
  });

  it("keeps mcpScript out of the mcp description and large results", () => {
    expect(scripted.description).toBe(plain.description);
    expect(scripted.description).not.toContain("mcpScript");
    expect(scripted.large).toHaveLength(2);
    for (const output of scripted.large) {
      expect(output).toContain("x".repeat(1024));
      expect(output).not.toContain("mcpScript");
    }
  });
});
