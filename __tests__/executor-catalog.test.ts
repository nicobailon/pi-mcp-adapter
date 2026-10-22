import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { EXECUTOR_APP_TOOL_CAP, fetchExecutorCatalog } from "../executor-catalog.ts";
import { loadMetadataCache, saveExecutorCatalog, saveMetadataCache } from "../metadata-cache.ts";

type Receipt = { method?: string; name?: string; arguments?: Record<string, unknown>; served?: string; offset?: number; returned?: number; next?: number | null };
type Call = (input: Record<string, unknown>) => Promise<unknown>;

const fixture = resolve("__tests__/fixtures/executor-catalog-server.mjs");
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function agentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-executor-catalog-"));
  roots.push(root);
  await mkdir(join(root, "project"));
  return root;
}

// The fixture's receipt log for this agent dir; every session of a test appends to it.
async function receipts(root: string): Promise<Receipt[]> {
  return (await readFile(join(root, "receipts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

const searches = (log: Receipt[]) => log.filter(entry => entry.method === "tools/call" && entry.name === "search");

async function cachedEntry(root: string): Promise<Record<string, any> | undefined> {
  const raw = await readFile(join(root, "mcp-cache.json"), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : JSON.parse(raw).servers?.executor;
}

// A real Pi session with the adapter and the Executor catalog fixture as a keep-alive server, so
// it connects at startup and stays connected. Runs under `env -u MCP_DIRECT_TOOLS`, as the suite does.
async function withSession(
  root: string,
  env: Record<string, string>,
  run: (pi: { status: () => Promise<string>; call: Call }) => Promise<void>,
  server: Record<string, unknown> = {},
): Promise<void> {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalArgv = [...process.argv];
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    const cwd = join(root, "project");
    const configPath = join(root, "mcp-adapter.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        executor: {
          command: process.execPath,
          args: [fixture],
          lifecycle: "keep-alive",
          protocolVersion: "2026-07-28",
          env: { EXECUTOR_LOG_FILE: join(root, "receipts.jsonl"), ...env },
          ...server,
        },
      },
      settings: { sampling: false, elicitation: false },
    }));
    process.argv.push("--mcp-config", configPath);
    const notices: string[] = [];
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd, agentDir: root, settingsManager, additionalExtensionPaths: [resolve("index.ts")] });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: root, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
    }));
    const ui = { notify: (text: string) => notices.push(text), setStatus: () => undefined, theme: { fg: (_color: string, value: string) => value } } as any;
    await session.bindExtensions({ mode: "tui", uiContext: ui, onError: () => undefined });
    // Pi runs a nested call on behalf of the assistant message that issued the calling tool.
    session.agent.state.messages = [...session.agent.state.messages, {
      role: "assistant", content: [], api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }];
    const runner = session.extensionRunner;
    await vi.waitFor(() => expect(runner.getAllRegisteredTools().map(tool => tool.definition.name)).toContain("mcp"), { timeout: 10_000 });
    const call: Call = async (input) => {
      const proxy = runner.getAllRegisteredTools().find(tool => tool.definition.name === "mcp")!.definition;
      return proxy.execute("probe", input as never, undefined, undefined, runner.createToolContext("probe", undefined));
    };
    // Startup is done once the proxy lists the connected server's tools.
    await vi.waitFor(async () => expect(JSON.stringify(await call({ server: "executor" }))).toContain("executor_search"), { timeout: 10_000 });
    const status = async () => {
      notices.length = 0;
      await runner.getCommand("mcp-adapter")!.handler("status", runner.createCommandContext());
      return notices.find(text => text.startsWith("MCP Server Status:")) ?? "";
    };
    await run({ status, call });
  } finally {
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
    } finally {
      session?.dispose();
      process.argv.splice(0, process.argv.length, ...originalArgv);
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }
}

// A request after the startup pass would have sent its first `search`: the fixture reads stdin in order.
async function barrier(call: Call): Promise<void> {
  expect(JSON.stringify(await call({ tool: "executor_describe", args: { paths: ["tools.alpha.tool_000"] } }))).toContain("signature");
}

const toolPath = (app: string, index: number) => `tools.${app}.tool_${String(index).padStart(3, "0")}`;

describe("Executor app catalog", () => {
  it("pages the catalog in the background after the connect, in Executor's order, up to the cap", async () => {
    const root = await agentDir();
    const gate = join(root, "search-gate");
    await withSession(root, { EXECUTOR_SEARCH_GATE: gate }, async ({ call }) => {
      // Startup finished and the server answers while the first `search` is still held.
      await barrier(call);
      const held = await receipts(root);
      expect(held.findIndex(entry => entry.name === "search")).toBeGreaterThan(held.findIndex(entry => entry.method === "tools/list"));
      expect(searches(held)).toHaveLength(1);
      expect((await cachedEntry(root))?.executorApps).toBeUndefined();

      await writeFile(gate, "");
      await vi.waitFor(async () => expect((await cachedEntry(root))?.executorApps).toBeDefined(), { timeout: 10_000 });
    });

    const apps = (await cachedEntry(root))!.executorApps;
    expect(apps).toMatchObject({ total: 1200, cap: 1000, fetchedAt: expect.any(Number) });
    expect(apps.tools[0]).toEqual({
      path: "tools.alpha.tool_000",
      canonicalPath: "alpha.tool_000",
      description: "Read the alpha fixture record number 0, the way an Executor app tool describes itself on one line.",
      inputType: "{ id: string, limit?: number, [key: string]: unknown }",
    });
    expect(apps.tools.map((tool: { path: string }) => tool.path)).toEqual([
      ...["alpha", "beta"].flatMap(app => Array.from({ length: 400 }, (_, index) => toolPath(app, index))),
      ...Array.from({ length: 200 }, (_, index) => toolPath("gamma", index)),
    ]);
    expect(apps.unavailableApps).toBeUndefined();
    // Executor's namespaces carry the caller's linked-account labels; none reaches the cache.
    expect(JSON.stringify(apps)).not.toMatch(/acc_fixture|accounts|namespaces/);
    expect(JSON.stringify(await cachedEntry(root))).not.toContain("acc_fixture");

    // Each page starts where Executor's `next` said, which a byte-bounded page puts before offset + limit.
    const log = await receipts(root);
    const requests = searches(log).map(entry => entry.arguments!);
    const served = log.filter(entry => entry.served === "search");
    expect(requests[0]).toEqual({ query: "", limit: 200, offset: 0 });
    expect(requests.slice(1).map(request => request.offset)).toEqual(served.slice(0, -1).map(page => page.next));
    expect(served[0]!.returned).toBeLessThan(200);
    expect(served.reduce((sum, page) => sum + page.returned!, 0)).toBe(1000);
  }, 30_000);

  it("makes no request in a session whose cached catalog is fresh", async () => {
    const root = await agentDir();
    const env = { EXECUTOR_CATALOG_TOOLS: "5" };
    await withSession(root, env, async () => {
      await vi.waitFor(async () => expect((await cachedEntry(root))?.executorApps?.tools).toHaveLength(15), { timeout: 10_000 });
    });
    const before = searches(await receipts(root)).length;

    await withSession(root, env, async ({ call }) => {
      await barrier(call);
      expect(searches(await receipts(root))).toHaveLength(before);
    });
    expect((await cachedEntry(root))?.executorApps?.tools).toHaveLength(15);
  }, 30_000);

  it("keeps a private, zero-TTL listing's catalog in the session that fetched it", async () => {
    const root = await agentDir();
    const env = { EXECUTOR_CATALOG_TOOLS: "5", EXECUTOR_CATALOG_PRIVATE: "1", EXECUTOR_CATALOG_UNAVAILABLE: "locked" };
    await withSession(root, env, async ({ call, status }) => {
      await vi.waitFor(async () => expect(await status()).toContain("Executor could not list the app locked"), { timeout: 10_000 });
      // A reconnect pages again, and the catalog still stays in the session.
      expect(JSON.stringify(await call({ connect: "executor" }))).toContain("executor_search");
      await vi.waitFor(async () => expect(searches(await receipts(root))).toHaveLength(2), { timeout: 10_000 });
      expect(await status()).toContain("Executor could not list the app locked");
      expect(await cachedEntry(root)).toMatchObject({ cacheScope: "private" });
      expect((await cachedEntry(root))?.executorApps).toBeUndefined();
    });

    await withSession(root, env, async () => {
      await vi.waitFor(async () => expect(searches(await receipts(root))).toHaveLength(3), { timeout: 10_000 });
    });
    expect((await cachedEntry(root))?.executorApps).toBeUndefined();
  }, 30_000);

  it("keeps the apps Executor could not list on the entry and shows them in /mcp-adapter", async () => {
    const root = await agentDir();
    const env = { EXECUTOR_CATALOG_TOOLS: "5", EXECUTOR_CATALOG_UNAVAILABLE: "locked,flaky" };
    const reason = "This app needs an account, and none is linked to it for you.";
    const notes = [
      `⚠ executor: Executor could not list the app locked, so its tools are missing — ${reason}`,
      `⚠ executor: Executor could not list the app flaky, so its tools are missing — ${reason}`,
    ].join("\n");
    await withSession(root, env, async ({ status }) => {
      await vi.waitFor(async () => expect((await cachedEntry(root))?.executorApps?.unavailableApps).toEqual([{ name: "locked", reason }, { name: "flaky", reason }]), { timeout: 10_000 });
      expect(await status()).toContain(notes);
    });

    // A later session shows them from the cached catalog alone.
    await withSession(root, env, async ({ call, status }) => {
      await barrier(call);
      expect(searches(await receipts(root))).toHaveLength(1);
      expect(await status()).toContain(notes);
    });
  }, 30_000);

  it.each([
    ["no-path", "an item has no path"],
    ["items", "items is not an array"],
    ["remaining", "remaining is not a non-negative integer"],
  ])("writes no catalog and reports it unavailable when a page is malformed: %s", async (kind, detail) => {
    const root = await agentDir();
    await withSession(root, { EXECUTOR_CATALOG_MALFORMED: kind }, async ({ status }) => {
      await vi.waitFor(async () => expect(await status())
        .toContain(`⚠ executor: Executor app catalog unavailable — Executor returned a malformed search page: ${detail}`), { timeout: 10_000 });
      const served = (await receipts(root)).filter(entry => entry.served === "search");
      expect(served.map(page => page.offset)).toEqual([0, served[0]!.next]);
      expect(await status()).toMatch(/✓ executor: connected/);
    });
    expect(await cachedEntry(root)).toMatchObject({ configHash: expect.any(String) });
    expect((await cachedEntry(root))?.executorApps).toBeUndefined();
  }, 30_000);

  it("never pages a server that is not Executor, even with search and describe tools", async () => {
    const root = await agentDir();
    await withSession(root, { EXECUTOR_SERVER_NAME: "Other" }, async ({ call }) => {
      await barrier(call);
      expect((await receipts(root)).filter(entry => entry.method === "tools/call").map(entry => entry.name)).toEqual(["describe"]);
    });
    expect((await cachedEntry(root))?.executorApps).toBeUndefined();
  }, 30_000);

  it("runs no catalog pass under MCP_DIRECT_TOOLS=__none__", async () => {
    const root = await agentDir();
    vi.stubEnv("MCP_DIRECT_TOOLS", "__none__");
    await withSession(root, { EXECUTOR_CATALOG_TOOLS: "5" }, async ({ call }) => {
      await call({ connect: "executor" });
      await barrier(call);
      expect(searches(await receipts(root))).toEqual([]);
    });
    expect((await cachedEntry(root))?.executorApps).toBeUndefined();
  }, 30_000);

  it("skips Executor's own tools and excluded paths on ingest, so app tools still fill the cap", async () => {
    const root = await agentDir();
    await withSession(root, { EXECUTOR_CATALOG_OWN: "300", EXECUTOR_CATALOG_APPS: "4" }, async () => {
      await vi.waitFor(async () => expect((await cachedEntry(root))?.executorApps).toBeDefined(), { timeout: 10_000 });
    }, { excludeTools: ["beta.*"] });

    const apps = (await cachedEntry(root))!.executorApps;
    expect(apps).toMatchObject({ total: 1200, cap: 1000 });
    expect(apps.tools.map((tool: { path: string }) => tool.path)).toEqual([
      ...["alpha", "gamma"].flatMap(app => Array.from({ length: 400 }, (_, index) => toolPath(app, index))),
      ...Array.from({ length: 200 }, (_, index) => toolPath("delta", index)),
    ]);
  }, 30_000);
});

describe("Executor catalog paging", () => {
  const item = (path: string) => ({ path, description: "", input: "{}" });
  const page = (items: unknown[], next: { offset: number } | null, remaining = 0) =>
    ({ content: [], structuredContent: { items, namespaces: [], remaining, next, unavailableApps: [] } });
  const fetchPages = (pageAt: (offset: number) => unknown) => fetchExecutorCatalog({
    // Each answer waits a macrotask, so a loop that never ends still lets the test time out.
    client: { callTool: async (params: { arguments?: Record<string, unknown> }) => {
      await new Promise(resolve => setImmediate(resolve));
      return pageAt(params.arguments!.offset as number);
    } } as never,
    isAppTool: () => true,
  });

  it("ends at a page that repeats its offset with no items, as Executor sends when it lost a listing", async () => {
    const catalog = await fetchPages(offset => offset === 0 ? page([item("tools.a.x")], { offset: 1 }, 5) : page([], { offset: 1 }, 4));
    expect(catalog).toMatchObject({ tools: [{ path: "tools.a.x" }], total: 5 });
  });

  it("throws once there are more pages than the cap allows", async () => {
    let calls = 0;
    const pages = fetchPages(offset => {
      calls++;
      // Pages that keep advancing with nothing new; the last one ends a pass that has no bound.
      return page([item("tools.a.x")], calls > EXECUTOR_APP_TOOL_CAP + 1 ? null : { offset: offset + 1 }, 1);
    });
    await expect(pages).rejects.toThrow("Executor returned a malformed search page: more pages than the cap allows");
    expect(calls).toBe(EXECUTOR_APP_TOOL_CAP);
  });

  it("rejects an item whose path names no tool", async () => {
    await expect(fetchPages(() => page([item("tools")], null))).rejects.toThrow('item "tools" names no tool');
  });
});

describe("the startup cache write", () => {
  it("keeps an Executor catalog another session saved after this one's snapshot, unless the listing is session-only", async () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", await agentDir());
    const entry = { configHash: "h1", tools: [], resources: [], cachedAt: 1000 };
    const catalog = { tools: [{ path: "tools.a.x", canonicalPath: "a.x", description: "", inputType: "{}" }], total: 1, cap: 1000, fetchedAt: 2000 };
    saveMetadataCache({ version: 1, servers: { srv: entry } });
    const snapshot = loadMetadataCache()!.servers;
    saveExecutorCatalog("srv", "h1", catalog);

    saveMetadataCache({ version: 1, servers: { srv: { ...entry, cachedAt: 3000 } } }, { startupSnapshot: snapshot });
    expect(loadMetadataCache()!.servers.srv).toMatchObject({ cachedAt: 3000, executorApps: catalog });

    saveMetadataCache({ version: 1, servers: { srv: { ...entry, cachedAt: 4000, cacheScope: "private" } } }, { startupSnapshot: snapshot });
    expect(loadMetadataCache()!.servers.srv.executorApps).toBeUndefined();
  });
});
