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

interface PromptSurface {
  deferred: string[];
  declared: Array<{ name: string; description: string }>;
  systemPrompt: string;
  /** The text of `mcp({})`. */
  status: string;
}

// One real Pi session with the adapter and Pi's codemode, `mcp` and `codemode` active.
async function promptSurface(agentDir: string, cwd: string, directTools: string | undefined): Promise<PromptSurface> {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  if (directTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
  else process.env.MCP_DIRECT_TOOLS = directTools;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      additionalExtensionPaths: [resolve("index.ts")],
      extensionFactories: [createCodemodeExtension()],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
    }));
    await session.bindExtensions({ mode: "print" });
    // The fixture's tools are cached by now, so the adapter's registrations are complete.
    await vi.waitFor(() => expect(session!.getAllTools().map(tool => tool.name)).toContain("mcp__fixture"), { timeout: 10_000 });
    session.setActiveToolsByName(["mcp", "codemode"]);
    const runner = session.extensionRunner;
    const mcp = runner.getAllRegisteredTools().find(tool => tool.definition.name === "mcp")!.definition;
    const status = await mcp.execute("status", {}, undefined, undefined, runner.createContext());
    return {
      deferred: session.getAllTools().filter(tool => tool.exposure === "deferred").map(tool => tool.name),
      declared: session.agent.state.tools.map(tool => ({ name: tool.name, description: tool.description })),
      systemPrompt: session.systemPrompt,
      status: status.content.map(block => block.type === "text" ? block.text : "").join(""),
    };
  } finally {
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
    } finally {
      session?.dispose();
      if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
      else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
  }
}

describe("prompt surface with deferred MCP tools", () => {
  it("declares the same tools, descriptions and system prompt with and without the deferred registrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-prompt-surface-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalArgv = [...process.argv];
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      await Promise.all([mkdir(agentDir), mkdir(cwd)]);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const configPath = join(agentDir, "mcp-adapter.json");
      await writeFile(configPath, JSON.stringify({
        mcpServers: { fixture: { command: process.execPath, args: [resolve("__tests__/fixtures/structured-echo-server.mjs")] } },
        settings: { sampling: false, elicitation: false },
      }));
      process.argv.push("--mcp-config", configPath);

      // The first session discovers the fixture and caches its tools.
      await promptSurface(agentDir, cwd, undefined);
      const withDeferred = await promptSurface(agentDir, cwd, undefined);
      const withoutDeferred = await promptSurface(agentDir, cwd, "__none__");

      expect(withDeferred.deferred).toContain("mcp__fixture__echo");
      expect(withoutDeferred.deferred).toEqual([]);
      expect(withDeferred.declared.map(tool => tool.name)).toEqual(["mcp", "codemode"]);
      expect(withDeferred.declared).toEqual(withoutDeferred.declared);
      expect(withDeferred.systemPrompt).toBe(withoutDeferred.systemPrompt);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("prompt surface with scriptTools in the config", () => {
  it("keeps the declared tools, their mcp and codemode descriptions, the system prompt and mcp({}) byte-identical, with deferred and bad script tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-prompt-surface-scripts-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalArgv = [...process.argv];
    try {
      const agentDir = join(root, "agent");
      const cwd = join(root, "project");
      await Promise.all([mkdir(agentDir), mkdir(cwd)]);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const configPath = join(agentDir, "mcp-adapter.json");
      const base = {
        mcpServers: { fixture: { command: process.execPath, args: [resolve("__tests__/fixtures/structured-echo-server.mjs")] } },
        settings: { sampling: false, elicitation: false },
      };
      process.argv.push("--mcp-config", configPath);

      await writeFile(configPath, JSON.stringify(base));
      // The first session discovers the fixture and caches its tools.
      await promptSurface(agentDir, cwd, undefined);
      const without = await promptSurface(agentDir, cwd, undefined);
      await writeFile(configPath, JSON.stringify({
        ...base,
        scriptTools: {
          close_stale: { description: "Close stale issues", file: "./close-stale.js", inputSchema: { type: "object", properties: { repo: { type: "string" } } } },
          Broken: { description: "Bad name", file: "./broken.js" },
        },
      }));
      const withScriptTools = await promptSurface(agentDir, cwd, undefined);

      expect(without.status).toContain("fixture");
      expect(withScriptTools.status).toBe(without.status);
      expect(withScriptTools.declared).toEqual(without.declared);
      expect(withScriptTools.systemPrompt).toBe(without.systemPrompt);
      // The script tool is only reachable from codemode and tool_search.
      expect(withScriptTools.deferred).toEqual(["mcp__script__close_stale", ...without.deferred]);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
