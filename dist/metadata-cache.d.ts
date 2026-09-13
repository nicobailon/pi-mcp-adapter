import type { CachedPrompt, CachedResource, CachedTool, McpConfig, McpTool, McpResource, McpPrompt, MetadataCache, ServerCacheEntry, ServerEntry, ToolMetadata, PromptMetadata } from "./types.ts";
import { type ToolPrefix, type ToolSelectorCandidateIndex } from "./types.ts";
export type { CachedPrompt, CachedResource, CachedTool, MetadataCache, ServerCacheEntry } from "./types.ts";
export declare function getMetadataCachePath(): string;
export declare function loadMetadataCache(): MetadataCache | null;
export declare function saveMetadataCache(cache: MetadataCache): void;
export declare function computeServerHash(definition: ServerEntry, environment?: NodeJS.ProcessEnv): string;
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
