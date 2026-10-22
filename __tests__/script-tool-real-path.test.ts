import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ToolCall = { name: string; id: string; parent: string | undefined };

// A real Pi session with the adapter, Pi's codemode, the fixture MCP server and one script tool,
// close_stale, whose file is `script`. Needs `env -u MCP_DIRECT_TOOLS`, as the suite runs.
async function withScriptTool(run: (pi: { session: Session; toolCalls: ToolCall[]; script: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-script-tool-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalArgv = [...process.argv];
  let session: Session | undefined;
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(cwd)]);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const configPath = join(agentDir, "mcp-adapter.json");
    const script = join(root, "close-stale.js");
    await writeFile(configPath, JSON.stringify({
      mcpServers: { fixture: { command: process.execPath, args: [resolve("__tests__/fixtures/structured-echo-server.mjs")] } },
      settings: { sampling: false, elicitation: false },
      scriptTools: {
        close_stale: { description: "Close stale issues", file: script, inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
      },
    }));
    process.argv.push("--mcp-config", configPath);
    const toolCalls: ToolCall[] = [];
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, additionalExtensionPaths: [resolve("index.ts")],
      extensionFactories: [createCodemodeExtension(), (pi) => {
        pi.on("tool_call", (event) => { toolCalls.push({ name: event.toolName, id: event.toolCallId, parent: event.parentToolCallId }); });
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
    }));
    await session.bindExtensions({ mode: "print" });
    await session.extensionRunner.emit({ type: "agent_start" });
    // Pi runs a nested call on behalf of the assistant message that issued the calling tool.
    session.agent.state.messages = [...session.agent.state.messages, {
      role: "assistant", content: [], api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }];
    await vi.waitFor(() => expect(session!.extensionRunner.createToolContext("probe", undefined).tools.map(tool => tool.name))
      .toEqual(expect.arrayContaining(["mcp__fixture__echo", "mcp__script__close_stale"])), { timeout: 10_000 });
    await run({ session, toolCalls, script });
  } finally {
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
    } finally {
      session?.dispose();
      process.argv.splice(0, process.argv.length, ...originalArgv);
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  }
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(block => block.text ?? "").join("");

// As Pi runs a model-issued call: its tool_call hooks first, then the tool.
async function callAs(session: Session, toolName: string, toolCallId: string, input: Record<string, unknown>) {
  const runner = session.extensionRunner;
  const definition = runner.getAllRegisteredTools().find(tool => tool.definition.name === toolName)!.definition;
  await runner.emitToolCall({ type: "tool_call", toolName, toolCallId, input } as never);
  return definition.execute(toolCallId, input as never, undefined, undefined, runner.createToolContext(toolCallId, undefined)) as Promise<any>;
}

describe("a script tool in a real session", () => {
  it("runs the file as it is at call time with the call's arguments, its MCP calls nested under it", async () => {
    await withScriptTool(async ({ session, toolCalls, script }) => {
      await writeFile(script, "return (await tools.mcp__fixture__echo({ value: input.repo })).structuredContent.value;");
      const first = await callAs(session, "mcp__script__close_stale", "st-1", { repo: "a/b" });
      await writeFile(script, 'return "edited " + input.repo;');
      const second = await callAs(session, "mcp__script__close_stale", "st-2", { repo: "c/d" });

      expect(textOf(first)).toContain("Script completed");
      expect(textOf(first)).toContain("a/b");
      expect(first.details).toMatchObject({ mode: "script_tool", tool: "close_stale", calls: [{ id: "st-1/1", name: "mcp__fixture__echo", status: "ok" }] });
      expect(textOf(second)).toContain("edited c/d");
      expect(second.details).toEqual({ mode: "script_tool", tool: "close_stale", calls: [] });
      expect(toolCalls).toEqual([
        { name: "mcp__script__close_stale", id: "st-1", parent: undefined },
        { name: "mcp__fixture__echo", id: "st-1/1", parent: "st-1" },
        { name: "mcp__script__close_stale", id: "st-2", parent: undefined },
      ]);
    });
  }, 30_000);

  it("is rejected by Pi before it runs when the arguments do not match its inputSchema", async () => {
    await withScriptTool(async ({ session, toolCalls, script }) => {
      await writeFile(script, 'return "ran";');
      // Pi coerces what it can, such as a number to a string, so leave out the required repo.
      const outcome = await session.extensionRunner.createToolContext("outer", undefined).executeTool("mcp__script__close_stale", { owner: "a" });

      expect(outcome.isError).toBe(true);
      expect(textOf(outcome.result)).toContain('Validation failed for tool "mcp__script__close_stale"');
      expect(textOf(outcome.result)).not.toMatch(/ran|Script/);
      expect(toolCalls).toEqual([]);
    });
  }, 30_000);

  it("refuses to run from a codemode script, and starts no second sandbox", async () => {
    await withScriptTool(async ({ session, toolCalls, script }) => {
      await writeFile(script, "return (await tools.mcp__fixture__echo({ value: input.repo })).structuredContent.value;");
      const result = await callAs(session, "codemode", "cm-1", { code: 'return await tools.mcp__script__close_stale({ repo: "a/b" });' });

      expect(textOf(result)).toContain('Script tool "close_stale" cannot run inside another script.');
      expect(toolCalls).toEqual([
        { name: "codemode", id: "cm-1", parent: undefined },
        { name: "mcp__script__close_stale", id: "cm-1/1", parent: "cm-1" },
      ]);
    });
  }, 30_000);
});
