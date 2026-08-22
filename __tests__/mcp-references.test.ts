import { describe, expect, it } from "vitest";
import { computeServerHash } from "../metadata-cache.ts";
import type { CachedTool, McpConfig, ServerEntry } from "../types.ts";
import { namespaceProxyName, parseMcpReference, resolveMcpToolReferences } from "../mcp-references.ts";

const cacheFor = (entries: Array<[string, { definition: ServerEntry; tools: CachedTool[]; cachedAt?: number; configHash?: string }]>) => ({
  version: 1,
  servers: Object.fromEntries(entries.map(([serverName, entry]) => [serverName, {
    configHash: entry.configHash ?? computeServerHash(entry.definition),
    cachedAt: entry.cachedAt ?? Date.now(),
    tools: entry.tools,
    resources: [],
  }])),
});

const cacheWithResources = (entries: Array<[string, { definition: ServerEntry; tools: CachedTool[]; resources: Array<{ name: string; uri: string }>; cachedAt?: number; configHash?: string }]>) => ({
  version: 1,
  servers: Object.fromEntries(entries.map(([serverName, entry]) => [serverName, {
    configHash: entry.configHash ?? computeServerHash(entry.definition),
    cachedAt: entry.cachedAt ?? Date.now(),
    tools: entry.tools,
    resources: entry.resources,
  }])),
});

const configFor = (mcpServers: Record<string, ServerEntry>, settings?: McpConfig["settings"]): McpConfig => ({
  mcpServers,
  ...(settings ? { settings } : {}),
});

describe("parseMcpReference", () => {
  it("parses server and server/tool references", () => {
    expect(parseMcpReference("mcp:context-mode")).toEqual({ raw: "mcp:context-mode", server: "context-mode" });
    expect(parseMcpReference("mcp:context-mode/query_docs")).toEqual({ raw: "mcp:context-mode/query_docs", server: "context-mode", tool: "query_docs" });
  });

  it("does not parse non-mcp references", () => {
    expect(parseMcpReference("read")).toEqual({ raw: "read" });
  });
});

describe("namespaceProxyName", () => {
  it("uses the runtime namespace proxy convention", () => {
    expect(namespaceProxyName("context-mode")).toBe("mcp__context_mode");
  });
});

describe("resolveMcpToolReferences", () => {
  it("expands direct server references from explicit config and cache", () => {
    const definition: ServerEntry = { command: "demo", directTools: true };
    const result = resolveMcpToolReferences(
      ["mcp:demo"],
      configFor({ demo: definition }),
      cacheFor([["demo", { definition, tools: [{ name: "search" }, { name: "fetch" }] }]]),
    );

    expect(result).toEqual({ names: ["demo_search", "demo_fetch"], diagnostics: [] });
  });

  it("resolves direct server/tool and bare registered-tool references", () => {
    const definition: ServerEntry = { command: "demo", directTools: true };
    const config = configFor({ demo: definition });
    const cache = cacheFor([["demo", { definition, tools: [{ name: "search" }] }]]);

    expect(resolveMcpToolReferences(["mcp:demo/search"], config, cache).names).toEqual(["demo_search"]);
    expect(resolveMcpToolReferences(["mcp:demo_search"], config, cache).names).toEqual(["demo_search"]);
  });

  it("resolves proxy-only server/tool references to the namespace proxy after validating the tool", () => {
    const definition: ServerEntry = { command: "demo" };
    const result = resolveMcpToolReferences(
      ["mcp:demo/demo_search"],
      configFor({ demo: definition }),
      cacheFor([["demo", { definition, tools: [{ name: "search" }] }]]),
    );

    expect(result).toEqual({ names: ["mcp__demo"], diagnostics: [] });
  });

  it("rejects unformatted proxy-only resource references", () => {
    const definition: ServerEntry = { command: "demo" };
    const result = resolveMcpToolReferences(
      ["mcp:demo/read_guide"],
      configFor({ demo: definition }),
      cacheWithResources([["demo", { definition, tools: [{ name: "search" }], resources: [{ name: "guide", uri: "file://guide" }] }]]),
    );

    expect(result.names).toEqual([]);
    expect(result.diagnostics[0]).toContain("unknown or hidden tool");
  });

  it("accepts formatted proxy resource references", () => {
    const definition: ServerEntry = { command: "demo" };
    const result = resolveMcpToolReferences(
      ["mcp:demo/demo_read_guide"],
      configFor({ demo: definition }),
      cacheWithResources([["demo", { definition, tools: [{ name: "search" }], resources: [{ name: "guide", uri: "file://guide" }] }]]),
    );

    expect(result).toEqual({ names: ["mcp__demo"], diagnostics: [] });
  });

  it("resolves proxy-only resource references when the server has no tools", () => {
    const definition: ServerEntry = { command: "demo" };
    const result = resolveMcpToolReferences(
      ["mcp:demo/demo_read_guide"],
      configFor({ demo: definition }),
      cacheWithResources([["demo", { definition, tools: [], resources: [{ name: "guide", uri: "file://guide" }] }]]),
    );

    expect(result).toEqual({ names: ["mcp__demo"], diagnostics: [] });
  });

  it("rejects unknown proxy-only server/tool references", () => {
    const definition: ServerEntry = { command: "demo" };
    const result = resolveMcpToolReferences(
      ["mcp:demo/missing"],
      configFor({ demo: definition }),
      cacheFor([["demo", { definition, tools: [{ name: "search" }] }]]),
    );

    expect(result.names).toEqual([]);
    expect(result.diagnostics[0]).toContain("unknown or hidden tool");
  });

  it("skips ambiguous namespace proxies with colliding normalized server names", () => {
    const first: ServerEntry = { command: "one" };
    const second: ServerEntry = { command: "two" };
    const config = configFor({ "my-server": first, my_server: second });
    const cache = cacheFor([
      ["my-server", { definition: first, tools: [{ name: "search" }] }],
      ["my_server", { definition: second, tools: [{ name: "search" }] }],
    ]);

    const result = resolveMcpToolReferences(["mcp:my-server", "mcp:my_server"], config, cache);

    expect(result.names).toEqual([]);
    expect(result.diagnostics).toHaveLength(2);
  });

  it("skips namespace proxies that collide with direct tool names", () => {
    const proxy: ServerEntry = { command: "proxy" };
    const direct: ServerEntry = { command: "direct", directTools: true, toolPrefix: "none" };
    const config = configFor({ proxy, direct });
    const cache = cacheFor([
      ["proxy", { definition: proxy, tools: [{ name: "search" }] }],
      ["direct", { definition: direct, tools: [{ name: "mcp__proxy" }] }],
    ]);

    const result = resolveMcpToolReferences(["mcp:proxy"], config, cache);

    expect(result.names).toEqual([]);
    expect(result.diagnostics[0]).toContain("no registered tool");
  });

  it("rejects server-qualified direct references that lose duplicate-name ownership", () => {
    const first: ServerEntry = { command: "first", directTools: true, toolPrefix: "none" };
    const second: ServerEntry = { command: "second", directTools: true, toolPrefix: "none" };
    const config = configFor({ first, second });
    const cache = cacheFor([
      ["first", { definition: first, tools: [{ name: "get" }] }],
      ["second", { definition: second, tools: [{ name: "get" }] }],
    ]);

    expect(resolveMcpToolReferences(["mcp:first/get"], config, cache).names).toEqual(["get"]);
    const result = resolveMcpToolReferences(["mcp:second/get"], config, cache);
    expect(result.names).toEqual([]);
    expect(result.diagnostics[0]).toContain("no registered tool");
  });

  it("requires valid cache entries", () => {
    const definition: ServerEntry = { command: "demo", directTools: true };
    const result = resolveMcpToolReferences(
      ["mcp:demo"],
      configFor({ demo: definition }),
      cacheFor([["demo", { definition, configHash: "stale", tools: [{ name: "search" }] }]]),
    );

    expect(result.names).toEqual([]);
    expect(result.diagnostics[0]).toContain("no valid cached metadata");
  });

  it("keeps a proxy namespace when MCP_DIRECT_TOOLS selects only one tool", () => {
    const definition: ServerEntry = { command: "demo" };
    const config = configFor({ demo: definition });
    const cache = cacheFor([["demo", { definition, tools: [{ name: "search" }, { name: "fetch" }] }]]);

    expect(resolveMcpToolReferences(["mcp:demo/search"], config, cache, ["demo/search"]).names).toEqual(["demo_search"]);
    expect(resolveMcpToolReferences(["mcp:demo/demo_fetch"], config, cache, ["demo/search"]).names).toEqual(["mcp__demo"]);
  });

  it("keeps a proxy namespace for unselected tools when env override narrows a directTools server", () => {
    const definition: ServerEntry = { command: "demo", directTools: true };
    const config = configFor({ demo: definition });
    const cache = cacheFor([["demo", { definition, tools: [{ name: "search" }, { name: "fetch" }] }]]);

    expect(resolveMcpToolReferences(["mcp:demo/search"], config, cache, ["demo/search"]).names).toEqual(["demo_search"]);
    expect(resolveMcpToolReferences(["mcp:demo/demo_fetch"], config, cache, ["demo/search"]).names).toEqual(["mcp__demo"]);
  });

  it("rejects direct references that collide with builtin tool names", () => {
    const definition: ServerEntry = { command: "demo", directTools: true, toolPrefix: "none" };
    const result = resolveMcpToolReferences(
      ["mcp:demo/bash"],
      configFor({ demo: definition }),
      cacheFor([["demo", { definition, tools: [{ name: "bash" }] }]]),
    );

    expect(result.names).toEqual([]);
    expect(result.diagnostics[0]).toContain("no registered tool");
  });

  it("rejects raw tool names that lost a same-name direct registration collision", () => {
    const definition: ServerEntry = { command: "demo", directTools: true };
    const config = configFor({ demo: definition });
    const cache = cacheFor([["demo", { definition, tools: [{ name: "namespace.tool" }, { name: "namespace_tool" }] }]]);

    expect(resolveMcpToolReferences(["mcp:demo/namespace.tool"], config, cache).names).toEqual(["demo_namespace_tool"]);
    const result = resolveMcpToolReferences(["mcp:demo/namespace_tool"], config, cache);
    expect(result.names).toEqual([]);
    expect(result.diagnostics[0]).toContain("no registered tool");
  });

  it("passes non-mcp references through and deduplicates names", () => {
    const definition: ServerEntry = { command: "demo" };
    const result = resolveMcpToolReferences(
      ["read", "mcp:demo", "mcp:demo/demo_search", "read"],
      configFor({ demo: definition }),
      cacheFor([["demo", { definition, tools: [{ name: "search" }] }]]),
    );

    expect(result.names).toEqual(["read", "mcp__demo"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("is exported from the package entrypoint", async () => {
    const mod = await import("../index.ts");

    expect(mod.namespaceProxyName("context-mode")).toBe("mcp__context_mode");
    expect(mod.parseMcpReference("mcp:demo/search")).toEqual({ raw: "mcp:demo/search", server: "demo", tool: "search" });
    expect(typeof mod.resolveMcpToolReferences).toBe("function");
  });
});
