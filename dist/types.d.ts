import type { CallToolResult, ContentBlock as McpContentBlock, ListPromptsResult, ListResourcesResult, ListToolsResult, Transport as McpTransport } from "@modelcontextprotocol/client";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { UiStreamMode, UiStreamSummary } from "./ui-stream-types.ts";
import type { UiToolVisibility } from "./ui-tool-visibility.ts";
export type Transport = McpTransport;
/** Versioned shared-event-bus channel for read-only MCP runtime snapshots. */
export declare const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
export declare const MCP_STATUS_SNAPSHOT_VERSION: 1;
export type McpServerRuntimeStatus = "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";
export type McpListenState = "active" | "dropped" | "re-establishing" | "legacy" | "not-listening" | "disconnected";
export interface McpServerStatusSnapshot {
    readonly name: string;
    readonly status: McpServerRuntimeStatus;
    readonly toolCount: number;
    readonly directToolCount: number;
    readonly resourceCount?: number;
    readonly failedAgoSeconds?: number;
    readonly disabled: boolean;
    readonly listenState: McpListenState;
    readonly catalogStale?: boolean;
}
export interface McpStatusSnapshot {
    readonly version: typeof MCP_STATUS_SNAPSHOT_VERSION;
    readonly servers: ReadonlyArray<McpServerStatusSnapshot>;
    readonly totalTools: number;
    readonly totalResources: number;
    readonly connectedCount: number;
    readonly disabledCount: number;
}
/**
 * Minimal event-bus surface the status publisher needs. Lives here (leaf
 * module) so `state.ts` can reference it without importing `mcp-status.ts`,
 * which imports the state type back — an import cycle at type level.
 */
export interface McpStatusEventBus {
    emit(channel: string, data: unknown): void;
}
export type ImportKind = "cursor" | "claude-code" | "claude-desktop" | "codex" | "opencode" | "windsurf" | "vscode";
type SdkTool = ListToolsResult["tools"][number];
type SdkResource = ListResourcesResult["resources"][number];
type SdkPrompt = ListPromptsResult["prompts"][number];
type SdkPromptArgument = NonNullable<SdkPrompt["arguments"]>[number];
export interface McpTool {
    name: SdkTool["name"];
    title?: SdkTool["title"];
    description?: SdkTool["description"];
    inputSchema?: SdkTool["inputSchema"];
    _meta?: SdkTool["_meta"];
}
export interface McpResource {
    uri: SdkResource["uri"];
    name: SdkResource["name"];
    description?: SdkResource["description"];
    mimeType?: SdkResource["mimeType"];
    _meta?: SdkResource["_meta"];
}
export interface McpPromptArgument {
    name: SdkPromptArgument["name"];
    description?: SdkPromptArgument["description"];
    required?: SdkPromptArgument["required"];
}
export interface McpPrompt {
    name: SdkPrompt["name"];
    title?: SdkPrompt["title"];
    description?: SdkPrompt["description"];
    arguments?: SdkPrompt["arguments"];
    _meta?: SdkPrompt["_meta"];
}
export interface UiResourceMeta {
    csp?: UiResourceCsp;
    permissions?: UiResourcePermissions;
    domain?: string;
    prefersBorder?: boolean;
}
export interface UiResourceContent {
    uri: string;
    html: string;
    mimeType?: string;
    meta: UiResourceMeta;
}
export interface UiProxyRequestBody<TParams> {
    token: string;
    params: TParams;
}
export interface UiProxyResult<T = Record<string, unknown>> {
    ok: boolean;
    result?: T;
    error?: string;
}
export interface UiResourceCsp {
    resourceDomains?: string[];
    connectDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
}
export interface UiResourcePermissions {
    camera?: {};
    microphone?: {};
    geolocation?: {};
    clipboardWrite?: {};
}
export interface UiToolInfo {
    id?: string | number;
    tool: {
        name: string;
        description?: string;
        inputSchema?: unknown;
    };
}
export interface UiHostContext {
    toolInfo?: UiToolInfo;
    theme?: "light" | "dark";
    styles?: Record<string, unknown>;
    displayMode?: UiDisplayMode;
    availableDisplayModes?: UiDisplayMode[];
    containerDimensions?: {
        width?: number;
        maxWidth?: number;
        height?: number;
        maxHeight?: number;
    };
    [key: string]: unknown;
}
export type UiDisplayMode = "inline" | "fullscreen" | "pip";
/**
 * Live handle to a started UI tool session. Lives here (leaf module) so
 * `state.ts` can reference it without importing `ui-server.ts`, which
 * imports the state type back — an import cycle at type level.
 */
export interface UiServerHandle {
    url: string;
    port: number;
    /** URL of the second-origin MCP Apps sandbox proxy. */
    proxyUrl: string;
    proxyPort: number;
    sessionToken: string;
    serverName: string;
    toolName: string;
    viewer?: "browser" | "glimpse" | "suppressed";
    windowOpen?: boolean;
    close: (reason?: string) => void;
    sendToolInput: (args: Record<string, unknown>) => void;
    sendToolResult: (result: CallToolResult) => void;
    sendResultPatch: (result: CallToolResult) => void;
    sendToolCancelled: (reason: string) => void;
    sendResourceUpdated: (uri: string) => void;
    sendHostContext: (context: UiHostContext) => void;
    /** Get accumulated messages from this session */
    getSessionMessages: () => UiSessionMessages;
    getStreamSummary: () => UiStreamSummary | undefined;
}
export { UI_STREAM_HOST_CONTEXT_KEY, UI_STREAM_REQUEST_META_KEY, UI_STREAM_RESULT_PATCH_METHOD, SERVER_STREAM_RESULT_PATCH_METHOD, UI_STREAM_STRUCTURED_CONTENT_KEY, uiStreamModeSchema, visualizationStreamPhaseSchema, visualizationStreamFrameTypeSchema, visualizationStreamStatusSchema, uiStreamHostContextSchema, visualizationStreamEnvelopeSchema, uiStreamCallToolResultSchema, uiStreamResultPatchNotificationSchema, serverStreamResultPatchNotificationSchema, getUiStreamHostContext, getVisualizationStreamEnvelope, type UiStreamMode, type VisualizationStreamPhase, type VisualizationStreamFrameType, type VisualizationStreamStatus, type UiStreamHostContext, type VisualizationStreamEnvelope, type UiStreamCallToolResult, type UiStreamResultPatchNotification, type ServerStreamResultPatchNotification, type UiStreamSummary, } from "./ui-stream-types.ts";
export interface UiMessageParams {
    role?: string;
    content?: unknown[];
    type?: "prompt" | "notify" | "intent" | "message";
    message?: string;
    prompt?: string;
    intent?: string;
    params?: Record<string, unknown>;
    [key: string]: unknown;
}
/**
 * Extract prompt text from either legacy MCP UI message shapes or native AppBridge user messages.
 */
export declare function extractUiPromptText(params: UiMessageParams): string | undefined;
/**
 * Structured UI handoff recovered from a canonical prompt envelope.
 */
export interface UiPromptHandoff {
    intent: string;
    params: Record<string, unknown>;
    raw: string;
}
/**
 * Parse a canonical named UI handoff encoded as `intent\n{json}`.
 */
export declare function parseUiPromptHandoff(prompt: string): UiPromptHandoff | undefined;
/**
 * Accumulated messages from a UI session.
 * Collected during the session and available when it ends.
 */
export interface UiSessionMessages {
    prompts: string[];
    notifications: string[];
    intents: Array<{
        intent: string;
        params?: Record<string, unknown>;
    }>;
    contexts: UiModelContextUpdate[];
}
export interface UiModelContextUpdate {
    summary: string;
    truncated: boolean;
    payload?: Record<string, unknown>;
}
export interface UiModelContextParams {
    content?: McpContentBlock[];
    structuredContent?: Record<string, unknown>;
}
export declare function createUiModelContextUpdate(params: UiModelContextParams, maxChars?: number): UiModelContextUpdate | undefined;
export interface UiOpenLinkResult {
    isError?: boolean;
    [key: string]: unknown;
}
export interface UiDisplayModeRequest {
    mode?: UiDisplayMode;
}
export interface UiDisplayModeResult {
    mode: UiDisplayMode;
    [key: string]: unknown;
}
export interface McpContent {
    type: "text" | "image" | "audio" | "resource" | "resource_link";
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: {
        uri: string;
        text?: string;
        blob?: string;
    };
    uri?: string;
    name?: string;
    description?: string;
}
export type ContentBlock = TextContent | ImageContent;
export interface OAuthConfig {
    /** OAuth grant type (defaults to authorization_code) */
    grantType?: "authorization_code" | "client_credentials";
    /** Pre-registered client ID (optional, dynamic registration used if not provided) */
    clientId?: string;
    /** Client secret for confidential clients */
    clientSecret?: string;
    /** Requested OAuth scopes */
    scope?: string;
    /** Extra authorization URL parameters for provider-specific extensions. Flow-owned parameters cannot be overridden. */
    authorizationParams?: Record<string, string>;
    /** Authorization-code redirect URI. Loopback URIs may use `{port}` for an OS-assigned port; HTTPS redirects use manual completion. */
    redirectUri?: string;
    /** Client display name for dynamic registration */
    clientName?: string;
    /** Client homepage URI for dynamic registration */
    clientUri?: string;
    /** Client logo URL for dynamic registration; shown on consent screens */
    logoUri?: string;
    /** HTTPS URL for an authorization-server metadata document used instead of MCP discovery */
    authServerMetadataUrl?: string;
    /** Security-weakening escape hatch for known-misconfigured authorization servers. */
    skipIssuerMetadataValidation?: boolean;
}
/**
 * Trusted executable invoked for every outbound HTTP request. The adapter
 * writes a versioned JSON request envelope to stdin and expects a JSON object
 * containing headers on stdout. This is intended for caller-bound signing
 * schemes whose headers depend on the exact request body.
 */
export interface HttpRequestHeadersCommand {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
}
export interface ServerEntry {
    command?: string;
    args?: string[];
    /** Explicit rmcp-mux Unix-domain socket path. Mutually exclusive with command and url. */
    socket?: string;
    env?: Record<string, string>;
    /** Inherit the adapter process environment for stdio servers. Defaults to true; false keeps SDK platform defaults plus explicit env overlays. */
    inheritEnv?: boolean;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    /** Add or replace HTTP headers by running a trusted command for each request. */
    requestHeadersCommand?: HttpRequestHeadersCommand;
    /**
     * Authentication type:
     * - 'oauth' - Use OAuth 2.1 (auto-discovers endpoints, supports dynamic client registration)
     * - 'bearer' - Use static Bearer token
     * - false - Disable authentication
     * If not specified and url is present, OAuth will be auto-detected unless custom headers are configured
     */
    auth?: "oauth" | "bearer" | false;
    bearerToken?: string;
    bearerTokenEnv?: string;
    /** Read a static bearer token from the adapter-owned OS credential store. */
    bearerTokenStore?: true;
    /**
     * OAuth configuration (optional).
     * If not provided, the SDK will attempt dynamic client registration.
     * Set to false to explicitly disable OAuth for this server.
     */
    oauth?: OAuthConfig | false;
    lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
    idleTimeout?: number;
    requestTimeoutMs?: number;
    exposeResources?: boolean;
    directTools?: boolean | string[];
    toolPrefix?: ToolPrefix;
    includeTools?: string[];
    excludeTools?: string[];
    /**
     * Extra search keywords per tool, keyed by original name, prefixed name, or
     * glob (same matching rules as includeTools/excludeTools). Keywords boost
     * mcp({ search }) ranking only — they never appear in tool schemas,
     * describe output, or the metadata cache.
     */
    searchKeywords?: Record<string, string[]>;
    approveTools?: boolean | string[];
    debug?: boolean;
    /** Enable metadata-only JSONL protocol tracing for this server. */
    trace?: boolean;
    /** Force a specific HTTP MCP transport. Used by Agent Plugins, whose `type` declares the transport and forbids client fallback. */
    httpTransport?: "streamable-http" | "sse";
    /** Client-managed persistent data directory for Agent Plugin stdio servers. */
    pluginDataDir?: string;
    /** Treat env values as already resolved literals. Used for Agent Plugin env rules. */
    literalEnv?: boolean;
    /**
     * MCP protocol era negotiation for this server. Defaults to `"legacy"`
     * (byte-equivalent to pre-2026 behavior — no `versionNegotiation` is sent).
     * `"auto"` offers the SDK's default 2026-07-28+ modern versions with
     * legacy fallback; `"2026-07-28"` pins the connection to that revision
     * with no fallback. `auto` and `2026-07-28` must be set explicitly.
     */
    protocolVersion?: "legacy" | "auto" | "2026-07-28";
    disabled?: boolean;
}
/** Only the literal boolean `true` disables a server. */
export declare function isServerDisabled(definition: ServerEntry | undefined): boolean;
export interface McpOutputGuardSettings {
    /** Maximum inline MCP text output bytes before truncation/spill-to-disk. Defaults to 51200 (50 KiB). */
    maxBytes?: number;
    /** Maximum inline MCP text output lines before truncation/spill-to-disk. Defaults to 2000. */
    maxLines?: number;
    /** Maximum details.mcpResult JSON bytes kept raw; larger results are summarized and spilled to disk. Defaults to 16384 (16 KiB). */
    detailsMaxBytes?: number;
}
export type ToolPrefix = "server" | "none" | "short" | "mcp";
export declare function formatServerNamespace(serverName: string): string;
export type HostConfigDiscovery = "off" | "prompt" | "on";
export type McpFooterStatus = "full" | "compact" | "off";
export interface McpTraceSettings {
    /** Enable tracing for all servers unless a server sets trace to false. */
    enabled?: boolean;
    /** JSONL destination; relative paths are resolved from the session cwd. */
    file?: string;
    /** Maximum per-session trace file size in bytes. */
    maxBytes?: number;
    /** Maximum events retained in the per-session trace file. */
    maxEvents?: number;
}
export declare const MCP_TOOL_APPROVAL_REQUEST_EVENT: "pi-mcp-adapter:tool-approval-request";
export type McpToolApprovalOrigin = "proxy" | "direct" | "script" | "resource" | "iframe";
export type McpToolApprovalDecision = "allow_once" | "allow_for_session" | "deny" | "abstain";
export type McpToolApprovalHandler = () => McpToolApprovalDecision | Promise<McpToolApprovalDecision>;
export interface McpToolApprovalRequest {
    requestId: string;
    serverName: string;
    originalToolName: string;
    prefixedToolName: string;
    args: Record<string, unknown>;
    origin: McpToolApprovalOrigin;
    signal?: AbortSignal;
    claim(handler: McpToolApprovalHandler): boolean;
}
export interface McpSettings {
    toolPrefix?: ToolPrefix;
    /** Show the plug prefix in MCP status and connection text (default: true). Set to false to disable it. */
    showStatusIcon?: boolean;
    /** Footer status verbosity: full details, compact connected/enabled count, or no footer status. Defaults to full. */
    mcpFooterStatus?: McpFooterStatus;
    /** Show successful startup connection notifications. Defaults to true. */
    notifyOnStartupConnect?: boolean;
    /** Discover detected host-specific MCP configs only when explicitly enabled. */
    hostConfigDiscovery?: HostConfigDiscovery;
    /** Agent Plugin package directories to load MCP servers from. */
    agentPluginPaths?: string[];
    idleTimeout?: number;
    requestTimeoutMs?: number;
    directTools?: boolean;
    /**
     * Validate direct-tool inputs against the advertised schema after recovering
     * one JSON string layer for object and array properties. Defaults to false.
     */
    strictDirectToolArguments?: boolean;
    /**
     * Include the byte-bounded raw MCP result in direct-tool details. The default
     * `lean` mode keeps the existing small details object.
     */
    directToolResultDetails?: "lean" | "bounded";
    /** Show the advisory when 75 or more direct tools resolve. Defaults to true. */
    warnOnLargeDirectTools?: boolean;
    /** Register the trusted MCP-only JavaScript scripting tool. Defaults to true; set false to hide it. */
    scriptMode?: boolean;
    /** Render MCP tool results as compact self-rendered rows by default, or as the legacy boxed row. */
    toolResultRendering?: "compact" | "boxed";
    /** Number of result text lines to show before expansion. Supports 1, 2, or 3. Defaults to 1 in compact mode and 3 in boxed mode. */
    collapsedResultLines?: 1 | 2 | 3;
    /** Default approval gate for matching tools/resources; per-server settings override it. */
    approveTools?: boolean | string[];
    disableProxyTool?: boolean;
    /** Freeze direct-tool registration after the initial sync. Automatic metadata updates
     * and explicit reconnects won't rebuild the system prompt, preserving the
     * prompt-cache prefix. Proxy/search/cache metadata still refreshes. Default: false. */
    freezeDirectTools?: boolean;
    autoAuth?: boolean;
    sampling?: boolean;
    samplingAutoApprove?: boolean;
    elicitation?: boolean;
    /**
     * Guard oversized MCP tool/resource output before it is returned to the model.
     * Defaults to true (50 KiB / 2,000 lines inline text, 16 KiB details.mcpResult).
     * Set to false to restore raw MCP output behavior, or pass an object to tune
     * the limits. Env kill switch: MCP_OUTPUT_GUARD=0.
     */
    outputGuard?: boolean | McpOutputGuardSettings;
    /**
     * Opt-in metadata-only MCP protocol tracing. Payloads, prompts, tool
     * arguments/results, authorization data, and URLs are never persisted.
     */
    trace?: McpTraceSettings;
    /**
     * Message returned in tool results when a server needs (re-)authentication.
     * "${server}" is substituted with the server name. Defaults to a TUI
     * instruction when unset.
     */
    authRequiredMessage?: string;
    /**
     * Legacy OAuth tokens.json import directory.
     * Relative paths are resolved from the project root (cwd).
     * Takes precedence over the agent's mcp-oauth/ legacy import directory but
     * can still be overridden by the MCP_OAUTH_DIR env variable.
     *
     * Persistent OAuth credentials are stored in the operating system credential
     * store, not this directory. Existing plaintext tokens.json files found here
     * are imported once and removed.
     */
    oauthDir?: string;
}
export interface ClaudePluginConfig {
    /** Explicit local Claude plugin directory. File-based config resolves relative paths from the active project cwd; createMcpAdapter snapshots programmatic paths against process.cwd(). */
    path: string;
    /** Load the plugin's root .mcp.json as low-precedence MCP defaults. */
    mcp?: boolean;
    /** Expose the plugin's root skills/ directory to Pi resource discovery. */
    skills?: boolean;
}
export interface McpConfig {
    mcpServers: Record<string, ServerEntry>;
    imports?: ImportKind[];
    settings?: McpSettings;
    claudePlugins?: ClaudePluginConfig[];
}
export interface McpAdapterOptions {
    config?: McpConfig;
    configPath?: string;
}
export type ServerDefinition = ServerEntry;
export interface ToolMetadata {
    name: string;
    originalName: string;
    description: string;
    resourceUri?: string;
    uiResourceUri?: string;
    uiVisibility?: UiToolVisibility[];
    inputSchema?: unknown;
    uiStreamMode?: UiStreamMode;
}
export interface PromptMetadata {
    serverName: string;
    originalName: string;
    commandName: string;
    title?: string;
    description: string;
    arguments: McpPromptArgument[];
}
export interface DirectToolSpec {
    serverName: string;
    originalName: string;
    prefixedName: string;
    description: string;
    inputSchema?: unknown;
    resourceUri?: string;
    uiResourceUri?: string;
    uiStreamMode?: UiStreamMode;
}
export interface ServerProvenance {
    path: string;
    kind: "user" | "project" | "import";
    importKind?: string;
}
export interface McpAuthResult {
    ok: boolean;
    message?: string;
}
export interface CachedTool {
    name: string;
    description?: string;
    inputSchema?: unknown;
    uiResourceUri?: string;
    uiVisibility?: UiToolVisibility[];
    uiStreamMode?: "eager" | "stream-first";
}
export interface CachedResource {
    uri: string;
    name: string;
    description?: string;
}
export interface CachedPrompt {
    name: string;
    title?: string;
    description?: string;
    arguments?: {
        name: string;
        description?: string;
        required?: boolean;
    }[];
}
export interface ServerCacheEntry {
    configHash: string;
    tools: CachedTool[];
    resources: CachedResource[];
    prompts?: CachedPrompt[];
    instructions?: string;
    /** Server-level hints from the aggregated tools/list result. */
    ttlMs?: ListToolsResult["ttlMs"];
    cacheScope?: ListToolsResult["cacheScope"];
    cachedAt: number;
}
export interface MetadataCache {
    version: number;
    servers: Record<string, ServerCacheEntry>;
}
export interface McpPanelCallbacks {
    reconnect: (serverName: string) => Promise<boolean>;
    canAuthenticate: (serverName: string) => boolean;
    authenticate: (serverName: string) => Promise<McpAuthResult>;
    getConnectionStatus: (serverName: string) => "connected" | "idle" | "failed" | "needs-auth" | "disabled";
    getFailureMessage?: (serverName: string) => string | null;
    refreshCacheAfterReconnect: (serverName: string) => ServerCacheEntry | null;
}
export interface McpPanelResult {
    changes: Map<string, true | string[] | false>;
    /** Servers whose disabled flag changed during the panel session (name → new disabled state). */
    disabledChanges: Map<string, boolean>;
    cancelled: boolean;
}
export declare function getServerPrefix(serverName: string, mode: ToolPrefix): string;
/**
 * Format a tool name with server prefix.
 */
export declare function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string;
export declare function resolveToolPrefix(definition?: Pick<ServerEntry, "toolPrefix">, globalPrefix?: ToolPrefix): ToolPrefix;
/**
 * Resolve a configured MCP server name from a prefixed tool name.
 *
 * When the proxy tool is addressed with a fully-qualified name such as
 * `searxng_searxng_web_search`, downstream policy systems (for example a
 * permission gate) need to recover the owning server so they can evaluate
 * server-scoped rules against the bare server name. This performs the inverse
 * of {@link getServerPrefix}: it finds the longest configured server prefix
 * that the tool name starts with and returns that server's name.
 *
 * @param toolName - the tool name as passed to the proxy `mcp({ tool })` call.
 * @param serverNames - the configured MCP server names (keys of `mcpServers`).
 * @param prefix - the active tool-prefix mode.
 * @returns the resolved server name, or `undefined` when no prefix matches or
 *   the prefix mode is `"none"`.
 */
export declare function resolveServerFromToolName(toolName: string, serverNames: Iterable<string>, prefix: ToolPrefix): string | undefined;
export declare function sanitizePromptName(name: string): string;
export declare function formatPromptCommandName(promptName: string, serverName: string, prefix: ToolPrefix): string;
export declare function getToolNameCandidates(toolName: string, serverName: string, prefix: ToolPrefix, includeLegacy?: boolean): Set<string>;
export interface ToolSelectorCandidateIndex {
    readonly allCurrentCandidates: ReadonlySet<string>;
    readonly matchingCountByPattern: Map<string, number>;
    readonly matcherByPattern: Map<string, RegExp>;
    readonly additionalCurrentCandidatesByToolName?: ReadonlyMap<string, ReadonlySet<string>>;
}
export declare function createToolSelectorCandidateIndex(allCurrentCandidates: Set<string>, additionalCurrentCandidatesByToolName?: ReadonlyMap<string, ReadonlySet<string>>): ToolSelectorCandidateIndex;
export declare function matchesToolPattern(candidates: Set<string>, patterns?: unknown): boolean;
export type ToolSelectorCandidateContext = Set<string> | ToolSelectorCandidateIndex;
export declare function isToolIncluded(toolName: string, serverName: string, prefix: ToolPrefix, includeTools?: unknown, otherCurrentCandidates?: ToolSelectorCandidateContext): boolean;
export declare function isToolExcluded(toolName: string, serverName: string, prefix: ToolPrefix, excludeTools?: unknown, otherCurrentCandidates?: ToolSelectorCandidateContext): boolean;
export declare function isToolAllowed(toolName: string, serverName: string, prefix: ToolPrefix, includeTools?: unknown, excludeTools?: unknown, otherCurrentCandidates?: ToolSelectorCandidateContext): boolean;
