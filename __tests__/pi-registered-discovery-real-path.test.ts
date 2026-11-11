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

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

// Real Pi host and stdio server: another extension registers the server with pi.registerMcpServer().
async function startSession(root: string): Promise<Session> {
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, additionalExtensionPaths: [resolve("index.ts")],
    extensionFactories: [(pi) => {
      pi.registerMcpServer("fixture", { command: process.execPath, args: [resolve("__tests__/fixtures/tools-only-server.mjs")] });
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "all",
  });
  await session.bindExtensions({ mode: "print" });
  return session;
}

async function stopSession(session: Session): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
  } finally {
    session.dispose();
  }
}

async function callMcp(session: Session, input: Record<string, unknown>) {
  const runner = session.extensionRunner;
  const mcp = runner.getAllRegisteredTools().find(tool => tool.definition.name === "mcp")!.definition;
  return await mcp.execute("call", input as never, undefined, undefined, runner.createToolContext("call", undefined)) as any;
}

const searchText = async (session: Session) =>
  (await callMcp(session, { search: "noop" })).content.map((block: { text?: string }) => block.text ?? "").join("");

describe("a server registered with pi.registerMcpServer()", () => {
  it("has searchable tools without a call: discovered when uncached, then restored from the cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-registered-discovery-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    const originalArgv = [...process.argv];
    try {
      await Promise.all([mkdir(join(root, "agent")), mkdir(join(root, "project"))]);
      process.env.PI_CODING_AGENT_DIR = join(root, "agent");
      const configPath = join(root, "agent", "mcp-adapter.json");
      await writeFile(configPath, JSON.stringify({ mcpServers: {}, settings: { sampling: false, elicitation: false } }));
      process.argv.push("--mcp-config", configPath);

      const first = await startSession(root);
      try {
        await vi.waitFor(async () => expect(await searchText(first)).toContain("fixture_noop"), { timeout: 10_000 });
      } finally {
        await stopSession(first);
      }

      const second = await startSession(root);
      try {
        await vi.waitFor(async () => expect(await searchText(second)).toContain("fixture_noop"), { timeout: 10_000 });
        const status = await callMcp(second, {});
        expect(status.details.servers).toEqual([expect.objectContaining({ name: "fixture", status: "cached", toolCount: 1 })]);
      } finally {
        await stopSession(second);
      }
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
