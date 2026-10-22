import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";

// Real Pi session, nested-call pipeline, tool_call hooks, approval broker, and stdio MCP transport.
describe("proxy calls through Pi's nested tool calls", () => {
  it("runs mcp and mcp__<server> calls under the registered tool name and asks once per call", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-proxy-nested-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
    const originalArgv = [...process.argv];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      await Promise.all([mkdir(agentDir), mkdir(cwd)]);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      delete process.env.MCP_DIRECT_TOOLS;
      const receipts = join(root, "receipts.jsonl");
      await writeFile(receipts, "");
      const configPath = join(agentDir, "mcp-adapter.json");
      await writeFile(configPath, JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [resolve("__tests__/fixtures/approval-broker-server.mjs")],
            env: { MCP_APPROVAL_RECEIPTS: receipts },
          },
        },
        settings: { approveTools: true, sampling: false, elicitation: false, scriptMode: true },
      }));
      process.argv.push("--mcp-config", configPath);
      const requests: McpToolApprovalRequest[] = [];
      const toolCalls: Array<{ name: string; id: string; parent: string | undefined }> = [];
      const errors: string[] = [];
      const settingsManager = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        additionalExtensionPaths: [resolve("index.ts")],
        extensionFactories: [(pi) => {
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
      const tool = (name: string) => runner.getAllRegisteredTools().find(registered => registered.definition.name === name)!.definition;
      await vi.waitFor(() => expect(runner.createToolContext("probe", undefined).tools.map(callable => callable.name))
        .toContain("mcp__fixture__echo"), { timeout: 10_000 });

      const proxied = await tool("mcp").execute("proxy-call", { tool: "fixture_echo", args: { value: "a" } }, undefined, undefined, runner.createToolContext("proxy-call", undefined));
      const namespaced = await tool("mcp__fixture").execute("ns-call", { tool: "echo", args: { value: "b" } }, undefined, undefined, runner.createToolContext("ns-call", undefined));
      // Without a nested-call context, and from mcpScript, the proxy runs the call itself.
      const inProxy = await tool("mcp").execute("plain-call", { tool: "fixture_echo", args: { value: "c" } }, undefined, undefined, runner.createContext());
      await tool("mcpScript").execute("script-call", { code: `return await tools.call("fixture_echo", { value: "d" });` }, undefined, undefined, runner.createToolContext("script-call", undefined));

      expect(toolCalls).toEqual([
        { name: "mcp__fixture__echo", id: "proxy-call/1", parent: "proxy-call" },
        { name: "mcp__fixture__echo", id: "ns-call/1", parent: "ns-call" },
      ]);
      expect(requests.map(request => [request.origin, request.args])).toEqual([
        ["proxy", { value: "a" }], ["proxy", { value: "b" }], ["proxy", { value: "c" }], ["script", { value: "d" }],
      ]);
      requests.forEach(request => expect(request).toMatchObject({ serverName: "fixture", originalToolName: "echo", prefixedToolName: "fixture_echo" }));
      const received = (await readFile(receipts, "utf8")).trim().split("\n").map(line => JSON.parse(line).arguments.value);
      expect(received).toEqual(["a", "b", "c", "d"]);

      for (const [result, value] of [[proxied, "a"], [namespaced, "b"], [inProxy, "c"]] as const) {
        expect(result.content).toEqual([{ type: "text", text: value }]);
        expect(result).not.toHaveProperty("structuredContent");
        expect(result.details).toMatchObject({ mode: "call", server: "fixture", tool: "echo", canonicalTool: "fixture_echo" });
        expect(Object.keys(result.details)).toEqual(Object.keys(inProxy.details));
      }
      expect(errors).toEqual([]);
    } finally {
      try {
        await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
      } finally {
        session?.dispose();
        process.argv.splice(0, process.argv.length, ...originalArgv);
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        if (originalDirectTools !== undefined) process.env.MCP_DIRECT_TOOLS = originalDirectTools;
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
