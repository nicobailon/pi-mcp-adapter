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

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Servers = Record<string, { command: string; args: string[]; env?: Record<string, string> }>;

const toolsOnly = { command: process.execPath, args: [resolve("__tests__/fixtures/tools-only-server.mjs")] };

// Real Pi host and stdio servers: another extension registers them with pi.registerMcpServer().
async function startSession(root: string, servers: Servers): Promise<Session> {
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, additionalExtensionPaths: [resolve("index.ts")],
    extensionFactories: [(pi) => {
      for (const [name, server] of Object.entries(servers)) pi.registerMcpServer(name, server);
    }],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "all",
  });
  await session.bindExtensions({ mode: "print" });
  return session;
}

async function inSession(root: string, servers: Servers, run: (session: Session) => Promise<void>): Promise<void> {
  const session = await startSession(root, servers);
  try {
    await run(session);
  } finally {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
    } finally {
      session.dispose();
    }
  }
}

// An empty adapter config in a fresh agent dir, shared by the sessions `run` starts.
async function withAgentDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-registered-discovery-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalArgv = [...process.argv];
  try {
    await Promise.all([mkdir(join(root, "agent")), mkdir(join(root, "project"))]);
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    const configPath = join(root, "agent", "mcp-adapter.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: {}, settings: { sampling: false, elicitation: false } }));
    process.argv.push("--mcp-config", configPath);
    await run(root);
  } finally {
    process.argv.splice(0, process.argv.length, ...originalArgv);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}

async function callMcp(session: Session, input: Record<string, unknown>) {
  const runner = session.extensionRunner;
  const mcp = runner.getAllRegisteredTools().find(tool => tool.definition.name === "mcp")!.definition;
  return await mcp.execute("call", input as never, undefined, undefined, runner.createToolContext("call", undefined)) as any;
}

const searchText = async (session: Session) =>
  (await callMcp(session, { search: "noop" })).content.map((block: { text?: string }) => block.text ?? "").join("");
const cachePath = (root: string) => join(root, "agent", "mcp-cache.json");
const lines = async (path: string) => (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);

describe("a server registered with pi.registerMcpServer()", () => {
  it("has searchable tools without a call: discovered when uncached, then restored from the cache", async () => {
    await withAgentDir(async (root) => {
      await inSession(root, { fixture: toolsOnly }, async (session) => {
        await vi.waitFor(async () => expect(await searchText(session)).toContain("fixture_noop"), { timeout: 10_000 });
      });
      await inSession(root, { fixture: toolsOnly }, async (session) => {
        await vi.waitFor(async () => expect(await searchText(session)).toContain("fixture_noop"), { timeout: 10_000 });
        const status = await callMcp(session, {});
        expect(status.details.servers).toEqual([expect.objectContaining({ name: "fixture", status: "cached", toolCount: 1 })]);
      });
    });
  }, 30_000);

  it("is not launched again in a later session after its discovery failed", async () => {
    await withAgentDir(async (root) => {
      const launches = join(root, "launches.log");
      const broken = { command: process.execPath, args: ["-e", `require("fs").appendFileSync(${JSON.stringify(launches)}, "x\\n"); process.exit(1)`] };
      await inSession(root, { broken }, async () => {
        await vi.waitFor(async () => expect(JSON.parse(await readFile(cachePath(root), "utf8")).servers.broken)
          .toMatchObject({ discoveryFailed: true }), { timeout: 10_000 });
      });
      expect(await lines(launches)).toHaveLength(1);
      // The other server's discovery starts with the broken one's, which would launch faster.
      await inSession(root, { broken, other: toolsOnly }, async (session) => {
        await vi.waitFor(async () => expect(await searchText(session)).toContain("other_noop"), { timeout: 10_000 });
      });
      expect(await lines(launches)).toHaveLength(1);
    });
  }, 30_000);

  it("connects a cached Executor listing without its app catalog, so the catalog pass runs", async () => {
    await withAgentDir(async (root) => {
      const receipts = join(root, "receipts.jsonl");
      const executor = {
        command: process.execPath,
        args: [resolve("__tests__/fixtures/executor-catalog-server.mjs")],
        env: { EXECUTOR_LOG_FILE: receipts, EXECUTOR_CATALOG_TOOLS: "2" },
      };
      const searches = async () => (await lines(receipts)).map(line => JSON.parse(line)).filter(entry => entry.name === "search").length;
      await inSession(root, { executor }, async () => {
        await vi.waitFor(async () => expect(JSON.parse(await readFile(cachePath(root), "utf8")).servers.executor.executorApps)
          .toBeDefined(), { timeout: 10_000 });
      });
      const cache = JSON.parse(await readFile(cachePath(root), "utf8"));
      delete cache.servers.executor.executorApps;
      await writeFile(cachePath(root), JSON.stringify(cache));
      const before = await searches();
      await inSession(root, { executor }, async (session) => {
        // With a cache on disk, the session starts the adapter on first use.
        await callMcp(session, {});
        await vi.waitFor(async () => expect(await searches()).toBe(before + 1), { timeout: 10_000 });
      });
    });
  }, 30_000);
});
