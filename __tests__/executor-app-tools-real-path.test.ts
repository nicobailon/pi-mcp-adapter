import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Receipt = { method?: string; name?: string; arguments?: Record<string, unknown> };

const fixture = resolve("__tests__/fixtures/executor-catalog-server.mjs");
const roots: string[] = [];
// 3 apps × 2 tools, after Executor's own tools.executor.apps.list.
const appToolNames = ["alpha", "beta", "gamma"].flatMap(app => [0, 1].map(index => `mcp__executor__${app}_tool_00${index}`));

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function agentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-executor-app-tools-"));
  roots.push(root);
  await mkdir(join(root, "project"));
  return root;
}

async function receipts(root: string): Promise<Receipt[]> {
  return (await readFile(join(root, "receipts.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

const searches = async (root: string) => (await receipts(root)).filter(entry => entry.name === "search").length;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(block => block.text ?? "").join("");

// A real Pi session with the adapter, Pi's codemode and tool_search, and the Executor catalog
// fixture as a keep-alive server. Runs under `env -u MCP_DIRECT_TOOLS`, as the suite does.
async function withSession(
  root: string,
  server: Record<string, unknown>,
  run: (pi: { session: Session; call: (name: string, input: Record<string, unknown>) => Promise<any> }) => Promise<void>,
  options: { settings?: Record<string, unknown>; extend?: (pi: ExtensionAPI) => void } = {},
): Promise<void> {
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
          env: { EXECUTOR_LOG_FILE: join(root, "receipts.jsonl"), EXECUTOR_CATALOG_TOOLS: "2", EXECUTOR_CATALOG_OWN: "1", ...env },
          ...rest,
        },
      },
      settings: { sampling: false, elicitation: false, ...options.settings },
    }));
    process.argv.push("--mcp-config", configPath);
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd, agentDir: root, settingsManager, additionalExtensionPaths: [resolve("index.ts")],
      extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), ...(options.extend ? [options.extend] : [])],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: root, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
    }));
    await session.bindExtensions({ mode: "print" });
    // Pi runs a nested call on behalf of the assistant message that issued the calling tool.
    session.agent.state.messages = [...session.agent.state.messages, {
      role: "assistant", content: [], api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }];
    const runner = session.extensionRunner;
    const call = async (name: string, input: Record<string, unknown>) => {
      const tool = runner.getAllRegisteredTools().find(candidate => candidate.definition.name === name)!.definition;
      return tool.execute(`${name}-call`, input as never, undefined, undefined, runner.createToolContext(`${name}-call`, undefined));
    };
    await run({ session, call });
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

// What the model is given: the declared tools with their descriptions, the system prompt and the active set.
function promptSurface(session: Session) {
  const descriptions = Object.fromEntries(["mcp", "codemode", "tool_search"].map(name =>
    [name, session.getAllTools().find(tool => tool.name === name)!.description]));
  return {
    descriptions,
    declared: session.agent.state.tools.map(tool => ({ name: tool.name, description: tool.description })),
    systemPrompt: session.systemPrompt,
    active: session.getActiveToolNames(),
  };
}

const deferredAppTools = (session: Session) => session.getAllTools()
  .filter(tool => tool.exposure === "deferred" && /^mcp__executor__(alpha|beta|gamma|executor)/.test(tool.name)).map(tool => tool.name);

describe("Executor app tools as Pi deferred tools", () => {
  it("registers each app tool once the catalog lands, findable by search, and declares nothing new", async () => {
    const root = await agentDir();
    const gate = join(root, "search-gate");
    await withSession(root, { env: { EXECUTOR_SEARCH_GATE: gate } }, async ({ session, call }) => {
      await vi.waitFor(() => expect(session.getAllTools().map(tool => tool.name)).toContain("mcp__executor__search"), { timeout: 10_000 });
      session.setActiveToolsByName(["mcp", "codemode", "tool_search"]);
      const before = promptSurface(session);
      expect(deferredAppTools(session)).toEqual([]);

      await writeFile(gate, "");
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });

      // Executor's own tools.executor.* tools are not app tools.
      expect(promptSurface(session)).toEqual(before);
      const tool = session.getAllTools().find(candidate => candidate.name === "mcp__executor__alpha_tool_001")!;
      expect(tool).toMatchObject({
        exposure: "deferred",
        namespace: { name: "mcp__executor" },
        parameters: { type: "object", properties: {} },
      });
      expect(tool.description).toBe("Read the alpha fixture record number 1, the way an Executor app tool describes itself on one line.\n\n"
        + "Executor app tool alpha.tool_001. Input: { id: string, limit?: number, [key: string]: unknown }");
      const registered = session.extensionRunner.getAllRegisteredTools().find(candidate => candidate.definition.name === tool.name)!.definition as any;
      expect(registered).not.toHaveProperty("promptSnippet");
      // A CallToolResult whose structuredContent has no declared type.
      expect(registered.outputSchema).toEqual({
        type: "object",
        properties: { content: { type: "array", items: { type: "object" } }, isError: { type: "boolean" }, _meta: { type: "object" } },
        required: ["content"],
      });

      expect(textOf(await call("mcp", { search: "alpha fixture record" }))).toContain("executor_alpha_tool_001");
      expect(textOf(await call("mcp", { describe: "alpha.tool_001" }))).toContain("Executor app tool alpha.tool_001");
      const script = await call("codemode", { code: 'return (await searchTools("alpha fixture record 1")).map(tool => tool.name);' });
      expect(textOf(script)).toContain("mcp__executor__alpha_tool_001");
      expect(textOf(await call("tool_search", { query: "alpha fixture record 1" }))).toContain("mcp__executor__alpha_tool_001");
    });
  }, 30_000);

  it("gives a codemode script an app tool's array value as data, while the model sees its JSON text", async () => {
    const root = await agentDir();
    await withSession(root, {}, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      const code = "const { structuredContent: list } = await tools.mcp__executor__alpha_tool_000({ list: true }); return Array.isArray(list) ? `array of ${list.length}, ids ${list.map(item => item.id).join(\"+\")}` : typeof list;";
      const script = textOf(await call("codemode", { code }));
      expect(script).toContain("Script completed");
      expect(script).toContain("array of 2, ids 1+2");
      const outcome = await session.extensionRunner.createToolContext("model-call", undefined).executeTool("mcp__executor__alpha_tool_000", { list: true });
      expect(JSON.parse(textOf(outcome.result))).toEqual([{ id: 1 }, { id: 2 }]);
    });
  }, 30_000);

  it("reaches an app tool from ctx.tools and ctx.executeTool, and registers a cached catalog before any request", async () => {
    const root = await agentDir();
    await withSession(root, {}, async ({ session }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
    });
    const searched = await searches(root);

    await withSession(root, {}, async ({ session }) => {
      // Registered from the cache when the extension loads, before the server connects.
      expect(deferredAppTools(session)).toEqual(appToolNames);
      const ctx = session.extensionRunner.createToolContext("codemode-call", undefined);
      expect(ctx.tools.map(tool => tool.name)).toContain("mcp__executor__beta_tool_001");

      // One Executor `call`, in the object form, for the exact path search returned.
      const outcome = await ctx.executeTool("mcp__executor__beta_tool_001", { id: "7" });
      expect(outcome.isError).toBe(false);
      expect(textOf(outcome.result)).toBe("tools.beta.tool_001 record 7");
      const calls = (await receipts(root)).filter(entry => entry.method === "tools/call" && entry.name !== "search");
      expect(calls).toEqual([{ method: "tools/call", name: "call", arguments: { calls: { path: "tools.beta.tool_001", input: { id: "7" } } } }]);
      expect(await searches(root)).toBe(searched);
    });
  }, 30_000);

  it("leaves app tools excluded by path unregistered and out of mcp({ search })", async () => {
    const root = await agentDir();
    await withSession(root, { excludeTools: ["alpha.*"] }, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames.filter(name => !name.includes("alpha"))), { timeout: 10_000 });
      const search = textOf(await call("mcp", { search: "fixture record" }));
      expect(search).toContain("executor_beta_tool_000");
      expect(search).not.toContain("alpha");
    });
  }, 30_000);

  it("never declares an app tool, even with directTools: true", async () => {
    const root = await agentDir();
    await withSession(root, { directTools: true }, async ({ session }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      expect(session.getActiveToolNames()).toContain("executor_search");
      expect(session.getActiveToolNames().filter(name => /alpha|beta|gamma/.test(name))).toEqual([]);
    });
  }, 30_000);

  describe("on a lazy Executor server", () => {
    const lazy = { lifecycle: "lazy" };
    const listings = async (root: string) => (await receipts(root)).filter(entry => entry.method === "tools/list").length;

    it("gets the catalog in the first session, and in a later one registers it from cache with no request", async () => {
      const root = await agentDir();
      await withSession(root, lazy, async ({ session }) => {
        await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
        const ctx = session.extensionRunner.createToolContext("codemode-call", undefined);
        expect(ctx.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(appToolNames));
      });
      const [searched, listed] = [await searches(root), await listings(root)];

      await withSession(root, lazy, async ({ session, call }) => {
        expect(deferredAppTools(session)).toEqual(appToolNames);
        // mcp({}) waits for startup, which neither connects nor pages.
        await call("mcp", {});
        expect([await searches(root), await listings(root)]).toEqual([searched, listed]);
      });
    }, 30_000);

    it("gets the catalog when the cache has the server's listing but no catalog yet", async () => {
      const root = await agentDir();
      await withSession(root, lazy, async ({ session }) => {
        await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      });
      // What a cache written before the catalog existed looks like.
      const cachePath = join(root, "mcp-cache.json");
      const cache = JSON.parse(await readFile(cachePath, "utf8"));
      delete cache.servers.executor.executorApps;
      await writeFile(cachePath, JSON.stringify(cache));
      const searched = await searches(root);

      await withSession(root, lazy, async ({ session }) => {
        await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
        expect(await searches(root)).toBeGreaterThan(searched);
      });
      expect(JSON.parse(await readFile(cachePath, "utf8")).servers.executor.executorApps.tools).toHaveLength(6);
    }, 30_000);
  });

  it("counts the same own tools in mcp({}) as in mcp({ server }), leaving app tools to their own line", async () => {
    const root = await agentDir();
    await withSession(root, {}, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      const listing = textOf(await call("mcp", { server: "executor" }));
      expect(listing).toContain("+6 Executor app tools");
      const own = /executor \((\d+) tools\)/.exec(listing)![1];
      const status = textOf(await call("mcp", {}));
      expect(status).toContain(`MCP: 1/1 servers, ${own} tools`);
      expect(status).toContain(`✓ executor (${own} tools,`);
    });
  }, 30_000);

  it("keeps the app tools in the proxy's metadata after mcp({ connect }) and /mcp-adapter reconnect", async () => {
    const root = await agentDir();
    await withSession(root, {}, async ({ session, call }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      await call("mcp", { connect: "executor" });
      expect(textOf(await call("mcp", { describe: "alpha.tool_001" }))).toContain("Executor app tool alpha.tool_001");
      const runner = session.extensionRunner;
      await runner.getCommand("mcp-adapter")!.handler("reconnect executor", runner.createCommandContext());
      expect(textOf(await call("mcp", { describe: "alpha.tool_001" }))).toContain("Executor app tool alpha.tool_001");
    });
  }, 30_000);

  it("starts normally from a cached catalog with corrupt items, and leaves them out", async () => {
    const root = await agentDir();
    await withSession(root, {}, async ({ session }) => {
      await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
    });
    const cachePath = join(root, "mcp-cache.json");
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    cache.servers.executor.executorApps.tools.unshift(null, { path: "tools" });
    await writeFile(cachePath, JSON.stringify(cache));

    await withSession(root, {}, async ({ session, call }) => {
      expect(deferredAppTools(session)).toEqual(appToolNames);
      expect(textOf(await call("mcp", { describe: "alpha.tool_001" }))).toContain("Executor app tool alpha.tool_001");
      expect(textOf(await call("mcp", { server: "executor" }))).toContain("+6 Executor app tools");
    });
  }, 30_000);

  it("lists Executor's own tools and one line for its app tools, with mcp({ server }) and mcp({ connect })", async () => {
    const root = await agentDir();
    await withSession(root, { env: { EXECUTOR_CATALOG_TOOLS: "400" } }, async ({ call }) => {
      await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, "mcp-cache.json"), "utf8")).servers.executor.executorApps?.tools).toHaveLength(1000), { timeout: 20_000 });
      await vi.waitFor(async () => expect(textOf(await call("mcp", { server: "executor" }))).toContain("+1000"), { timeout: 20_000 });
      const line = '+1000 Executor app tools (1200 in Executor\'s catalog, capped at 1000); find them with mcp({ search: "..." }).';
      for (const input of [{ server: "executor" }, { connect: "executor" }, { tool: "nope", server: "executor" }]) {
        const text = textOf(await call("mcp", input));
        expect(text, JSON.stringify(input)).toContain(line);
        expect(text.length, JSON.stringify(input)).toBeLessThan(2_000);
        expect(text, JSON.stringify(input)).not.toContain("alpha_tool");
      }
      expect(textOf(await call("mcp", { server: "executor" }))).toContain("executor (5 tools):");
    });
  }, 60_000);

  describe("called with mcp({ tool }) in the proxy", () => {
    // Allows each approval-broker request once, and records it.
    const brokerInto = (approvals: McpToolApprovalRequest[]) => (pi: ExtensionAPI) => {
      pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (request: McpToolApprovalRequest) => {
        approvals.push(request);
        request.claim(() => "allow_once");
      });
    };
    const appCalls = async (root: string) => (await receipts(root)).filter(entry => entry.method === "tools/call" && entry.name !== "search");

    async function callInProxy(root: string, approvals: McpToolApprovalRequest[], call: (name: string, input: Record<string, unknown>) => Promise<any>) {
      const result = await call("mcp", { tool: "alpha.tool_001", args: { id: "7" } });
      expect(textOf(result)).toBe("tools.alpha.tool_001 record 7");
      expect(approvals.map(request => [request.originalToolName, request.origin])).toEqual([["alpha.tool_001", "proxy"]]);
      expect(await appCalls(root)).toEqual([{ method: "tools/call", name: "call", arguments: { calls: { path: "tools.alpha.tool_001", input: { id: "7" } } } }]);
    }

    it("runs an app tool under MCP_DIRECT_TOOLS=__none__, approving once on its path", async () => {
      const root = await agentDir();
      await withSession(root, {}, async ({ session }) => {
        await vi.waitFor(() => expect(deferredAppTools(session)).toEqual(appToolNames), { timeout: 10_000 });
      });
      vi.stubEnv("MCP_DIRECT_TOOLS", "__none__");
      try {
        const approvals: McpToolApprovalRequest[] = [];
        await withSession(root, {}, async ({ session, call }) => {
          expect(deferredAppTools(session)).toEqual([]);
          // Nothing reaches Pi's registry, while the proxy still has the cached app tools.
          expect(session.getAllTools().map(tool => tool.name).filter(name => /alpha|beta|gamma/.test(name))).toEqual([]);
          expect(textOf(await call("mcp", { search: "alpha fixture record" }))).toContain("executor_alpha_tool_001");
          await callInProxy(root, approvals, call);
        }, { extend: brokerInto(approvals) });
      } finally {
        vi.unstubAllEnvs();
      }
    }, 30_000);

    it("runs an app tool the frozen surface never registered, approving once on its path", async () => {
      const root = await agentDir();
      const approvals: McpToolApprovalRequest[] = [];
      await withSession(root, {}, async ({ session, call }) => {
        await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, "mcp-cache.json"), "utf8")).servers.executor.executorApps).toBeDefined(), { timeout: 10_000 });
        expect(deferredAppTools(session)).toEqual([]);
        await callInProxy(root, approvals, call);
      }, { settings: { freezeDirectTools: true }, extend: brokerInto(approvals) });
    }, 30_000);
  });
});
