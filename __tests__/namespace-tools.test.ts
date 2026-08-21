import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the namespace-proxy tool registration logic.
 *
 * `syncNamespaceProxyTools` is the focused, side-effect-free function
 * (aside from the injected `pi.registerTool`) that the adapter calls from
 * `syncToolSurface`. We test it directly to keep the surface tight; the
 * existing `index-lifecycle.test.ts` covers the full adapter boot.
 */

const CACHE_SHAPE = (entries: Array<[string, { tools: Array<{ name: string }> }]>) => ({
  version: 1,
  servers: Object.fromEntries(entries.map(([server, v]) => [server, { tools: v.tools, configHash: "h", cachedAt: Date.now() }])),
});

function makePi() {
  const registered = new Map<string, { name: string; execute: (...args: any[]) => unknown; parameters?: unknown }>();
  const unregistered: string[] = [];
  const api = {
    registerTool: vi.fn((tool: { name: string; execute: (...args: any[]) => unknown; parameters?: unknown }) => {
      registered.set(tool.name, tool);
    }),
    unregisterTool: vi.fn((name: string) => {
      const had = registered.has(name);
      registered.delete(name);
      if (had) unregistered.push(name);
      return had;
    }),
  };
  return { pi: api as any, registered, unregistered };
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
    // The harness resolver produces `mcp__<server-with-dashes-as-underscores>`
    // and validates against it. The fork must produce the same string.
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

  it("does NOT register for directTools: true servers (avoids duplicating direct tools)", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: { mcpServers: { context7: { url: "https://mcp.context7.com/mcp", directTools: true } } },
      cache: CACHE_SHAPE([["context7", { tools: [{ name: "query_docs" }] }]]),
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
    const props = (tool.parameters as any).properties;
    expect(props.tool).toBeDefined();
    expect(props.args).toBeDefined();
  });

  it("skips registration when an existing direct tool already uses mcp__<server>", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    // Edge case: a directTool is named "mcp__context_mode" (very unlikely but possible
    // if the user defined directTools: ["mcp__context_mode"] on a server). We must
    // not double-register the same name.
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

    // First sync: register context-mode.
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

    // Second sync: context-mode is gone, but the previous names list still
    // includes the now-stale mcp__context_mode. Caller passes the union of
    // previously-registered names so we can deactivate.
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

  it("does not deactivate direct tools while cleaning stale namespace proxies", async () => {
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
        ["my-server", { tools: [{ name: "one" }] }],
        ["my_server", { tools: [{ name: "two" }] }],
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

  it("registers a new server and keeps existing ones in a single sync", async () => {
    const { syncNamespaceProxyTools } = await importSync();
    const { pi, registered } = makePi();

    syncNamespaceProxyTools({
      config: {
        mcpServers: {
          "context-mode": { command: "context-mode" },
          "context7": { url: "https://mcp.context7.com/mcp" }, // proxy-only (no directTools)
        },
      },
      cache: CACHE_SHAPE([
        ["context-mode", { tools: [{ name: "ctx_execute" }] }],
        ["context7", { tools: [{ name: "query_docs" }] }],
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
});
