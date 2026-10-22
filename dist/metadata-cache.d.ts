import type { CachedExecutorAppTool, CachedPrompt, CachedResource, CachedTool, McpConfig, McpTool, McpResource, McpPrompt, MetadataCache, ServerCacheEntry, ServerEntry, ToolMetadata, PromptMetadata } from "./types.ts";
import { type ToolPrefix, type ToolSelectorCandidateIndex } from "./types.ts";
export type { CachedPrompt, CachedResource, CachedTool, MetadataCache, ServerCacheEntry } from "./types.ts";
export declare function getMetadataCachePath(): string;
export declare function loadMetadataCache(): MetadataCache | null;
/**
 * The cache plus what this session already listed. Private or zero-TTL listings are never
 * persisted as valid, but this session's own listing still counts for this session.
 */
export declare function withSessionMetadata(cache: MetadataCache | null, config: McpConfig, sessionMetadata: ReadonlyMap<string, ServerCacheEntry> | undefined): MetadataCache | null;
export declare function saveMetadataCache(cache: MetadataCache, options?: {
    startupSnapshot?: MetadataCache["servers"];
}): void;
export declare function computeServerHash(definition: ServerEntry, environment?: NodeJS.ProcessEnv): string;
/**
 * Identifies the tool definition an output shape was learned against. A shape is only used or saved while
 * the tool's description and input schema still match, since a change there can mean a different result.
 */
export declare function outputShapeKey(tool: Pick<CachedTool, "description" | "inputSchema">): string;
/**
 * Saves one tool's observed output shape into its server's cache entry, if the entry matches the running config
 * and tool. The entry comes from the same read the write replaces, so newer metadata from other Pi processes is kept.
 */
export declare function saveObservedOutput(serverName: string, definition: ServerEntry, toolName: string, toolKey: string, output: NonNullable<ServerCacheEntry["outputShapes"]>[string]): void;
/** Output shapes to carry into a rewritten cache entry: same config, not private, and only tools whose definition kept its shape key. */
export declare function keepOutputShapes(previous: ServerCacheEntry | undefined, configHash: string, tools: CachedTool[]): ServerCacheEntry["outputShapes"];
/** Adds an Executor server's app catalog to its cache entry on disk, if that entry is still the same, persistable listing. */
export declare function saveExecutorCatalog(serverName: string, configHash: string, catalog: NonNullable<ServerCacheEntry["executorApps"]>): void;
export declare function isServerCacheValid(entry: ServerCacheEntry, definition: ServerEntry, maxAgeMs?: number, environment?: NodeJS.ProcessEnv): boolean;
export declare function parseDirectToolSelectors(selectors: string[]): {
    servers: Set<string>;
    tools: Map<string, Set<string>>;
};
export declare function getMissingConfiguredDirectToolServers(config: McpConfig, cache: MetadataCache | null, envOverride?: string[]): string[];
export declare function reconstructToolMetadata(serverName: string, entry: ServerCacheEntry, prefix: ToolPrefix, definition: Pick<ServerEntry, "exposeResources" | "includeTools" | "excludeTools" | "toolPrefix">, configuredServers?: Record<string, ServerEntry>, cache?: MetadataCache, sharedSelectorCandidateIndex?: ToolSelectorCandidateIndex): ToolMetadata[];
/**
 * The tool metadata of an Executor server's cached app tools, named by canonical path, after
 * includeTools/excludeTools. Executor's own `tools.executor.*` tools are never app tools, and an
 * app tool never takes an adapter name in `takenNames` or one an earlier app tool took, so the
 * first in Executor's order wins; without `takenNames` (the Pi registry, which hashes shared
 * names) names are not checked. Executor gives no JSON Schema, so the input is any object and the
 * description carries the TypeScript input type. A corrupt cached item is skipped.
 */
export declare function executorAppToolMetadata(serverName: string, entry: ServerCacheEntry, effectivePrefix: ToolPrefix, definition: Pick<ServerEntry, "includeTools" | "excludeTools">, selectorCandidateIndex: ToolSelectorCandidateIndex | undefined, takenNames: ReadonlySet<string> | undefined): ToolMetadata[];
/** A cached catalog item with the fields every reader needs; a corrupt cache file can hold anything. */
export declare function isUsableCachedAppTool(tool: unknown): tool is CachedExecutorAppTool;
/** Executor lists its own admin API as `tools.executor.*`; those are never app tools. */
export declare function isExecutorOwnTool(tool: Pick<CachedExecutorAppTool, "canonicalPath">): boolean;
/** Whether one of an Executor server's catalog tools is an app tool its includeTools/excludeTools allow. */
export declare function isExecutorAppToolAllowed(tool: Pick<CachedExecutorAppTool, "canonicalPath">, serverName: string, effectivePrefix: ToolPrefix, definition: Pick<ServerEntry, "includeTools" | "excludeTools">, selectorCandidateIndex?: ToolSelectorCandidateIndex): boolean;
export declare function createCachedToolSelectorCandidateIndex(configuredServers: Record<string, ServerEntry>, cache: MetadataCache, prefix: ToolPrefix): ToolSelectorCandidateIndex;
export declare function serializeTools(tools: McpTool[]): CachedTool[];
export declare function serializeResources(resources: McpResource[]): CachedResource[];
export declare function serializePrompts(prompts: McpPrompt[]): CachedPrompt[];
export declare function reconstructPromptMetadata(serverName: string, prompts: ReadonlyArray<McpPrompt | CachedPrompt>, prefix: ToolPrefix, definition?: Pick<ServerEntry, "toolPrefix">): PromptMetadata[];
