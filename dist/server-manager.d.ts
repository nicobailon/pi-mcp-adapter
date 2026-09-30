import { Client, type GetPromptResult, type ListToolsResult, type ReadResourceResult, type McpSubscription, type SubscriptionFilter, type RequestOptions, type UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import { type McpTool, type McpResource, type McpPrompt, type ServerDefinition, type ServerStreamResultPatchNotification, type Transport, type McpTraceSettings, type McpListenState } from "./types.ts";
import { type McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { type AuthStorageOptions } from "./mcp-auth.ts";
import { type ServerSamplingConfig } from "./sampling-handler.ts";
import { type ServerElicitationConfig } from "./elicitation-handler.ts";
import { type RawRequestChannel } from "./mcp-tasks.ts";
import type { TaskEnabledSession } from "@modelcontextprotocol/ext-tasks/client";
export declare function isUnauthorizedHttpError(error: unknown): boolean;
export interface ServerConnection {
    client: Client;
    transport: Transport;
    definition: ServerDefinition;
    tools: McpTool[];
    /** Cache hints from the server's aggregated tools/list result. */
    toolListHints?: Partial<Pick<ListToolsResult, "ttlMs" | "cacheScope">> | undefined;
    /** Monotonic guard against older refresh responses replacing newer notifications. */
    toolsRevision?: number;
    resources: McpResource[];
    /** True when resources were advertised but resources/list failed. */
    resourceDiscoveryFailed?: boolean;
    prompts: McpPrompt[];
    /** True when prompts were advertised but prompts/list failed. */
    promptDiscoveryFailed?: boolean;
    instructions?: string;
    lastUsedAt: number;
    inFlight: number;
    status: "connected" | "closed" | "needs-auth";
    /** Catalog subscription health, tracked independently from transport health. */
    listenState: McpListenState;
    /** ext-tasks requester session, attached when `tasks: true` and the server advertises the extension. */
    taskSession?: TaskEnabledSession;
    /** Raw JSON-RPC channel backing the task session on 2026-07-28 connections. */
    taskChannel?: RawRequestChannel;
    listenSubscription?: McpSubscription;
    /** Last requested filter; the server's honored filter may be a subset. */
    listenFilter?: SubscriptionFilter;
    /** True when recovery has an active listen but could not confirm every catalog list. */
    listenCatalogStale?: boolean;
    listenPromise?: Promise<void>;
    listenRetryAfter?: number;
    listenStopped?: boolean;
    recentResourceUris?: Map<string, number>;
    resourceReadRefreshUris?: Set<string>;
    /** True once this needs-auth episode discarded the cached credential. */
    credentialsInvalidated?: boolean;
}
type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;
type MetadataListChangedListener = (serverName: string, reason: string) => void;
type ListenStateChangedListener = (serverName: string, state: McpListenState) => void;
type ResourceUpdatedListener = (serverName: string, uri: string) => void;
export type ToolRefreshResult = "updated" | "unchanged" | "superseded" | "refresh-timeout";
export declare function isTransientHttpConnectError(error: unknown): boolean;
export declare class McpServerManager {
    private readonly defaultCwd?;
    private connections;
    private connectPromises;
    private connectOAuthAuthorities;
    private reconnectPromises;
    private reconnectOAuthAuthorities;
    private reconnectAttempts;
    private uiStreamListeners;
    private samplingConfig;
    private metadataListChangedListener;
    private listenStateChangedListener;
    private resourceUpdatedListeners;
    private pendingMetadataPublications;
    private elicitationConfig;
    private authStorageOptions;
    private oauthRuntime;
    private acceptedUrlElicitations;
    private defaultRequestTimeoutMs;
    private runtimeSignal;
    private closePromises;
    private closeGenerations;
    private connectAttempts;
    private traceSettings;
    private traceWriter;
    private stopped;
    /** Default cwd for stdio servers without an explicit config `cwd`. */
    constructor(defaultCwd?: string | undefined);
    setSamplingConfig(config: ServerSamplingConfig | undefined): void;
    setMetadataListChangedListener(listener: MetadataListChangedListener | undefined): void;
    setListenStateChangedListener(listener: ListenStateChangedListener | undefined): void;
    publishMetadataChanged(name: string, expectedConnection: ServerConnection, reason: string): boolean;
    setElicitationConfig(config: ServerElicitationConfig | undefined): void;
    setRuntimeSignal(signal: AbortSignal | undefined): void;
    setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void;
    setTraceConfig(settings: McpTraceSettings | undefined): void;
    setAuthStorageOptions(options: AuthStorageOptions): void;
    setOAuthRuntime(runtime: McpOAuthRuntime): void;
    getRequestOptions(name: string, signal?: AbortSignal): RequestOptions | undefined;
    private getResolvedRequestTimeoutMs;
    private buildRequestOptions;
    private arbitrateConnectionAttempt;
    connect(name: string, definition: ServerDefinition, signal?: AbortSignal): Promise<ServerConnection>;
    /**
     * Reconnect a server whose connection was proven stale (e.g. by a 404
     * "session no longer exists" response). Single-flight per server name —
     * concurrent callers that raced to the same failure share one reconnect —
     * and identity-guarded: `staleConnection` is only torn down if it is
     * still the manager's current connection for `name`. If a concurrent
     * reconnect (or an unrelated connect()) already replaced it with a fresh
     * connection, that fresh connection is returned untouched.
     */
    reconnect(name: string, definition: ServerDefinition, staleConnection: ServerConnection, signal?: AbortSignal): Promise<ServerConnection>;
    /**
     * Fetch the authoritative tool catalog for a connection that still appears
     * connected. The SDK response cache is explicitly bypassed so this request
     * also proves the remote Streamable HTTP session is usable. Results are
     * identity-guarded: a late response from a replaced connection is ignored.
     */
    refreshTools(name: string, expectedConnection: ServerConnection, signal?: AbortSignal): Promise<ToolRefreshResult>;
    private retryPendingMetadataPublication;
    private setListenState;
    private catalogListenFilter;
    private currentListenFilter;
    private watchListenSubscription;
    /** Quietly repairs a modern catalog listen at an existing activity boundary. */
    ensureListen(name: string, expectedConnection: ServerConnection): Promise<void>;
    private reconcileCatalogAfterListen;
    prepareResourceUse(name: string, uri: string, expectedConnection: ServerConnection): Promise<boolean>;
    registerResourceUpdatedListener(token: string, serverName: string, uri: string, listener: ResourceUpdatedListener): void;
    removeResourceUpdatedListener(token: string): void;
    private doReconnect;
    private createConnection;
    private enrichHttpConnectionError;
    private connectClientWithAbort;
    private buildClientCapabilities;
    private createClient;
    private handleToolsListChanged;
    private handlePromptsListChanged;
    private handleResourcesListChanged;
    handleUrlElicitationRequired(serverName: string, error: UrlElicitationRequiredError): Promise<"accept" | "decline" | "cancel">;
    private rememberUrlElicitation;
    private connectHttpClient;
    private fetchAllTools;
    private fetchAllPrompts;
    private fetchAllResources;
    private attachAdapterNotificationHandlers;
    registerUiStreamListener(streamToken: string, listener: UiStreamListener): void;
    removeUiStreamListener(streamToken: string): void;
    getPrompt(name: string, promptName: string, args?: Record<string, string>, signal?: AbortSignal): Promise<GetPromptResult>;
    readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult>;
    close(name: string): Promise<void>;
    private disposeConnection;
    closeAll(): Promise<void>;
    private containsCleanupFailure;
    isConnecting(name: string): boolean;
    getConnection(name: string): ServerConnection | undefined;
    getAllConnections(): Map<string, ServerConnection>;
    touch(name: string): void;
    incrementInFlight(name: string): void;
    decrementInFlight(name: string): void;
    isIdle(name: string, timeoutMs: number): boolean;
}
export {};
