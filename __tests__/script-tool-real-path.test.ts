import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { toolErrorOverride } from "../error-signal.ts";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ToolCall = { name: string; id: string; parent: string | undefined };

// A real Pi session with the adapter, Pi's codemode, the fixture MCP server and one script tool,
// close_stale, whose file is `script`, and a script tool echo that shadows the fixture's echo.
// Needs `env -u MCP_DIRECT_TOOLS`, as the suite runs.
// `blockTools` names tools a tool_call hook blocks, as a permission extension would.
async function withScriptTool(run: (pi: { session: Session; toolCalls: ToolCall[]; script: string; approvals: McpToolApprovalRequest[] }) => Promise<void>, settings: Record<string, unknown> = {}, blockTools: string[] = []): Promise<void> {
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
      settings: { sampling: false, elicitation: false, ...settings },
      scriptTools: {
        close_stale: { description: "Close stale issues", file: script, inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } },
        echo: { description: "Echo through a script", file: script },
      },
    }));
    process.argv.push("--mcp-config", configPath);
    const toolCalls: ToolCall[] = [];
    const approvals: McpToolApprovalRequest[] = [];
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, additionalExtensionPaths: [resolve("index.ts")],
      extensionFactories: [createCodemodeExtension(), (pi) => {
        pi.on("tool_call", (event) => {
          toolCalls.push({ name: event.toolName, id: event.toolCallId, parent: event.parentToolCallId });
          return blockTools.includes(event.toolName) ? { block: true, reason: "Blocked by the test" } : undefined;
        });
        // Allows each approval-broker request once, and records it.
        pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (request: McpToolApprovalRequest) => {
          approvals.push(request);
          request.claim(() => "allow_once");
        });
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
    await run({ session, toolCalls, script, approvals });
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

  it("asks the approval broker once for each approveTools-gated call inside it, and never for the script tool", async () => {
    await withScriptTool(async ({ session, toolCalls, script, approvals }) => {
      await writeFile(script, [
        "const first = await tools.mcp__fixture__echo({ value: input.repo + '/1' });",
        "const second = await tools.mcp__fixture__echo({ value: input.repo + '/2' });",
        "return [first.structuredContent.value, second.structuredContent.value].join(' ');",
      ].join("\n"));
      const result = await callAs(session, "mcp__script__close_stale", "st-1", { repo: "a/b" });

      expect(textOf(result)).toContain("a/b/1 a/b/2");
      expect(result.isError).toBeUndefined();
      expect(approvals).toHaveLength(2);
      approvals.forEach((request, index) => expect(request).toMatchObject({
        serverName: "fixture", originalToolName: "echo", args: { value: `a/b/${index + 1}` },
      }));
      expect(approvals.some(request => [request.originalToolName, request.prefixedToolName, request.serverName].some(name => name.includes("close_stale")))).toBe(false);
      expect(toolCalls.map(call => call.name)).toEqual(["mcp__script__close_stale", "mcp__fixture__echo", "mcp__fixture__echo"]);
    }, { approveTools: ["echo"] });
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

describe("a script tool through the mcp gateway in a real session", () => {
  const body = "return (await tools.mcp__fixture__echo({ value: input.repo })).structuredContent.value;";

  it("hands mcp({ tool }) to the registered script tool, which runs once under the mcp call", async () => {
    await withScriptTool(async ({ session, toolCalls, script }) => {
      await writeFile(script, body);
      const result = await callAs(session, "mcp", "mcp-1", { tool: "close_stale", args: { repo: "a/b" } });

      expect(textOf(result)).toContain("Script completed");
      expect(textOf(result)).toContain("a/b");
      expect(result.details).toEqual({ mode: "script_tool", tool: "close_stale", calls: [expect.objectContaining({ id: "mcp-1/1/1", name: "mcp__fixture__echo", status: "ok" })] });
      expect(toolCalls).toEqual([
        { name: "mcp", id: "mcp-1", parent: undefined },
        { name: "mcp__script__close_stale", id: "mcp-1/1", parent: "mcp-1" },
        { name: "mcp__fixture__echo", id: "mcp-1/1/1", parent: "mcp-1/1" },
      ]);
    });
  }, 30_000);

  it("refuses mcp({ tool }) for a script tool from inside a codemode script", async () => {
    await withScriptTool(async ({ session, toolCalls, script }) => {
      await writeFile(script, body);
      const result = await callAs(session, "codemode", "cm-1", { code: 'return await tools.mcp({ tool: "close_stale", args: { repo: "a/b" } });' });

      expect(textOf(result)).toContain('Script tool "close_stale" cannot run inside another script.');
      expect(toolCalls.map(call => call.name)).toEqual(["codemode", "mcp", "mcp__script__close_stale"]);
    });
  }, 30_000);

  it("runs the script in the proxy with a frozen surface, with the same result shape", async () => {
    await withScriptTool(async ({ session, toolCalls, script }) => {
      await writeFile(script, body);
      const result = await callAs(session, "mcp", "mcp-1", { tool: "close_stale", args: { repo: "a/b" } });

      expect(textOf(result)).toContain("a/b");
      expect(result.details).toEqual({ mode: "script_tool", tool: "close_stale", calls: [expect.objectContaining({ id: "mcp-1/1", name: "mcp__fixture__echo", status: "ok" })] });
      // No mcp__script__close_stale call: the script ran in the proxy, its MCP call nested under the mcp call.
      expect(toolCalls).toEqual([
        { name: "mcp", id: "mcp-1", parent: undefined },
        { name: "mcp__fixture__echo", id: "mcp-1/1", parent: "mcp-1" },
      ]);
    }, { freezeDirectTools: true });
  }, 30_000);

  it("flags a script that throws as an error, called directly, handed off by mcp, or run in the proxy", async () => {
    const failing = "throw new Error('boom');";
    await withScriptTool(async ({ session, script }) => {
      await writeFile(script, failing);
      const direct = await callAs(session, "mcp__script__close_stale", "st-1", { repo: "a/b" });
      const handedOff = await callAs(session, "mcp", "mcp-1", { tool: "close_stale", args: { repo: "a/b" } });

      expect(textOf(direct)).toContain("Error: boom");
      expect(direct.isError).toBe(true);
      expect(textOf(handedOff)).toContain("Error: boom");
      expect(handedOff.isError).toBe(true);
      expect(handedOff.details).toMatchObject({ mode: "script_tool", tool: "close_stale" });
    });
    await withScriptTool(async ({ session, script }) => {
      await writeFile(script, failing);
      const inProxy = await callAs(session, "mcp", "mcp-1", { tool: "close_stale", args: { repo: "a/b" } });

      expect(textOf(inProxy)).toContain("Error: boom");
      expect(inProxy.isError).toBe(true);
    }, { freezeDirectTools: true });
  }, 60_000);

  it("flags mcp({ tool }) as nested_call_failed when a tool_call hook blocks the script tool", async () => {
    await withScriptTool(async ({ session, toolCalls, script }) => {
      await writeFile(script, body);
      const result = await callAs(session, "mcp", "mcp-1", { tool: "close_stale", args: { repo: "a/b" } });

      expect(textOf(result)).toContain("Blocked by the test");
      expect(result.isError).toBe(true);
      expect(result.details).toEqual({ mode: "script_tool", tool: "close_stale", error: "nested_call_failed" });
      expect(toolErrorOverride(result.details)).toEqual({ isError: true });
      expect(toolCalls.map(call => call.name)).toEqual(["mcp", "mcp__script__close_stale"]);
    }, {}, ["mcp__script__close_stale"]);
  }, 30_000);

  it("runs the script tool over a same-named MCP tool and says how to reach that one", async () => {
    await withScriptTool(async ({ session, script }) => {
      await writeFile(script, 'return "from the script";');
      const shadowing = await callAs(session, "mcp", "mcp-2", { tool: "echo", args: {} });
      const direct = await callAs(session, "mcp", "mcp-3", { tool: "echo", server: "fixture", args: { value: "from the server" } });

      expect(textOf(shadowing)).toContain("from the script");
      expect(textOf(shadowing)).toContain('"echo" also names an MCP tool on server "fixture"; this call ran the script tool. Call the MCP tool with mcp({ tool: "echo", server: "fixture" }).');
      expect(shadowing.details).toMatchObject({ mode: "script_tool", tool: "echo" });
      expect(textOf(direct)).toContain("from the server");
      expect(textOf(direct)).not.toContain("script");
    });
  }, 30_000);
});

describe("a script tool an embedder supplies in createMcpAdapter({ config })", () => {
  it("drops an invalid entry with its reason, and resolves a relative file against the working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-script-tool-embedder-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session: Session | undefined;
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      await Promise.all([mkdir(agentDir), mkdir(cwd)]);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const script = join(root, "close-stale.js");
      await writeFile(script, 'return "ran " + input.repo;');
      const definition = { description: "Close stale issues", inputSchema: { type: "object", properties: { repo: { type: "string" } } } };
      const { createMcpAdapter } = await import("../index.ts");
      const notices: string[] = [];
      const settingsManager = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        extensionFactories: [createCodemodeExtension(), createMcpAdapter({
          config: {
            mcpServers: {},
            settings: { sampling: false, elicitation: false },
            scriptTools: {
              "Close Stale!": { ...definition, file: script },
              close_stale: { ...definition, file: relative(process.cwd(), script) },
            },
          },
        })],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
      }));
      const ui = { notify: (text: string) => notices.push(text), setStatus: () => undefined, theme: { fg: (_color: string, value: string) => value } } as any;
      await session.bindExtensions({ mode: "tui", uiContext: ui, onError: () => undefined });
      const names = () => session!.extensionRunner.getAllRegisteredTools().map(tool => tool.definition.name);
      await vi.waitFor(() => expect(names()).toContain("mcp__script__close_stale"), { timeout: 10_000 });

      expect(names().filter(name => name.startsWith("mcp__script__"))).toEqual(["mcp__script__close_stale"]);
      expect(notices).toContain('The MCP config supplied to the adapter: script tool "Close Stale!" was not loaded — its name must start with a lowercase letter and have only lowercase letters, digits and underscores, at most 48 characters.');
      expect(textOf(await callAs(session, "mcp__script__close_stale", "st-1", { repo: "a/b" }))).toContain("ran a/b");
    } finally {
      try {
        await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
      } finally {
        session?.dispose();
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

describe("a script tool entry a config file gets wrong, in a real session", () => {
  it("is warned about once when the session starts, listed by /mcp-adapter status, and never shown in mcp({})", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-script-tool-issue-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalArgv = [...process.argv];
    let session: Session | undefined;
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      await Promise.all([mkdir(agentDir), mkdir(cwd)]);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const configPath = join(agentDir, "mcp-adapter.json");
      await writeFile(join(root, "close-stale.js"), 'return "ran";');
      await writeFile(configPath, JSON.stringify({
        mcpServers: {},
        settings: { sampling: false, elicitation: false },
        scriptTools: {
          Bad: { description: "Bad name", file: join(root, "close-stale.js") },
          close_stale: { description: "Close stale issues", file: join(root, "close-stale.js") },
        },
      }));
      process.argv.push("--mcp-config", configPath);
      const issue = `${configPath}: script tool "Bad" was not loaded — its name must start with a lowercase letter and have only lowercase letters, digits and underscores, at most 48 characters.`;
      const notices: string[] = [];
      const settingsManager = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, additionalExtensionPaths: [resolve("index.ts")], extensionFactories: [createCodemodeExtension()],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
      }));
      const ui = { notify: (text: string) => notices.push(text), setStatus: () => undefined, theme: { fg: (_color: string, value: string) => value } } as any;
      await session.bindExtensions({ mode: "tui", uiContext: ui, onError: () => undefined });
      await vi.waitFor(() => expect(notices).toContain(issue), { timeout: 10_000 });
      const runner = session.extensionRunner;
      await vi.waitFor(() => expect(runner.getAllRegisteredTools().map(tool => tool.definition.name)).toContain("mcp__script__close_stale"), { timeout: 10_000 });

      await runner.getCommand("mcp-adapter")!.handler("status", runner.createCommandContext());
      const status = notices.find(text => text.startsWith("MCP Server Status:"));
      const overview = textOf(await callAs(session, "mcp", "mcp-1", {}));

      expect(notices.filter(text => text === issue)).toHaveLength(1);
      expect(status).toContain(`⚠ ${issue}`);
      expect(overview).not.toContain("Bad");
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
  }, 30_000);

  it.each([
    ["no servers", {}],
    // An eager server also starts initialization when the extension loads, before session_start.
    ["an eager server", { fixture: { command: process.execPath, args: [resolve("__tests__/fixtures/structured-echo-server.mjs")], lifecycle: "eager" } }],
  ])("prints the warning to stderr once in a session without UI, with %s", async (_case, mcpServers) => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-script-tool-issue-headless-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalArgv = [...process.argv];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let session: Session | undefined;
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      await Promise.all([mkdir(agentDir), mkdir(cwd)]);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const configPath = join(agentDir, "mcp-adapter.json");
      await writeFile(join(root, "close-stale.js"), 'return "ran";');
      await writeFile(configPath, JSON.stringify({
        mcpServers,
        settings: { sampling: false, elicitation: false },
        scriptTools: {
          Bad: { description: "Bad name", file: join(root, "close-stale.js") },
          close_stale: { description: "Close stale issues", file: join(root, "close-stale.js") },
        },
      }));
      process.argv.push("--mcp-config", configPath);
      const issue = `${configPath}: script tool "Bad" was not loaded — its name must start with a lowercase letter and have only lowercase letters, digits and underscores, at most 48 characters.`;
      const settingsManager = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, additionalExtensionPaths: [resolve("index.ts")], extensionFactories: [createCodemodeExtension()],
      });
      await loader.reload();
      ({ session } = await createAgentSession({
        cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
      }));
      await session.bindExtensions({ mode: "print" });
      const runner = session.extensionRunner;
      await vi.waitFor(() => expect(runner.getAllRegisteredTools().map(tool => tool.definition.name)).toContain("mcp__script__close_stale"), { timeout: 10_000 });
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(`MCP: ${issue}`), { timeout: 10_000 });
      // Let any later sync run, so a repeat would show.
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(warn.mock.calls.filter(([text]) => text === `MCP: ${issue}`)).toHaveLength(1);
    } finally {
      try {
        await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
      } finally {
        session?.dispose();
        warn.mockRestore();
        process.argv.splice(0, process.argv.length, ...originalArgv);
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
