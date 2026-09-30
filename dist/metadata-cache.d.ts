import type { CachedPrompt, CachedResource, CachedTool, McpConfig, McpTool, McpResource, McpPrompt, MetadataCache, ServerCacheEntry, ServerEntry, ToolMetadata, PromptMetadata } from "./types.ts";
import { type ToolPrefix, type ToolSelectorCandidateIndex } from "./types.ts";
export type { CachedPrompt, CachedResource, CachedTool, MetadataCache, ServerCacheEntry } from "./types.ts";
export declare function getMetadataCachePath(): string;
export declare function loadMetadataCache(): MetadataCache | null;
export declare function saveMetadataCache(cache: MetadataCache): void;
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
export declare function isServerCacheValid(entry: ServerCacheEntry, definition: ServerEntry, maxAgeMs?: number, environment?: NodeJS.ProcessEnv): boolean;
export declare function parseDirectToolSelectors(selectors: string[]): {
    servers: Set<string>;
    tools: Map<string, Set<string>>;
};
export declare function getMissingConfiguredDirectToolServers(config: McpConfig, cache: MetadataCache | null, envOverride?: string[]): string[];
export declare function reconstructToolMetadata(serverName: string, entry: ServerCacheEntry, prefix: ToolPrefix, definition: Pick<ServerEntry, "exposeResources" | "includeTools" | "excludeTools" | "toolPrefix">, configuredServers?: Record<string, ServerEntry>, cache?: MetadataCache, sharedSelectorCandidateIndex?: ToolSelectorCandidateIndex): ToolMetadata[];
export declare function createCachedToolSelectorCandidateIndex(configuredServers: Record<string, ServerEntry>, cache: MetadataCache, prefix: ToolPrefix): ToolSelectorCandidateIndex;
export declare function serializeTools(tools: McpTool[]): CachedTool[];
export declare function serializeResources(resources: McpResource[]): CachedResource[];
export declare function serializePrompts(prompts: McpPrompt[]): CachedPrompt[];
export declare function reconstructPromptMetadata(serverName: string, prompts: ReadonlyArray<McpPrompt | CachedPrompt>, prefix: ToolPrefix, definition?: Pick<ServerEntry, "toolPrefix">): PromptMetadata[];
