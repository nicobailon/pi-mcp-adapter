import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Receipt = { method?: string; name?: string; arguments?: Record<string, unknown> };
type Pi = {
  session: Session;
  call: (name: string, input: Record<string, unknown>) => Promise<any>;
  command: (args: string) => Promise<string[]>;
};

const fixture = resolve("__tests__/fixtures/executor-catalog-server.mjs");
const roots: string[] = [];
const appToolNames = ["alpha", "beta", "gamma"].flatMap(app => [0, 1].map(index => `mcp__executor__${app}_tool_00${index}`));

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function agentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-executor-refresh-"));
  roots.push(root);
  await mkdir(join(root, "project"));
  return root;
}

async function receipts(root: string): Promise<Receipt[]> {
  return (await readFile(join(root, "receipts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

// Every catalog in these tests fits on one page, so one `search` is one pass.
const passes = async (root: string) => (await receipts(root)).filter(entry => entry.name === "search").length;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(block => block.text ?? "").join("");
const deferredAppTools = (session: Session) => session.getAllTools()
  .filter(tool => tool.exposure === "deferred" && /^mcp__executor__(alpha|beta|gamma|zeta)/.test(tool.name)).map(tool => tool.name);
const cachedCatalog = async (root: string) => JSON.parse(await readFile(join(root, "mcp-cache.json"), "utf8")).servers.executor.executorApps;

// A real Pi session with the adapter and the Executor catalog fixture (keep-alive unless the
// server says otherwise); every app tool call is approved. Runs under `env -u MCP_DIRECT_TOOLS`.
async function withSession(root: string, server: Record<string, unknown>, run: (pi: Pi) => Promise<void>): Promise<void> {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalArgv = [...process.argv];
  let session: Session | undefined;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    const cwd = join(root, "project");
    const configPath = join(root, "mcp-adapter.json");
    const { env, ...rest } = server as { env?: Record<string, string> };
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        executor: {
          command: process.execPath,
          args: [fixture],
          lifecycle: "keep-alive",
          protocolVersion: "2026-07-28",
          env: { EXECUTOR_LOG_FILE: join(root, "receipts.jsonl"), EXECUTOR_CATALOG_TOOLS: "2", ...env },
          ...rest,
        },
      },
      settings: { sampling: false, elicitation: false },
    }));
    process.argv.push("--mcp-config", configPath);
    const approve = (pi: ExtensionAPI) => {
      pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (request: McpToolApprovalRequest) => request.claim(() => "allow_once"));
    };
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd, agentDir: root, settingsManager, additionalExtensionPaths: [resolve("index.ts")], extensionFactories: [approve],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: root, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
    }));
    await session.bindExtensions({ mode: "print" });
    session.agent.state.messages = [...session.agent.state.messages, {
      role: "assistant", content: [], api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }];
    const runner = session.extensionRunner;
    const call = async (name: string, input: Record<string, unknown>) => {
      const tool = runner.getAllRegisteredTools().find(candidate => candidate.definition.name === name)!.definition;
      return tool.execute(`${name}-call`, input as never, undefined, undefined, runner.createToolContext(`${name}-call`, undefined));
    };
    const command = async (args: string) => {
      const notes: string[] = [];
      const ui = { ...runner.createCommandContext().ui, notify: (message: string) => notes.push(message) };
      await runner.getCommand("mcp-adapter")!.handler(args, { ...runner.createCommandContext(), hasUI: true, ui } as never);
      return notes;
    };
    await run({ session, call, command });
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

describe("Executor app catalog refresh", () => {
  it("pages again for a path the cache lacks, at most once a minute, then finds it or says it is not found", async () => {
    const root = await agentDir();
    const change = join(root, "catalog-changed");
    await withSession(root, { env: { EXECUTOR_CATALOG_CHANGE: change } }, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      expect(await passes(root)).toBe(1);
      await writeFile(change, "");

      const added = await call("mcp", { tool: "zeta.tool_000", args: { id: "1" } });
      expect(textOf(added)).toContain("tools.zeta.tool_000");
      expect(await passes(root)).toBe(2);
      await vi.waitFor(() => expect(deferredAppTools(session)).toContain("mcp__executor__zeta_tool_000"), { timeout: 10_000 });

      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      const unknown = await call("mcp", { tool: "zeta.tool_999", args: {} });
      expect(unknown.details).toMatchObject({ error: "tool_not_found" });
      expect(await passes(root)).toBe(2);

      vi.setSystemTime(Date.now() + 61_000);
      await call("mcp", { tool: "zeta.tool_999", args: {} });
      expect(await passes(root)).toBe(3);
    });
  }, 30_000);

  it("pages again when Executor no longer has a cached tool, and suggests Executor's matches", async () => {
    const root = await agentDir();
    const change = join(root, "catalog-changed");
    await withSession(root, { env: { EXECUTOR_CATALOG_CHANGE: change } }, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      await writeFile(change, "");

      const gone = await call("mcp", { tool: "alpha.tool_000", args: { id: "1" } });
      expect(textOf(gone)).toBe("Executor has no tool alpha.tool_000. Did you mean: alpha.tool_001, beta.tool_000");
      expect(gone.details).toMatchObject({ error: "tool_not_found", suggestions: ["alpha.tool_001", "beta.tool_000"] });
      expect(await passes(root)).toBe(2);
      await vi.waitFor(() => expect(deferredAppTools(session)).not.toContain("mcp__executor__alpha_tool_000"), { timeout: 10_000 });
      expect(deferredAppTools(session)).toContain("mcp__executor__zeta_tool_000");
    });
  }, 30_000);

  it("re-registers an app tool whose path Executor now spells differently, so a call sends the new path", async () => {
    const root = await agentDir();
    const brackets = join(root, "bracket-paths");
    await withSession(root, { env: { EXECUTOR_CATALOG_BRACKETS: brackets } }, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      await writeFile(brackets, "");
      await call("mcp", { connect: "executor" });
      await vi.waitFor(async () => expect((await cachedCatalog(root)).tools.map((tool: { path: string }) => tool.path)).toContain('tools["alpha"].tool_001'), { timeout: 10_000 });

      const outcome = await session.extensionRunner.createToolContext("model-call", undefined).executeTool("mcp__executor__alpha_tool_001", { id: "7" });
      expect(textOf(outcome.result)).toBe('tools["alpha"].tool_001 record 7');
    });
  }, 30_000);

  it("pages again on mcp({ connect }), /mcp-adapter reconnect and Executor's tools/list_changed", async () => {
    const root = await agentDir();
    const change = join(root, "catalog-changed");
    await withSession(root, { env: { EXECUTOR_CATALOG_CHANGE: change, EXECUTOR_LIST_CHANGED: "1" } }, async ({ session, call, command }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      expect(await passes(root)).toBe(1);

      await call("mcp", { connect: "executor" });
      await vi.waitFor(async () => expect(await passes(root)).toBe(2), { timeout: 10_000 });
      await command("reconnect executor");
      await vi.waitFor(async () => expect(await passes(root)).toBe(3), { timeout: 10_000 });

      await writeFile(change, "");
      await vi.waitFor(() => expect(deferredAppTools(session)).toContain("mcp__executor__zeta_tool_000"), { timeout: 10_000 });
      expect(await passes(root)).toBe(4);
    });
  }, 30_000);

  it("refreshes a catalog older than an hour in the background on the first connect, serving it meanwhile", async () => {
    const root = await agentDir();
    // The gate is part of the server's config, so every session has it; only the last one waits on it.
    const gate = join(root, "search-gate");
    const server = { env: { EXECUTOR_SEARCH_GATE: gate } };
    await writeFile(gate, "");
    await withSession(root, server, async ({ session }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
    });
    await vi.waitFor(async () => expect(await cachedCatalog(root)).toBeDefined());

    // A fresh catalog: no pass.
    await withSession(root, server, async ({ session }) => {
      expect(deferredAppTools(session)).toEqual(appToolNames);
    });
    expect(await passes(root)).toBe(1);

    const cache = JSON.parse(await readFile(join(root, "mcp-cache.json"), "utf8"));
    const staleAt = Date.now() - 2 * 3_600_000;
    cache.servers.executor.executorApps.fetchedAt = staleAt;
    await writeFile(join(root, "mcp-cache.json"), JSON.stringify(cache));
    await rm(gate);
    await withSession(root, server, async ({ session }) => {
      expect(deferredAppTools(session)).toEqual(appToolNames);
      await vi.waitFor(async () => expect(await passes(root)).toBe(2), { timeout: 10_000 });
      // The pass waits on the gate; the stale catalog is still what Pi has.
      expect((await cachedCatalog(root)).fetchedAt).toBe(staleAt);
      expect(deferredAppTools(session)).toEqual(appToolNames);
      await writeFile(gate, "");
      await vi.waitFor(async () => expect((await cachedCatalog(root)).fetchedAt).toBeGreaterThan(staleAt), { timeout: 10_000 });
    });
  }, 40_000);

  it("connects a lazy Executor whose cached catalog is empty and pages it again for a path it now has", async () => {
    const root = await agentDir();
    await withSession(root, {}, async ({ session }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
    });
    await vi.waitFor(async () => expect(await cachedCatalog(root)).toBeDefined());
    const cache = JSON.parse(await readFile(join(root, "mcp-cache.json"), "utf8"));
    // As if Executor had no apps when it was paged, and gained one since.
    cache.servers.executor.executorApps = { tools: [], total: 0, cap: 1000, fetchedAt: Date.now() };
    await writeFile(join(root, "mcp-cache.json"), JSON.stringify(cache));

    await withSession(root, { lifecycle: "lazy" }, async ({ call }) => {
      const result = await call("mcp", { tool: "alpha.tool_001", args: { id: "7" } });
      expect(textOf(result)).toBe("tools.alpha.tool_001 record 7");
      expect(await passes(root)).toBe(2);
    });
  }, 30_000);

  it("shows a lazy server's cached unavailable apps in /mcp-adapter without connecting it", async () => {
    const root = await agentDir();
    const server = { env: { EXECUTOR_CATALOG_UNAVAILABLE: "delta" } };
    await withSession(root, server, async ({ session }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
    });
    await vi.waitFor(async () => expect((await cachedCatalog(root))?.unavailableApps).toHaveLength(1));
    const before = (await receipts(root)).length;

    await withSession(root, { ...server, lifecycle: "lazy" }, async ({ call, command }) => {
      // Starts the runtime the way the model would; this command helper can't start it in print mode.
      await call("mcp", {});
      const status = (await command("status")).join("\n");
      expect(status).toContain("⚠ executor: Executor could not list the app delta, so its tools are missing — This app needs an account");
      expect((await receipts(root)).length).toBe(before);
    });
  }, 30_000);

  it("does not connect a lazy server at startup for a catalog older than an hour", async () => {
    const root = await agentDir();
    await withSession(root, {}, async ({ session }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
    });
    await vi.waitFor(async () => expect(await cachedCatalog(root)).toBeDefined());
    const cache = JSON.parse(await readFile(join(root, "mcp-cache.json"), "utf8"));
    cache.servers.executor.executorApps.fetchedAt = Date.now() - 2 * 3_600_000;
    await writeFile(join(root, "mcp-cache.json"), JSON.stringify(cache));
    const before = (await receipts(root)).length;

    await withSession(root, { lifecycle: "lazy" }, async ({ session }) => {
      expect(deferredAppTools(session)).toEqual(appToolNames);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect((await receipts(root)).length).toBe(before);
    });
  }, 30_000);

  it("registers no more than the cap from a cached catalog that holds more, and shows the cap", async () => {
    const root = await agentDir();
    await withSession(root, {}, async ({ session }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
    });
    await vi.waitFor(async () => expect(await cachedCatalog(root)).toBeDefined());
    const cache = JSON.parse(await readFile(join(root, "mcp-cache.json"), "utf8"));
    // Cached under a larger cap, as after an upgrade that lowers it, or edited by hand.
    const tools = Array.from({ length: 1500 }, (_, index) => {
      const path = `tools.alpha.tool_${String(index).padStart(4, "0")}`;
      return { path, canonicalPath: path.slice("tools.".length), description: "A cached tool", inputType: "{}" };
    });
    cache.servers.executor.executorApps = { tools, total: 1500, cap: 2000, fetchedAt: Date.now() };
    await writeFile(join(root, "mcp-cache.json"), JSON.stringify(cache));

    await withSession(root, {}, async ({ session, call, command }) => {
      expect(deferredAppTools(session)).toHaveLength(1000);
      expect(textOf(await call("mcp", { server: "executor" }))).toContain("+1000 Executor app tools (1500 in Executor's catalog, capped at 1000)");
      expect((await command("status")).join("\n")).toContain("\n  executor: 1000 of 1500 Executor app tools registered (cap)");
    });
  }, 40_000);

  it("shows the app tool count, the cap and each unavailable app with its reason in /mcp-adapter status", async () => {
    const root = await agentDir();
    await withSession(root, { env: { EXECUTOR_CATALOG_UNAVAILABLE: "delta" } }, async ({ session, command }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      const status = (await command("status")).join("\n");
      expect(status.endsWith("(5 tools)\n  executor: 6 Executor app tools")).toBe(true);
      expect(status).toContain("⚠ executor: Executor could not list the app delta, so its tools are missing — This app needs an account, and none is linked to it for you.");
      expect(status.match(/⚠/g)).toHaveLength(1);
    });

    const capped = await agentDir();
    await withSession(capped, { env: { EXECUTOR_CATALOG_TOOLS: "400" } }, async ({ command }) => {
      await vi.waitFor(async () => expect((await cachedCatalog(capped))?.tools).toHaveLength(1000), { timeout: 20_000 });
      const status = (await command("status")).join("\n");
      expect(status.endsWith("\n  executor: 1000 of 1200 Executor app tools registered (cap)")).toBe(true);
      expect(status).not.toContain("⚠");
    });
  }, 60_000);
});

describe("mcp({ describe }) on an Executor app tool", () => {
  const signature = "(input: {\n  id: string,\n  limit?: number,\n  [key: string]: unknown,\n}): Promise<unknown>";
  const describes = async (root: string) => (await receipts(root)).filter(entry => entry.name === "describe");

  it("adds a fetched signature to the catalog on disk without replacing a newer one", async () => {
    const root = await agentDir();
    await withSession(root, { env: { EXECUTOR_CATALOG_TRUNCATED: "1" } }, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      await vi.waitFor(async () => expect(await cachedCatalog(root)).toBeDefined());
      // Another session saved a newer catalog: it still has alpha.tool_001, no longer beta.tool_001, and a new tool.
      const cache = JSON.parse(await readFile(join(root, "mcp-cache.json"), "utf8"));
      const tool = (path: string) => ({ path, canonicalPath: path.slice("tools.".length), description: "From the newer catalog", inputType: "{ id: str…", inputTruncated: true });
      const newer = { tools: [tool("tools.alpha.tool_001"), tool("tools.zeta.tool_000")], total: 2, cap: 1000, fetchedAt: Date.now() + 1 };
      cache.servers.executor.executorApps = newer;
      await writeFile(join(root, "mcp-cache.json"), JSON.stringify(cache));

      await call("mcp", { describe: "alpha.tool_001" });
      await call("mcp", { describe: "beta.tool_001" });

      expect(await cachedCatalog(root)).toEqual({ ...newer, tools: [{ ...newer.tools[0], signature }, newer.tools[1]] });
    });
  }, 30_000);

  it("fetches and caches the full signature when Executor cut the input type", async () => {
    const root = await agentDir();
    await withSession(root, { env: { EXECUTOR_CATALOG_TRUNCATED: "1" } }, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      const first = textOf(await call("mcp", { describe: "alpha.tool_001" }));
      expect(first).toContain(`Full signature:\n${signature}`);
      expect(await describes(root)).toEqual([{ method: "tools/call", name: "describe", arguments: { paths: ["tools.alpha.tool_001"] } }]);

      expect(textOf(await call("mcp", { describe: "alpha.tool_001" }))).toBe(first);
      expect(await describes(root)).toHaveLength(1);
      expect((await cachedCatalog(root)).tools.find((tool: { path: string }) => tool.path === "tools.alpha.tool_001").signature).toBe(signature);
    });
  }, 30_000);

  it.each([
    ["tool", "Executor describe failed for tools.alpha.tool_001: Describe is unavailable right now."],
    ["protocol", "Internal error"],
  ])("still describes the tool, with a note, when Executor's describe fails (%s error)", async (fail, reason) => {
    const root = await agentDir();
    await withSession(root, { env: { EXECUTOR_CATALOG_TRUNCATED: "1", EXECUTOR_DESCRIBE_FAIL: fail } }, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      const text = textOf(await call("mcp", { describe: "alpha.tool_001" }));
      expect(text).toContain("Executor app tool alpha.tool_001");
      expect(text).toContain("Executor's full signature is unavailable: ");
      expect(text).toContain(reason);
      expect(text).not.toContain("Full signature:");
      expect((await cachedCatalog(root)).tools.find((tool: { path: string }) => tool.path === "tools.alpha.tool_001").signature).toBeUndefined();
    });
  }, 30_000);

  it("says so when Executor no longer has the tool, and never describes a tool it did not cut", async () => {
    const root = await agentDir();
    const change = join(root, "catalog-changed");
    await withSession(root, { env: { EXECUTOR_CATALOG_TRUNCATED: "1", EXECUTOR_CATALOG_CHANGE: change } }, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      await writeFile(change, "");
      expect(textOf(await call("mcp", { describe: "alpha.tool_000" }))).toContain("Executor has no tool alpha.tool_000.");
    });

    const whole = await agentDir();
    await withSession(whole, {}, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      expect(textOf(await call("mcp", { describe: "alpha.tool_001" }))).not.toContain("Full signature");
      expect(await describes(whole)).toEqual([]);
    });
  }, 30_000);
});
