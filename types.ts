// types.ts - Core type definitions
import type {
  ContentBlock as McpContentBlock,
  ListPromptsResult,
  ListResourcesResult,
  ListToolsResult,
  Transport as McpTransport,
} from "@modelcontextprotocol/client";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { UiStreamMode } from "./ui-stream-types.ts";
import type { UiToolVisibility } from "./ui-tool-visibility.ts";

export type Transport = McpTransport;

/** Versioned shared-event-bus channel for read-only MCP runtime snapshots. */
export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export const MCP_STATUS_SNAPSHOT_VERSION = 1 as const;

export type McpServerRuntimeStatus =
  | "connected"
  | "cached"
  | "failed"
  | "needs-auth"
  | "not-connected"
  | "disabled";

export interface McpServerStatusSnapshot {
  readonly name: string;
  readonly status: McpServerRuntimeStatus;
  readonly toolCount: number;
  readonly resourceCount?: number;
  readonly failedAgoSeconds?: number;
  readonly disabled: boolean;
}

export interface McpStatusSnapshot {
  readonly version: typeof MCP_STATUS_SNAPSHOT_VERSION;
  readonly servers: ReadonlyArray<McpServerStatusSnapshot>;
  readonly totalTools: number;
  readonly totalResources: number;
  readonly connectedCount: number;
  readonly disabledCount: number;
}

// Import sources for config
export type ImportKind = 
  | "cursor" 
  | "claude-code" 
  | "claude-desktop" 
  | "codex" 
  | "opencode"
  | "windsurf" 
  | "vscode";

type SdkTool = ListToolsResult["tools"][number];
type SdkResource = ListResourcesResult["resources"][number];
type SdkPrompt = ListPromptsResult["prompts"][number];
type SdkPromptArgument = NonNullable<SdkPrompt["arguments"]>[number];

// MCP wire definitions derive their field types from the installed SDK while
// retaining the adapter's deliberately smaller public surface.
export interface McpTool {
  name: SdkTool["name"];
  title?: SdkTool["title"];
  description?: SdkTool["description"];
  inputSchema?: SdkTool["inputSchema"]; // JSON Schema
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

// Re-export stream types from the shared lightweight module.
// This allows the example package to import stream schemas without pulling the full types.ts dependency graph.
export {
  UI_STREAM_HOST_CONTEXT_KEY,
  UI_STREAM_REQUEST_META_KEY,
  UI_STREAM_RESULT_PATCH_METHOD,
  SERVER_STREAM_RESULT_PATCH_METHOD,
  UI_STREAM_STRUCTURED_CONTENT_KEY,
  uiStreamModeSchema,
  visualizationStreamPhaseSchema,
  visualizationStreamFrameTypeSchema,
  visualizationStreamStatusSchema,
  uiStreamHostContextSchema,
  visualizationStreamEnvelopeSchema,
  uiStreamCallToolResultSchema,
  uiStreamResultPatchNotificationSchema,
  serverStreamResultPatchNotificationSchema,
  getUiStreamHostContext,
  getVisualizationStreamEnvelope,
  type UiStreamMode,
  type VisualizationStreamPhase,
  type VisualizationStreamFrameType,
  type VisualizationStreamStatus,
  type UiStreamHostContext,
  type VisualizationStreamEnvelope,
  type UiStreamCallToolResult,
  type UiStreamResultPatchNotification,
  type ServerStreamResultPatchNotification,
  type UiStreamSummary,
} from "./ui-stream-types.ts";

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
export function extractUiPromptText(params: UiMessageParams): string | undefined {
  if (params.type === "prompt" || params.prompt) {
    const prompt = params.prompt ?? String(params.message ?? "");
    return prompt || undefined;
  }

  if (params.role === "user" && Array.isArray(params.content)) {
    const text = params.content
      .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n\n");
    return text || undefined;
  }

  return undefined;
}

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
export function parseUiPromptHandoff(prompt: string): UiPromptHandoff | undefined {
  const newlineIndex = prompt.indexOf("\n");
  if (newlineIndex <= 0) {
    return undefined;
  }

  const intent = prompt.slice(0, newlineIndex).trim();
  const payloadText = prompt.slice(newlineIndex + 1).trim();
  if (!intent || !payloadText) {
    return undefined;
  }

  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(intent)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return {
      intent,
      params: parsed as Record<string, unknown>,
      raw: prompt,
    };
  } catch {
    return undefined;
  }
}

/**
 * Accumulated messages from a UI session.
 * Collected during the session and available when it ends.
 */
export interface UiSessionMessages {
  prompts: string[];
  notifications: string[];
  intents: Array<{ intent: string; params?: Record<string, unknown> }>;
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

export function createUiModelContextUpdate(params: UiModelContextParams, maxChars = 12_000): UiModelContextUpdate | undefined {
  const payload = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(payload).length === 0) return undefined;

  const serialized = JSON.stringify(payload);
  if (serialized.length <= maxChars) {
    return { payload, summary: serialized, truncated: false };
  }

  return {
    summary: `${serialized.slice(0, Math.max(0, maxChars - 1))}…`,
    truncated: true,
  };
}

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

// Content types from MCP
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

// Pi content block type
export type ContentBlock = TextContent | ImageContent;

// OAuth configuration (SDK handles auto-discovery and dynamic registration)
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
  /** Exact authorization-code redirect URI for pre-registered clients */
  redirectUri?: string;
  /** Client display name for dynamic registration */
  clientName?: string;
  /** Client homepage URI for dynamic registration */
  clientUri?: string;
  /** Client logo URL for dynamic registration; shown on consent screens */
  logoUri?: string;
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

// Server configuration
export interface ServerEntry {
  command?: string;
  args?: string[];
  /** Explicit rmcp-mux Unix-domain socket path. Mutually exclusive with command and url. */
  socket?: string;
  env?: Record<string, string>;
  cwd?: string;
  // HTTP fields
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
  /** 
   * OAuth configuration (optional).
   * If not provided, the SDK will attempt dynamic client registration.
   * Set to false to explicitly disable OAuth for this server.
   */
  oauth?: OAuthConfig | false;
  lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
  idleTimeout?: number; // minutes, overrides global setting
  requestTimeoutMs?: number; // milliseconds, overrides global request timeout when > 0
  // Resource handling
  exposeResources?: boolean;
  // Direct tool registration
  directTools?: boolean | string[];
  // Override settings.toolPrefix for this server.
  toolPrefix?: ToolPrefix;
  // Include/exclude specific MCP tools/resources by original or prefixed name
  includeTools?: string[];
  excludeTools?: string[];
  /**
   * Extra search keywords per tool, keyed by original name, prefixed name, or
   * glob (same matching rules as includeTools/excludeTools). Keywords boost
   * mcp({ search }) ranking only — they never appear in tool schemas,
   * describe output, or the metadata cache.
   */
  searchKeywords?: Record<string, string[]>;
  // Require interactive approval before calling matching MCP tools/resources.
  approveTools?: boolean | string[];
  // Debug
  debug?: boolean;  // Show server stderr (default: false)
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
  // Keep configuration visible without allowing connections or execution.
  disabled?: boolean;
}

/** Only the literal boolean `true` disables a server. */
export function isServerDisabled(definition: ServerEntry | undefined): boolean {
  return definition?.disabled === true;
}

// Output guard tuning (settings.outputGuard object form)
export interface McpOutputGuardSettings {
  /** Maximum inline MCP text output bytes before truncation/spill-to-disk. Defaults to 51200 (50 KiB). */
  maxBytes?: number;
  /** Maximum inline MCP text output lines before truncation/spill-to-disk. Defaults to 2000. */
  maxLines?: number;
  /** Maximum details.mcpResult JSON bytes kept raw; larger results are summarized and spilled to disk. Defaults to 16384 (16 KiB). */
  detailsMaxBytes?: number;
}

// Settings
export type ToolPrefix = "server" | "none" | "short" | "mcp";
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

export const MCP_TOOL_APPROVAL_REQUEST_EVENT = "pi-mcp-adapter:tool-approval-request" as const;

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
  idleTimeout?: number; // minutes, default 10, 0 to disable
  requestTimeoutMs?: number; // milliseconds, overrides the SDK request timeout when > 0
  directTools?: boolean;
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
   * (reconnects, lazy-connect, tool-list-changed) won't rebuild the system prompt,
   * preserving the prompt-cache prefix. The agent rediscovers explicitly via
   * mcp({ connect: "server" }). Default: false. */
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

// Root config
export interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
  imports?: ImportKind[];
  settings?: McpSettings;
}

export interface McpAdapterOptions {
  config?: McpConfig;
  configPath?: string;
}

// Alias for clarity
export type ServerDefinition = ServerEntry;

export interface ToolMetadata {
  name: string;           // Prefixed tool name (e.g., "xcodebuild_list_sims")
  originalName: string;   // Original MCP tool name (e.g., "list_sims")
  description: string;
  resourceUri?: string;   // For resource tools: the URI to read
  uiResourceUri?: string; // For app-enabled tools: the UI resource URI
  uiVisibility?: UiToolVisibility[];
  inputSchema?: unknown;  // JSON Schema for parameters (stored for describe/errors)
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
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  prompts?: CachedPrompt[];
  instructions?: string;
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
  cancelled: boolean;
}

/**
 * Get server prefix based on tool prefix mode.
 */
function sanitizeServerPrefix(serverName: string, preserveProviderValid = true): string {
  const validCharacters = preserveProviderValid ? /^[A-Za-z0-9_-]$/ : /^[A-Za-z0-9]$/;
  return Array.from(serverName, char =>
    validCharacters.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`,
  ).join("");
}

export function getServerPrefix(
  serverName: string,
  mode: ToolPrefix
): string {
  if (mode === "none") return "";
  if (mode === "short") {
    let short = sanitizeServerPrefix(serverName.replace(/-?mcp$/i, ""));
    if (!short) short = "mcp";
    return short;
  }
  if (mode === "mcp") return `mcp__${sanitizeServerPrefix(serverName)}`;
  return sanitizeServerPrefix(serverName);
}

/**
 * Format a tool name with server prefix.
 */
export function formatToolName(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix
): string {
  const p = getServerPrefix(serverName, prefix);
  const sanitized = toolName.replace(/\./g, "_");
  return p ? `${p}_${sanitized}` : sanitized;
}

export function resolveToolPrefix(
  definition?: Pick<ServerEntry, "toolPrefix">,
  globalPrefix?: ToolPrefix,
): ToolPrefix {
  return definition?.toolPrefix ?? globalPrefix ?? "server";
}


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
export function resolveServerFromToolName(
  toolName: string,
  serverNames: Iterable<string>,
  prefix: ToolPrefix,
): string | undefined {
  if (prefix === "none") return undefined;
  const candidates: { name: string; prefix: string }[] = [];
  for (const name of serverNames) {
    const p = getServerPrefix(name, prefix);
    if (p && toolName.startsWith(p + "_")) candidates.push({ name, prefix: p });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => b.prefix.length - a.prefix.length);
  const best = candidates[0];
  // Fail safe: short mode can intentionally map names such as foo and foo-mcp
  // to the same prefix. Return undefined so a downstream permission gate uses
  // its existing wildcard path rather than enforcing a rule against the wrong server.
  if (candidates.some((c) => c.prefix === best!.prefix && c.name !== best!.name)) {
    return undefined;
  }
  return best?.name;
}

export function sanitizePromptName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  if (!cleaned) return "prompt";
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function formatPromptCommandName(
  promptName: string,
  serverName: string,
  prefix: ToolPrefix,
): string {
  const serverPart = getServerPrefix(serverName, prefix) || sanitizeServerPrefix(serverName) || "server";
  return `mcp__${serverPart}__${sanitizePromptName(promptName)}`;
}

function getLegacyServerPrefix(serverName: string, mode: ToolPrefix): string {
  if (mode === "none") return "";
  if (mode === "short") return sanitizeServerPrefix(serverName.replace(/-?mcp$/i, ""), false) || "mcp";
  if (mode === "mcp") return `mcp__${sanitizeServerPrefix(serverName, false)}`;
  return sanitizeServerPrefix(serverName, false);
}

function formatLegacyToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
  const serverPrefix = getLegacyServerPrefix(serverName, prefix);
  const sanitizedToolName = toolName.replace(/[.-]/g, "_");
  return serverPrefix ? `${serverPrefix}_${sanitizedToolName}` : sanitizedToolName;
}

export function getToolNameCandidates(toolName: string, serverName: string, prefix: ToolPrefix, includeLegacy = true): Set<string> {
  const candidates = new Set<string>([
    toolName,
    formatToolName(toolName, serverName, prefix),
    formatToolName(toolName, serverName, "server"),
    formatToolName(toolName, serverName, "short"),
    formatToolName(toolName, serverName, "mcp"),
  ]);
  if (includeLegacy) {
    const legacyToolName = toolName.replace(/-/g, "_");
    candidates.add(legacyToolName);
    candidates.add(formatToolName(legacyToolName, serverName, prefix));
    candidates.add(formatToolName(legacyToolName, serverName, "server"));
    candidates.add(formatToolName(legacyToolName, serverName, "short"));
    candidates.add(formatToolName(legacyToolName, serverName, "mcp"));
    candidates.add(formatLegacyToolName(toolName, serverName, prefix));
    candidates.add(formatLegacyToolName(toolName, serverName, "server"));
    candidates.add(formatLegacyToolName(toolName, serverName, "short"));
    candidates.add(formatLegacyToolName(toolName, serverName, "mcp"));
    candidates.add(formatToolName(toolName, serverName, prefix).replace(/-/g, "_"));
    candidates.add(formatToolName(toolName, serverName, "server").replace(/-/g, "_"));
    candidates.add(formatToolName(toolName, serverName, "short").replace(/-/g, "_"));
    candidates.add(formatToolName(toolName, serverName, "mcp").replace(/-/g, "_"));
  }
  return candidates;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export interface ToolSelectorCandidateIndex {
  readonly allCurrentCandidates: ReadonlySet<string>;
  readonly matchingCountByPattern: Map<string, number>;
  readonly matcherByPattern: Map<string, RegExp>;
  readonly additionalCurrentCandidatesByToolName?: ReadonlyMap<string, ReadonlySet<string>>;
}

export function createToolSelectorCandidateIndex(
  allCurrentCandidates: Set<string>,
  additionalCurrentCandidatesByToolName?: ReadonlyMap<string, ReadonlySet<string>>,
): ToolSelectorCandidateIndex {
  return {
    allCurrentCandidates,
    matchingCountByPattern: new Map<string, number>(),
    matcherByPattern: new Map<string, RegExp>(),
    ...(additionalCurrentCandidatesByToolName ? { additionalCurrentCandidatesByToolName } : {}),
  };
}

export function matchesToolPattern(candidates: Set<string>, patterns?: unknown): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;

  for (const pattern of patterns) {
    if (typeof pattern !== "string") continue;
    if (!pattern.includes("*") && !pattern.includes("?") && candidates.has(pattern)) {
      return true;
    }
    if ((pattern.includes("*") || pattern.includes("?")) && [...candidates].some(candidate => globToRegExp(pattern).test(candidate))) {
      return true;
    }
  }

  return false;
}

export type ToolSelectorCandidateContext = Set<string> | ToolSelectorCandidateIndex;

function indexHasOtherCurrentMatch(
  index: ToolSelectorCandidateIndex,
  toolName: string,
  currentCandidates: Set<string>,
  pattern: string,
): boolean {
  const additionalCandidates = index.additionalCurrentCandidatesByToolName?.get(toolName);
  const hasCandidate = (candidate: string): boolean =>
    index.allCurrentCandidates.has(candidate) || additionalCandidates?.has(candidate) === true;
  const isGlob = pattern.includes("*") || pattern.includes("?");
  if (!isGlob) {
    return hasCandidate(pattern) && !currentCandidates.has(pattern);
  }

  let matcher = index.matcherByPattern.get(pattern);
  if (!matcher) {
    matcher = globToRegExp(pattern);
    index.matcherByPattern.set(pattern, matcher);
  }
  let matchingCount = index.matchingCountByPattern.get(pattern);
  if (matchingCount === undefined) {
    matchingCount = 0;
    for (const candidate of index.allCurrentCandidates) {
      if (matcher.test(candidate)) matchingCount++;
    }
    index.matchingCountByPattern.set(pattern, matchingCount);
  }

  let totalMatchingCount = matchingCount;
  if (additionalCandidates) {
    for (const candidate of additionalCandidates) {
      if (!index.allCurrentCandidates.has(candidate) && matcher.test(candidate)) totalMatchingCount++;
    }
  }
  if (totalMatchingCount === 0) return false;

  let currentMatchingCount = 0;
  for (const candidate of currentCandidates) {
    if (hasCandidate(candidate) && matcher.test(candidate)) currentMatchingCount++;
  }
  return totalMatchingCount > currentMatchingCount;
}

function matchesToolSelector(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  patterns: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const currentCandidates = getToolNameCandidates(toolName, serverName, prefix, false);
  if (matchesToolPattern(currentCandidates, patterns)) return true;
  if (!otherCurrentCandidates) return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), patterns);
  const legacyCandidates = getToolNameCandidates(toolName, serverName, prefix);
  for (const candidate of currentCandidates) legacyCandidates.delete(candidate);
  return patterns.some(pattern => {
    if (typeof pattern !== "string" || !matchesToolPattern(legacyCandidates, [pattern])) return false;
    const hasCollision = otherCurrentCandidates instanceof Set
      ? matchesToolPattern(otherCurrentCandidates, [pattern])
      : indexHasOtherCurrentMatch(otherCurrentCandidates, toolName, currentCandidates, pattern);
    return !hasCollision;
  });
}

export function isToolIncluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  if (!Array.isArray(includeTools) || includeTools.length === 0) return true;
  return matchesToolSelector(toolName, serverName, prefix, includeTools, otherCurrentCandidates);
}

export function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  excludeTools?: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  return matchesToolSelector(toolName, serverName, prefix, excludeTools, otherCurrentCandidates);
}

export function isToolAllowed(
  toolName: string,
  serverName: string,
  prefix: ToolPrefix,
  includeTools?: unknown,
  excludeTools?: unknown,
  otherCurrentCandidates?: ToolSelectorCandidateContext,
): boolean {
  return isToolIncluded(toolName, serverName, prefix, includeTools, otherCurrentCandidates)
    && !isToolExcluded(toolName, serverName, prefix, excludeTools, otherCurrentCandidates);
}
