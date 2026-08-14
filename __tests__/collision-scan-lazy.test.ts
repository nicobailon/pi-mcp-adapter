import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getToolNameCandidates,
  type MetadataCache,
  type McpConfig,
  type ServerCacheEntry,
  type ServerEntry,
} from "../types.ts";
import { buildProxyDescription, resolveDirectTools } from "../direct-tools.ts";
import { computeServerHash, reconstructToolMetadata } from "../metadata-cache.ts";
import { buildToolMetadata } from "../tool-metadata.ts";

// Intercept the only function the cross-server collision scan calls. Because
// every conflicting-candidate set ultimately flows through
// `getToolNameCandidates`, asserting it is never invoked is a deterministic
// proof that the O(tools²) scan was skipped (not merely fast).
vi.mock("../types.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../types.ts")>();
  return {
    ...actual,
    getToolNameCandidates: vi.fn(actual.getToolNameCandidates),
  };
});

const mockedGetToolNameCandidates = vi.mocked(getToolNameCandidates);

function makeServer(name: string, extra: Partial<ServerEntry> = {}): ServerEntry {
  return { command: `demo-${name}`, ...extra };
}

function makeCacheEntry(definition: ServerEntry, tools: { name: string; description: string }[]): ServerCacheEntry {
  return {
    configHash: computeServerHash(definition),
    cachedAt: Date.now(),
    tools,
    resources: [],
  };
}

function makeTwoServerConfig(filters: Partial<ServerEntry> = {}): { config: McpConfig; cache: MetadataCache } {
  const a = makeServer("a", filters);
  const b = makeServer("b");
  const config: McpConfig = { mcpServers: { a, b } };
  const cache: MetadataCache = {
    version: 1,
    servers: {
      a: makeCacheEntry(a, [{ name: "search", description: "Search" }]),
      b: makeCacheEntry(b, [{ name: "search", description: "Search" }]),
    },
  };
  return { config, cache };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cross-server collision scan is skipped without tool filters", () => {
  it("buildProxyDescription does not generate candidates without filters", () => {
    const { config, cache } = makeTwoServerConfig();
    buildProxyDescription(config, cache, []);
    expect(mockedGetToolNameCandidates).not.toHaveBeenCalled();
  });

  it("buildProxyDescription generates candidates when excludeTools is configured", () => {
    const { config, cache } = makeTwoServerConfig({ excludeTools: ["a_search"] });
    buildProxyDescription(config, cache, []);
    expect(mockedGetToolNameCandidates).toHaveBeenCalled();
  });

  it("resolveDirectTools does not generate candidates without filters", () => {
    const definition = makeServer("a", { directTools: true });
    const config: McpConfig = { mcpServers: { a: definition } };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        a: makeCacheEntry(definition, [{ name: "search", description: "Search" }]),
      },
    };
    resolveDirectTools(config, cache, "server");
    expect(mockedGetToolNameCandidates).not.toHaveBeenCalled();
  });

  it("resolveDirectTools generates candidates when includeTools is configured", () => {
    const definition = makeServer("a", { directTools: true, includeTools: ["a_search"] });
    const other = makeServer("b");
    const config: McpConfig = { mcpServers: { a: definition, b: other } };
    const cache: MetadataCache = {
      version: 1,
      servers: {
        a: makeCacheEntry(definition, [{ name: "search", description: "Search" }]),
        b: makeCacheEntry(other, [{ name: "search", description: "Search" }]),
      },
    };
    resolveDirectTools(config, cache, "server");
    expect(mockedGetToolNameCandidates).toHaveBeenCalled();
  });

  it("reconstructToolMetadata does not generate candidates without filters", () => {
    const { config, cache } = makeTwoServerConfig();
    reconstructToolMetadata("a", cache.servers.a, "server", config.mcpServers.a, config.mcpServers, cache);
    expect(mockedGetToolNameCandidates).not.toHaveBeenCalled();
  });

  it("reconstructToolMetadata generates candidates when excludeTools is configured", () => {
    const { config, cache } = makeTwoServerConfig({ excludeTools: ["a_search"] });
    reconstructToolMetadata("a", cache.servers.a, "server", config.mcpServers.a, config.mcpServers, cache);
    expect(mockedGetToolNameCandidates).toHaveBeenCalled();
  });

  it("buildToolMetadata does not generate candidates without filters", () => {
    const { config, cache } = makeTwoServerConfig();
    buildToolMetadata(
      cache.servers.a.tools,
      [],
      config.mcpServers.a,
      "a",
      "server",
      config.mcpServers,
    );
    expect(mockedGetToolNameCandidates).not.toHaveBeenCalled();
  });

  it("buildToolMetadata generates candidates when excludeTools is configured", () => {
    const { config, cache } = makeTwoServerConfig({ excludeTools: ["a_search"] });
    buildToolMetadata(
      cache.servers.a.tools,
      [],
      config.mcpServers.a,
      "a",
      "server",
      config.mcpServers,
    );
    expect(mockedGetToolNameCandidates).toHaveBeenCalled();
  });
});
