import { describe, expect, it, vi } from "vitest";
import {
  resolveMcpToolReferences,
  parseMcpReference,
  isProxyOnlyServer,
  namespaceProxyName,
  createMcpRefResolver,
  type McpConfig,
  type MetadataCache,
} from "../mcp-references.ts";

function makeCache(): MetadataCache {
  return {
    version: 1,
    servers: {
      context7: {
        configHash: "h",
        cachedAt: Date.now(),
        tools: [{ name: "resolve_library_id" }, { name: "query_docs" }],
        resources: [],
      },
      deepwiki: {
        configHash: "h",
        cachedAt: Date.now(),
        tools: [{ name: "ask_question" }, { name: "read_wiki_contents" }],
        resources: [],
      },
      "context-mode": {
        configHash: "h",
        cachedAt: Date.now(),
        tools: [{ name: "ctx_execute" }, { name: "ctx_search" }],
        resources: [],
      },
    },
  };
}

function makeConfig(): McpConfig {
  return {
    mcpServers: {
      context7: { url: "https://mcp.context7.com/mcp", directTools: true },
      deepwiki: { url: "https://mcp.deepwiki.com/mcp", directTools: true },
      "context-mode": { command: "context-mode", lifecycle: "eager" },
    },
  };
}

describe("parseMcpReference", () => {
  it("returns empty for a bare mcp: with no server", () => {
    expect(parseMcpReference("mcp:")).toEqual({ raw: "mcp:" });
  });

  it("parses server-level reference", () => {
    expect(parseMcpReference("mcp:context7")).toEqual({ raw: "mcp:context7", server: "context7" });
  });

  it("parses server/tool reference", () => {
    expect(parseMcpReference("mcp:context7/query_docs")).toEqual({
      raw: "mcp:context7/query_docs",
      server: "context7",
      tool: "query_docs",
    });
  });

  it("does not treat a non-mcp reference as mcp", () => {
    expect(parseMcpReference("read")).toEqual({ raw: "read" });
  });
});

describe("isProxyOnlyServer", () => {
  it("is false for directTools: true", () => {
    expect(isProxyOnlyServer("context7", { directTools: true }, undefined)).toBe(false);
  });

  it("is true when directTools is unset and no global directTools", () => {
    expect(isProxyOnlyServer("context-mode", {}, undefined)).toBe(true);
  });

  it("is false when global directTools is true", () => {
    expect(isProxyOnlyServer("context-mode", {}, { directTools: true })).toBe(false);
  });

  it("is false when envOverride marks the server direct (D5)", () => {
    const env = { servers: new Set(["context-mode"]), tools: new Map() };
    expect(isProxyOnlyServer("context-mode", {}, undefined, env)).toBe(false);
  });

  it("is true when envOverride does not mention the server", () => {
    const env = { servers: new Set(["other-server"]), tools: new Map() };
    expect(isProxyOnlyServer("context-mode", {}, undefined, env)).toBe(true);
  });
});

describe("namespaceProxyName", () => {
  it("formats server name with mcp__ prefix and simple underscores (D4)", () => {
    expect(namespaceProxyName("context-mode")).toBe("mcp__context_mode");
    expect(namespaceProxyName("my-server-1")).toBe("mcp__my_server_1");
    expect(namespaceProxyName("context7")).toBe("mcp__context7");
  });
});

describe("resolveMcpToolReferences", () => {
  const cache = makeCache();
  const config = makeConfig();

  it("expands a server-level reference to all its tools", () => {
    const r = resolveMcpToolReferences(["mcp:context7"], config, cache);
    expect(r.names).toEqual(["context7_resolve_library_id", "context7_query_docs"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("resolves a specific server/tool reference", () => {
    const r = resolveMcpToolReferences(["mcp:context7/query_docs"], config, cache);
    expect(r.names).toEqual(["context7_query_docs"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("resolves a bare tool reference to its owning direct server tool", () => {
    const r = resolveMcpToolReferences(["mcp:ask_question"], config, cache);
    expect(r.names).toEqual(["deepwiki_ask_question"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("resolves a bare tool on a proxy-only server to the namespace-proxy name", () => {
    const r = resolveMcpToolReferences(["mcp:ctx_execute"], config, cache);
    expect(r.names).toEqual(["mcp__context_mode"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("resolves a server-level reference on a proxy-only server to its namespace-proxy name", () => {
    const r = resolveMcpToolReferences(["mcp:context-mode"], config, cache);
    expect(r.names).toEqual(["mcp__context_mode"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("passes non-mcp references through unchanged", () => {
    const r = resolveMcpToolReferences(["read", "grep"], config, cache);
    expect(r.names).toEqual(["read", "grep"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("deduplicates across references", () => {
    const r = resolveMcpToolReferences(["mcp:context7", "mcp:context7/query_docs"], config, cache);
    expect(r.names).toEqual(["context7_resolve_library_id", "context7_query_docs"]);
  });

  it("emits a diagnostic for an unknown server", () => {
    const r = resolveMcpToolReferences(["mcp:does-not-exist"], config, cache);
    expect(r.names).toEqual([]);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it("emits a diagnostic for an unknown tool on a known server", () => {
    const r = resolveMcpToolReferences(["mcp:context7/nope"], config, cache);
    expect(r.names).toEqual([]);
    expect(r.diagnostics.join(" ")).toContain("unknown tool");
  });

  it("returns a diagnostic when config is missing", () => {
    const r = resolveMcpToolReferences(["mcp:context7"], null, cache);
    expect(r.names).toEqual([]);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it("emits a diagnostic when a server has no cache metadata", () => {
    const r = resolveMcpToolReferences(["mcp:context7"], config, { version: 1, servers: {} });
    expect(r.names).toEqual([]);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it("expands directTools with the native toolPrefix name for dashed servers (D4)", () => {
    const cfg: McpConfig = {
      mcpServers: {
        "context-mode": { command: "context-mode", directTools: true, toolPrefix: "mcp" },
      },
      settings: {},
    };
    const c: MetadataCache = {
      version: 1,
      servers: {
        "context-mode": {
          configHash: "h",
          cachedAt: Date.now(),
          tools: [{ name: "ctx_execute" }],
          resources: [],
        },
      },
    };
    // The adapter registers direct tools as formatToolName(tool, server, "mcp")
    // which KEEPS hyphens in dashed server names → mcp__context-mode_ctx_execute
    // (the native sanitizeServerPrefix preserves `-`; NOT _2d_ encoding, and not
    // the old harness copy which replaced `-` with `_`).
    const r = resolveMcpToolReferences(["mcp:context-mode"], cfg, c);
    expect(r.names).toEqual(["mcp__context-mode_ctx_execute"]);
  });

  it("resolves direct names instead of the proxy name when envOverride marks the server direct (D5)", () => {
    const env = { servers: new Set(["context-mode"]), tools: new Map() };
    const r = resolveMcpToolReferences(["mcp:context-mode"], config, cache, env);
    // context-mode is proxy-only in config but forced direct by env; the
    // resolver must expand its cache tools like a direct server (native
    // formatToolName keeps the dash), NOT return mcp__context_mode.
    expect(r.names).toEqual(["context-mode_ctx_execute", "context-mode_ctx_search"]);
    expect(r.names).not.toContain("mcp__context_mode");
    expect(r.diagnostics).toEqual([]);
  });
});

describe("createMcpRefResolver", () => {
  function makeDeps(config: McpConfig | null, cache: MetadataCache | null) {
    return {
      loadConfig: vi.fn(() => config),
      loadCache: vi.fn(() => cache),
      envDirectTools: undefined,
    };
  }

  it("returns [] for mcp: references when config is null", () => {
    const deps = makeDeps(null, makeCache());
    const resolve = createMcpRefResolver(undefined, deps);
    expect(resolve("mcp:context7")).toEqual([]);
  });

  it("passes non-mcp references through unchanged", () => {
    const deps = makeDeps(makeConfig(), makeCache());
    const resolve = createMcpRefResolver(undefined, deps);
    expect(resolve("read")).toEqual(["read"]);
    expect(resolve("grep")).toEqual(["grep"]);
  });

  it("memoizes config/cache loading across calls", () => {
    const deps = makeDeps(makeConfig(), makeCache());
    const resolve = createMcpRefResolver(undefined, deps);
    resolve("mcp:context7");
    resolve("mcp:context7");
    expect(deps.loadConfig).toHaveBeenCalledTimes(1);
    expect(deps.loadCache).toHaveBeenCalledTimes(1);
  });

  it("returns [] when config load throws and retries on next call", () => {
    const loadConfig = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => makeConfig());
    const deps = makeDeps(makeConfig(), makeCache());
    deps.loadConfig = loadConfig;
    const resolve = createMcpRefResolver(undefined, deps);
    expect(resolve("mcp:context7")).toEqual([]);
    // Next call retries (no negative memoization of exceptions).
    expect(resolve("mcp:context7")).toEqual(["context7_resolve_library_id", "context7_query_docs"]);
    expect(loadConfig).toHaveBeenCalledTimes(2);
  });
});

describe("public export smoke (index.ts)", () => {
  it("re-exports the resolution API from the package entrypoint", async () => {
    const mod = await import("../index.ts");
    expect(typeof mod.resolveMcpToolReferences).toBe("function");
    expect(typeof mod.createMcpRefResolver).toBe("function");
    expect(typeof mod.namespaceProxyName).toBe("function");
    expect(typeof mod.parseMcpReference).toBe("function");
    expect(typeof mod.isProxyOnlyServer).toBe("function");
    expect(typeof mod.loadMcpConfig).toBe("function");
    expect(typeof mod.loadMetadataCache).toBe("function");
  });
});