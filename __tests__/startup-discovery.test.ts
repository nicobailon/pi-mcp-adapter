import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMcp } from "../init.ts";
import { resolveDirectTools } from "../direct-tool-surface.ts";
import { computeServerHash, getMetadataCachePath, loadMetadataCache, saveMetadataCache } from "../metadata-cache.ts";
import { createPromptCommand } from "../prompts.ts";
import { executeCall, executeConnect, executeDescribe, executeSearch } from "../proxy-modes.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { McpServerManager } from "../server-manager.ts";
import type { ServerEntry } from "../types.ts";

const fs = vi.hoisted(() => ({ cacheWrites: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync = ((path: Parameters<typeof actual.writeFileSync>[0], ...rest: unknown[]) => {
    if (String(path).includes("mcp-cache.json")) fs.cacheWrites.push(String(path));
    return (actual.writeFileSync as (...args: unknown[]) => void)(path, ...rest);
  }) as typeof actual.writeFileSync;
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

const fixture = (file: string) => fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url));
const server = (id: string, extra: Partial<ServerEntry> = {}): ServerEntry =>
  ({ command: process.execPath, args: [fixture("prompts-server.mjs"), id], ...extra });

describe("startup discovery", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let dir: string;
  let connected: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-startup-discovery-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    fs.cacheWrites = [];
    connected = [];
    const connect = McpServerManager.prototype.connect;
    vi.spyOn(McpServerManager.prototype, "connect").mockImplementation(function (this: McpServerManager, name, ...rest) {
      connected.push(name);
      return connect.call(this, name, ...rest);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (mcpServers: Record<string, ServerEntry>, owner = createMcpRuntimeOwner()) => initializeMcp(
    { getFlag: vi.fn() } as any,
    { cwd: dir, hasUI: false, mode: "print", signal: new AbortController().signal } as any,
    owner,
    { config: { mcpServers } },
  );
  const text = (result: { content: { type: string; text?: string }[] }) => result.content.map(part => part.text ?? "").join("\n");

  it("saves discovered metadata in one write and stops plain lazy servers until they are used", async () => {
    // Another Pi process saves its own entry while this one is discovering.
    const otherEntry = { configHash: "other", tools: [], resources: [], cachedAt: Date.now() };
    const close = McpServerManager.prototype.close;
    vi.spyOn(McpServerManager.prototype, "close").mockImplementation(async function (this: McpServerManager, name) {
      if (!loadMetadataCache()?.servers.other) writeFileSync(getMetadataCachePath(), JSON.stringify({ version: 1, servers: { other: otherEntry } }));
      return close.call(this, name);
    });

    const state = await start({
      lazy: server("lazy", { directTools: true }),
      resident: server("resident", { lifecycle: "lazy-keep-alive" }),
      pinned: server("pinned", { idleTimeout: 0 }),
    });
    try {
      expect([...state.manager.getAllConnections()].map(([name, connection]) => [name, connection.status]).sort())
        .toEqual([["pinned", "connected"], ["resident", "connected"]]);
      expect(Object.keys(loadMetadataCache()!.servers).sort()).toEqual(["lazy", "other", "pinned", "resident"]);
      expect(fs.cacheWrites.filter(path => path !== getMetadataCachePath())).toHaveLength(1);

      // The stopped server's tools stay searchable, describable, and exposed as direct tools.
      expect(text(await executeSearch(state, "noop", undefined, "lazy"))).toContain("lazy_noop");
      expect(executeDescribe(state, "lazy_noop").content[0]!.text).toContain("lazy_noop");
      expect(resolveDirectTools(state.config, loadMetadataCache(), "server").map(spec => spec.prefixedName))
        .toEqual(["lazy_noop", "lazy_read_notes"]);

      // Each use starts it again.
      const sendUserMessage = vi.fn();
      const brief = state.promptMetadata.get("lazy")!.find(prompt => prompt.originalName === "brief")!;
      await createPromptCommand({ sendUserMessage } as any, () => state, brief).handler("mcp", { hasUI: false } as any);
      expect(sendUserMessage).toHaveBeenCalledWith("Give me the brief on mcp for today.");
      await state.manager.close("lazy");
      expect(text(await executeCall(state, "lazy_read_notes", {}))).toContain("notes body");
      await state.manager.close("lazy");
      expect(text(await executeCall(state, "lazy_noop", {}))).toBe("ok");
      expect(state.manager.getConnection("lazy")?.status).toBe("connected");
    } finally {
      await state.owner.stop("test cleanup");
    }
  });

  it("keeps an entry another session saved for the same server during discovery", async () => {
    const newer = { configHash: computeServerHash(server("lazy")), tools: [], resources: [], cachedAt: Date.now() + 60_000 };
    const close = McpServerManager.prototype.close;
    vi.spyOn(McpServerManager.prototype, "close").mockImplementation(async function (this: McpServerManager, name) {
      writeFileSync(getMetadataCachePath(), JSON.stringify({ version: 1, servers: { lazy: newer } }));
      return close.call(this, name);
    });

    const state = await start({ lazy: server("lazy") });
    await state.owner.stop("test cleanup");

    expect(loadMetadataCache()!.servers.lazy).toEqual(newer);
  });

  it("discovers only servers whose saved metadata is missing, stale, or past its declared TTL", async () => {
    const servers = {
      valid: server("valid"),
      missing: server("missing"),
      changed: server("changed"),
      expired: server("expired"),
      private: server("private"),
    };
    const entry = (name: keyof typeof servers, extra = {}) =>
      ({ configHash: computeServerHash(servers[name]), tools: [], resources: [], cachedAt: Date.now(), ...extra });
    saveMetadataCache({
      version: 1,
      servers: {
        valid: entry("valid"),
        changed: entry("changed", { configHash: "previous config" }),
        expired: entry("expired", { ttlMs: 1_000, cachedAt: Date.now() - 60_000 }),
        private: entry("private", { cacheScope: "private" }),
      },
    });

    const state = await start(servers);
    await state.owner.stop("test cleanup");

    expect(connected.sort()).toEqual(["changed", "expired", "missing"]);
  });

  it("tries a server that failed discovery once per config, until it connects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The server can't start until its script exists.
    const script = join(dir, "late-server.mjs");
    const flaky = { command: process.execPath, args: [script] };
    const changed = { ...flaky, args: [script, "changed"] };
    const session = async (definition: ServerEntry) => {
      connected = [];
      const state = await start({ flaky: definition });
      return { state, attempted: connected.includes("flaky") };
    };

    const first = await session(flaky);
    expect(first.attempted).toBe(true);
    expect(first.state.failureMessages.has("flaky")).toBe(true);
    await first.state.owner.stop("test cleanup");
    const second = await session(flaky);
    expect(second.attempted).toBe(false);
    await second.state.owner.stop("test cleanup");
    const third = await session(changed);
    expect(third.attempted).toBe(true);
    await third.state.owner.stop("test cleanup");

    writeFileSync(script, `await import(${JSON.stringify(fixture("prompts-server.mjs"))});\n`);
    const fourth = await session(changed);
    try {
      expect(fourth.attempted).toBe(false);
      expect(text(await executeConnect(fourth.state, "flaky"))).toContain("flaky_noop");
      expect(loadMetadataCache()!.servers.flaky).toMatchObject({ configHash: computeServerHash(changed), tools: [expect.objectContaining({ name: "noop" })] });
      expect(loadMetadataCache()!.servers.flaky!.discoveryFailed).toBeUndefined();
    } finally {
      await fourth.state.owner.stop("test cleanup");
    }
  });

  it("rediscovers every server when the cache file is corrupt", async () => {
    writeFileSync(getMetadataCachePath(), "{ not json");

    const state = await start({ first: server("first"), second: server("second") });
    await state.owner.stop("test cleanup");

    expect(connected.sort()).toEqual(["first", "second"]);
    expect(Object.keys(loadMetadataCache()!.servers).sort()).toEqual(["first", "second"]);
  });

  it("leaves nothing open and writes nothing when the runtime is replaced during discovery", async () => {
    const owner = createMcpRuntimeOwner();
    let manager: McpServerManager | undefined;
    const connect = McpServerManager.prototype.connect;
    vi.spyOn(McpServerManager.prototype, "connect").mockImplementation(async function (this: McpServerManager, name, ...rest) {
      manager = this;
      const connection = await connect.call(this, name, ...rest);
      void owner.stop("MCP extension session restarted");
      return connection;
    });

    await expect(start({ one: server("one"), two: server("two"), three: server("three", { lifecycle: "keep-alive" }) }, owner))
      .rejects.toThrow("MCP extension session restarted");
    await owner.stop();

    expect([...manager!.getAllConnections()]).toEqual([]);
    expect(existsSync(getMetadataCachePath())).toBe(false);
  });

  it("keeps saved prompts, resources, and output shapes when a startup listing fails", async () => {
    const definition: ServerEntry = { command: process.execPath, args: [fixture("catalog-failure-server.mjs")], lifecycle: "keep-alive" };
    const tool = { name: "list", description: "List things", inputSchema: { type: "object" } };
    const saved = {
      configHash: computeServerHash(definition),
      tools: [tool],
      resources: [{ uri: "file:///notes", name: "notes" }],
      prompts: [{ name: "brief" }],
      outputShapes: { list: { source: "structuredContent" as const, shape: { kind: "object", fields: {} } } },
      cachedAt: Date.now(),
    };
    saveMetadataCache({ version: 1, servers: { failing: saved } });

    const state = await start({ failing: definition });
    await state.owner.stop("test cleanup");

    expect(loadMetadataCache()!.servers.failing).toMatchObject({
      resources: saved.resources,
      prompts: saved.prompts,
      outputShapes: saved.outputShapes,
    });
  });
});
