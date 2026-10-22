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
    return {
      deferred: session.getAllTools().filter(tool => tool.exposure === "deferred").map(tool => tool.name),
      declared: session.agent.state.tools.map(tool => ({ name: tool.name, description: tool.description })),
      systemPrompt: session.systemPrompt,
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
