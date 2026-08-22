import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getToolNameCandidates,
  type MetadataCache,
  type McpConfig,
  type ServerCacheEntry,
  type ServerEntry,
} from "../types.ts";
import { buildProxyDescription, resolveDirectTools } from "../direct-tools.ts";
import { computeServerHash, createCachedToolSelectorCandidateIndex, reconstructToolMetadata } from "../metadata-cache.ts";
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

function makeLargeFilteredConfig(toolCount: number, extra: Partial<ServerEntry> = {}): { config: McpConfig; cache: MetadataCache } {
  const definition = makeServer("a", { includeTools: ["*"], ...extra });
  const config: McpConfig = { mcpServers: { a: definition } };
  const tools = Array.from({ length: toolCount }, (_, index) => ({
    name: `tool_${index}`,
    description: `Tool ${index}`,
  }));
  return {
    config,
    cache: {
      version: 1,
      servers: { a: makeCacheEntry(definition, tools) },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cross-server collision scan is skipped without tool filters", () => {
  it("buildProxyDescription never generates candidates — it is config-pure", () => {
    const { config } = makeLargeFilteredConfig(40);
    buildProxyDescription(config);
    expect(mockedGetToolNameCandidates).not.toHaveBeenCalled();
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

  it("resolveDirectTools builds filtered candidates once", () => {
    const { config, cache } = makeLargeFilteredConfig(40, { directTools: true });
    resolveDirectTools(config, cache, "server");
    expect(mockedGetToolNameCandidates).toHaveBeenCalledTimes(40);
  });

  it("reconstructToolMetadata does not generate candidates without filters", () => {
    const { config, cache } = makeTwoServerConfig();
    reconstructToolMetadata("a", cache.servers.a, "server", config.mcpServers.a, config.mcpServers, cache);
    expect(mockedGetToolNameCandidates).not.toHaveBeenCalled();
  });

  it("reconstructToolMetadata builds filtered candidates once", () => {
    const { config, cache } = makeLargeFilteredConfig(40);
    reconstructToolMetadata("a", cache.servers.a, "server", config.mcpServers.a, config.mcpServers, cache);
    expect(mockedGetToolNameCandidates).toHaveBeenCalledTimes(40);
  });

  it("reuses cached candidates across filtered server reconstruction", () => {
    const a = makeServer("a", { includeTools: ["*"] });
    const b = makeServer("b", { includeTools: ["*"] });
    const tools = Array.from({ length: 20 }, (_, index) => ({ name: `tool_${index}`, description: `Tool ${index}` }));
    const config: McpConfig = { mcpServers: { a, b } };
    const cache: MetadataCache = {
      version: 1,
      servers: { a: makeCacheEntry(a, tools), b: makeCacheEntry(b, tools) },
    };
    const selectorCandidateIndex = createCachedToolSelectorCandidateIndex(config.mcpServers, cache, "server");

    reconstructToolMetadata("a", cache.servers.a, "server", a, config.mcpServers, cache, selectorCandidateIndex);
    reconstructToolMetadata("b", cache.servers.b, "server", b, config.mcpServers, cache, selectorCandidateIndex);

    expect(mockedGetToolNameCandidates).toHaveBeenCalledTimes(40);
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

  it("buildToolMetadata builds filtered candidates once", () => {
    const { config, cache } = makeLargeFilteredConfig(40);
    buildToolMetadata(
      cache.servers.a.tools,
      [],
      config.mcpServers.a,
      "a",
      "server",
      config.mcpServers,
    );
    expect(mockedGetToolNameCandidates).toHaveBeenCalledTimes(40);
  });
});
