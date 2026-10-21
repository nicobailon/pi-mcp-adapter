import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Real Pi session, registered tools, nested-call pipeline, and stdio MCP transport.
describe("Pi codemode reach to proxy-only MCP tools", () => {
  it("calls a proxy-only server's tool through ctx.executeTool and gets its CallToolResult", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-codemode-deferred-"));
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
      const configPath = join(agentDir, "mcp-adapter.json");
      await writeFile(configPath, JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [resolve("__tests__/fixtures/structured-echo-server.mjs")] },
        },
        settings: { sampling: false, elicitation: false },
      }));
      process.argv.push("--mcp-config", configPath);
      const errors: string[] = [];
      const settingsManager = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, additionalExtensionPaths: [resolve("index.ts")],
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
      const ctx = session.extensionRunner.createToolContext("codemode-call", undefined);

      await vi.waitFor(() => expect(ctx.tools.map(tool => tool.name)).toContain("mcp__fixture__echo"), { timeout: 10_000 });
      const outcome = await ctx.executeTool("mcp__fixture__echo", { value: "hi" });

      expect(outcome.isError).toBe(false);
      expect(outcome.result.structuredContent).toEqual({ content: outcome.result.content, structuredContent: { value: "hi" } });
      expect(outcome.result.content).toContainEqual({ type: "text", text: "hi" });
      expect(session.getActiveToolNames()).not.toContain("mcp__fixture__echo");
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
  }, 20_000);
});
