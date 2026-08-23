import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeServerHash } from "../metadata-cache.ts";
import type { ServerEntry } from "../types.ts";

const CACHE_SHAPE = (entries: Array<[string, { tools: Array<{ name: string }>; resources?: Array<{ name: string; uri: string }>; definition?: ServerEntry; configHash?: string; cachedAt?: number }]>) => ({
  version: 1,
  servers: Object.fromEntries(entries.map(([server, v]) => [server, {
    tools: v.tools,
    resources: v.resources ?? [],
    configHash: v.configHash ?? computeServerHash(v.definition ?? { command: server }),
    cachedAt: v.cachedAt ?? Date.now(),
  }])),
});

function makePi() {
  type RegisteredTool = { name: string; label?: string; execute: (...args: unknown[]) => unknown; parameters?: unknown };
  const registered = new Map<string, RegisteredTool>();
  const unregistered: string[] = [];
  const api = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      registered.set(tool.name, tool);
    }),
    unregisterTool: vi.fn((name: string) => {
      const had = registered.has(name);
      registered.delete(name);
      if (had) unregistered.push(name);
      return had;
    }),
  };
  return { pi: api as unknown as ExtensionAPI, registered, unregistered };
}

async function importSync() {
  const mod = await import("../namespace-tools.ts");
  return {
    syncNamespaceProxyTools: mod.syncNamespaceProxyTools,
    namespaceProxyName: mod.namespaceProxyName,
  };
}

describe("namespaceProxyName", () => {
  it("replaces hyphens with underscores in server names", async () => {
    const { namespaceProxyName } = await importSync();
    expect(namespaceProxyName("context-mode")).toBe("mcp__context_mode");
    expect(namespaceProxyName("chrome-devtools")).toBe("mcp__chrome_devtools");
    expect(namespaceProxyName("foo")).toBe("mcp__foo");
  });

  it("matches the harness _shared/mcp-tools resolver contract", async () => {
    const { namespaceProxyName } = await importSync();
    expect(namespaceProxyName("context-mode")).toBe("mcp__context_mode");
    expect(namespaceProxyName("my-server-1")).toBe("mcp__my_server_1");
  });
});

describe("syncNamespaceProxyTools", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers mcp__<server> for each proxy-only server with metadata", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode", lifecycle: "eager" } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }] }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context_mode")).toBe(true);
    const tool = registered.get("mcp__context_mode")!;
    expect(tool.execute).toBeTypeOf("function");
  });

  it("registers proxy-only servers that expose only resources", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { docs: { command: "docs" } } },
      cache: CACHE_SHAPE([["docs", { tools: [], resources: [{ name: "guide", uri: "file://guide" }] }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__docs")).toBe(true);
  });

  it("does NOT register for directTools: true servers (avoids duplicating direct tools)", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { context7: { url: "https://mcp.context7.com/mcp", directTools: true } } },
      cache: CACHE_SHAPE([["context7", { tools: [{ name: "query_docs" }], definition: { url: "https://mcp.context7.com/mcp", directTools: true } }]]),
      envOverride: null,
      existingDirectNames: new Set(["context7_query_docs"]),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context7")).toBe(false);
  });

  it("skips disabled servers", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode", disabled: true } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }] }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context_mode")).toBe(false);
  });

  it("skips servers with no metadata in the cache", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode" } } },
      cache: { version: 1, servers: {} },
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context_mode")).toBe(false);
  });

  it("skips servers with stale cache metadata", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode" } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }], configHash: "stale" }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context_mode")).toBe(false);
  });

  it("skips servers that are forced direct by MCP_DIRECT_TOOLS env override", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode" } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }] }]]),
      envOverride: { servers: new Set(["context-mode"]), tools: new Map() },
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context_mode")).toBe(false);
  });

  it("keeps the namespace proxy when a per-tool env selector does not resolve a direct tool", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode", directTools: true } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }] }]]),
      envOverride: { servers: new Set(), tools: new Map([["context-mode", new Set(["missing_tool"]) ]]) },
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context_mode")).toBe(true);
  });

  it("registers configured direct servers as namespaces when an empty env override disables direct tools", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { context7: { command: "context7", directTools: true } } },
      cache: CACHE_SHAPE([["context7", { tools: [{ name: "query_docs" }] }]]),
      envOverride: { servers: new Set(), tools: new Map() },
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context7")).toBe(true);
  });

  it("registers omitted configured direct servers when env selects another server", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { context7: { command: "context7", directTools: true }, other: { command: "other" } } },
      cache: CACHE_SHAPE([
        ["context7", { tools: [{ name: "query_docs" }] }],
        ["other", { tools: [{ name: "search" }] }],
      ]),
      envOverride: { servers: new Set(["other"]), tools: new Map() },
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context7")).toBe(true);
    expect(registered.has("mcp__other")).toBe(false);
  });

  it("exposes a `tool` and optional `args` parameter schema for dispatch", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode" } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }] }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    const tool = registered.get("mcp__context_mode")!;
    expect(tool.parameters).toBeDefined();
    expect(tool.parameters).toMatchObject({
      properties: {
        tool: expect.anything(),
        args: expect.anything(),
      },
    });
  });

  it("skips registration when an existing direct tool already uses mcp__<server>", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode" } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }] }]]),
      envOverride: null,
      existingDirectNames: new Set(["mcp__context_mode"]),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.size).toBe(0);
  });

  it("deactivates stale entries between syncs (server removed from config)", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered, unregistered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode" } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }] }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });
    expect(registered.has("mcp__context_mode")).toBe(true);

    syncNamespaceProxyTools({
      config: { mcpServers: {} },
      cache: { version: 1, servers: {} },
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(["mcp__context_mode"]),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(unregistered).toContain("mcp__context_mode");
  });

  it("deactivates stale namespace proxies when hidden direct tools reserve their names", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered, unregistered } = makePi();
    pi.registerTool({ name: "mcp__demo_search", execute: vi.fn() });

    syncNamespaceProxyTools({
      config: { mcpServers: {} },
      cache: { version: 1, servers: {} },
      envOverride: null,
      existingDirectNames: new Set(["mcp__demo_search"]),
      existingNamespaceNames: new Set(["mcp__demo_search"]),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__demo_search")).toBe(false);
    expect(unregistered).toContain("mcp__demo_search");
  });

  it("keeps active direct tools when they replace stale namespace proxy names", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered, unregistered } = makePi();
    pi.registerTool({ name: "mcp__demo_search", execute: vi.fn() });

    syncNamespaceProxyTools({
      config: { mcpServers: {} },
      cache: { version: 1, servers: {} },
      envOverride: null,
      existingDirectNames: new Set(["mcp__demo_search"]),
      activeDirectNames: new Set(["mcp__demo_search"]),
      existingNamespaceNames: new Set(["mcp__demo_search"]),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__demo_search")).toBe(true);
    expect(unregistered).not.toContain("mcp__demo_search");
  });

  it("removes stale namespace proxies from active tools without unregisterTool", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();
    delete pi.unregisterTool;
    let activeTools = ["bash", "mcp__context_mode"];
    pi.getActiveTools = vi.fn(() => activeTools);
    pi.setActiveTools = vi.fn((nextActiveTools: string[]) => { activeTools = nextActiveTools; });
    registered.set("mcp__context_mode", { name: "mcp__context_mode", execute: vi.fn() });

    const result = syncNamespaceProxyTools({
      config: { mcpServers: {} },
      cache: { version: 1, servers: {} },
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(["mcp__context_mode"]),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(result.deactivated).toEqual(["mcp__context_mode"]);
    expect(pi.setActiveTools).toHaveBeenCalledWith(["bash"]);
    expect(activeTools).toEqual(["bash"]);
  });

  it("skips colliding normalized server names without choosing by config order", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    syncNamespaceProxyTools({
      config: { mcpServers: { "my-server": { command: "one" }, my_server: { command: "two" } } },
      cache: CACHE_SHAPE([
        ["my-server", { tools: [{ name: "one" }], definition: { command: "one" } }],
        ["my_server", { tools: [{ name: "two" }], definition: { command: "two" } }],
      ]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__my_server")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('servers "my-server", "my_server" normalize to the same name'));
  });

  it("keeps namespace collisions reserved when one server is in backoff", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    syncNamespaceProxyTools({
      config: { mcpServers: { "my-server": { command: "one" }, my_server: { command: "two" } } },
      cache: CACHE_SHAPE([
        ["my-server", { tools: [{ name: "one" }], definition: { command: "one" } }],
        ["my_server", { tools: [{ name: "two" }], definition: { command: "two" } }],
      ]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      unavailableServers: new Set(["my-server"]),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__my_server")).toBe(false);
  });

  it("registers a new server and keeps existing ones in a single sync", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: {
        mcpServers: {
          "context-mode": { command: "context-mode" },
          "context7": { url: "https://mcp.context7.com/mcp" },
        },
      },
      cache: CACHE_SHAPE([
        ["context-mode", { tools: [{ name: "ctx_execute" }] }],
        ["context7", { tools: [{ name: "query_docs" }], definition: { url: "https://mcp.context7.com/mcp" } }],
      ]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(registered.has("mcp__context_mode")).toBe(true);
    expect(registered.has("mcp__context7")).toBe(true);
  });

  it("reports existing namespace proxies as updated", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi } = makePi();

    const result = syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode" } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }] }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(["mcp__context_mode"]),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(result.added).toEqual([]);
    expect(result.updated).toEqual(["mcp__context_mode"]);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
  });

  it("refreshes same-name namespace proxies after server replacement", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "my-server": { command: "one" } } },
      cache: CACHE_SHAPE([["my-server", { tools: [{ name: "one" }], definition: { command: "one" } }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });
    const result = syncNamespaceProxyTools({
      config: { mcpServers: { my_server: { command: "two" } } },
      cache: CACHE_SHAPE([["my_server", { tools: [{ name: "two" }], definition: { command: "two" } }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(["mcp__my_server"]),
      pi,
      getState: () => null,
      getInitPromise: () => null,
      getPiTools: () => [],
    });

    expect(result.updated).toEqual(["mcp__my_server"]);
    expect(pi.registerTool).toHaveBeenCalledTimes(2);
    expect(registered.get("mcp__my_server")?.label).toBe("MCP: my_server");
  });

  it("preserves initialization error context", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { "context-mode": { command: "context-mode" } } },
      cache: CACHE_SHAPE([["context-mode", { tools: [{ name: "ctx_execute" }] }]]),
      envOverride: null,
      existingDirectNames: new Set(),
      existingNamespaceNames: new Set(),
      pi,
      getState: () => null,
      getInitPromise: () => Promise.reject(new Error("bad config")),
      getPiTools: () => [],
    });

    const result = await registered.get("mcp__context_mode")!.execute("call-1", { tool: "ctx_execute" }, undefined);
    expect(result).toMatchObject({
      content: [{ text: "MCP initialization failed for context-mode: bad config" }],
      details: { error: "init_failed", server: "context-mode", message: "bad config" },
    });
  });
});
