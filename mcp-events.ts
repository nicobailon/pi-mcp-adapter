/**
 * mcp-events.ts — MCP lifecycle events on `pi.events`.
 *
 * This module is the integration contract. It emits a typed, versioned event
 * on the shared PI event bus at each MCP server state transition, under the
 * reserved `mcp:` channel namespace, and (when a snapshot provider is set)
 * mirrors current state durably via `pi.appendEntry("mcp:state", …)`.
 *
 * Emission is fire-and-forget and additive: nothing here changes existing
 * tool/command/UI behaviour, and a missing or faulty sink can never wedge a
 * connection. Keep this file dependency-free so it stays trivially testable.
 *
 * Schema notes:
 * - `v` is mandatory; subscribers branch on it. Additive fields within a
 *   version are allowed; semantic changes bump `v`.
 * - No secrets, ever. `authorizationUrl` is the only auth-adjacent field and
 *   only for the interactive `auth_required` phase.
 */

/** Reserved channel namespace: every channel is prefixed "mcp:". */
export const MCP_EVENT_CHANNELS = {
  /** Connection / health lifecycle. */
  server: "mcp:server",
  /** Capability set changed. */
  tools: "mcp:tools",
  /** Remote-server OAuth. */
  auth: "mcp:auth",
} as const;

/** Durable session-entry customType written via `pi.appendEntry`. */
export const MCP_STATE_ENTRY_TYPE = "mcp:state";

/** Current schema version. Bump only on semantic (non-additive) changes. */
export const MCP_EVENT_VERSION = 1 as const;

/** Bound `mcp:tools.toolNames` so a huge server doesn't bloat every event. */
export const MCP_TOOL_NAMES_LIMIT = 100;

export type McpTransportKind = "stdio" | "http" | "sse";

export interface McpEventEnvelope {
  v: typeof MCP_EVENT_VERSION;
  /** Configured server key. */
  serverId: string;
  transport: McpTransportKind;
  /** Epoch ms. */
  at: number;
}

export type McpServerPhase =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "reconnected"
  | "idle_shutdown"
  | "errored";

/** channel: "mcp:server" — connection lifecycle. */
export type McpServerEvent = McpEventEnvelope & {
  phase: McpServerPhase;
  error?: { message: string; code?: string };
};

/** channel: "mcp:tools" — capability set changed. */
export type McpToolsEvent = McpEventEnvelope & {
  toolCount: number;
  /** Omitted for large servers to bound payload size. */
  toolNames?: string[];
  source: "connect" | "refresh" | "cache";
};

export type McpAuthPhase = "auth_required" | "auth_succeeded" | "auth_failed";

/** channel: "mcp:auth" — remote-server OAuth. */
export type McpAuthEvent = McpEventEnvelope & {
  phase: McpAuthPhase;
  /** Present only for the interactive "auth_required" phase. */
  authorizationUrl?: string;
  error?: { message: string };
};

export type McpStateStatus =
  | "connected"
  | "disconnected"
  | "needs-auth"
  | "failed"
  | "cached";

export interface McpStateSnapshotServer {
  serverId: string;
  transport: McpTransportKind;
  status: McpStateStatus;
  toolCount: number;
}

/** Durable snapshot written via `pi.appendEntry("mcp:state", …)`. */
export interface McpStateSnapshot {
  v: typeof MCP_EVENT_VERSION;
  at: number;
  servers: McpStateSnapshotServer[];
}

/**
 * Minimal subset of the PI `ExtensionAPI` this bus depends on. Keeping it a
 * structural type means tests can hand in a plain spy with no PI runtime.
 */
export interface McpEventSink {
  emit(channel: string, data: unknown): void;
  appendEntry?(customType: string, data: unknown): void;
}

export type McpStateSnapshotProvider = () => McpStateSnapshotServer[];

/** Normalize an arbitrary thrown value into the event `error` shape. */
export function toEventError(err: unknown): { message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" || typeof code === "number"
      ? { message: err.message, code: String(code) }
      : { message: err.message };
  }
  return { message: String(err) };
}

/**
 * Emits MCP lifecycle events on a sink (PI's `pi.events` + `pi.appendEntry`).
 *
 * Construct with no sink for a no-op bus — that is the default the manager and
 * lifecycle hold until `init.ts` wires the real PI sink, and what tests use
 * when they don't care about events.
 */
export class McpEventBus {
  private sink?: McpEventSink;
  private snapshotProvider?: McpStateSnapshotProvider;
  private readonly now: () => number;

  constructor(sink?: McpEventSink, now: () => number = Date.now) {
    this.sink = sink;
    this.now = now;
  }

  setSink(sink: McpEventSink | undefined): void {
    this.sink = sink;
  }

  /**
   * Register a provider of the current per-server snapshot. When set (and the
   * sink supports `appendEntry`), every emitted transition also writes a
   * durable `mcp:state` entry so a consumer attaching mid-session can
   * reconstruct state by replaying entries instead of racing a `status` pull.
   */
  setSnapshotProvider(provider: McpStateSnapshotProvider | undefined): void {
    this.snapshotProvider = provider;
  }

  emitServer(
    serverId: string,
    transport: McpTransportKind,
    phase: McpServerPhase,
    error?: { message: string; code?: string },
  ): void {
    const payload: McpServerEvent = {
      ...this.envelope(serverId, transport),
      phase,
      ...(error ? { error } : {}),
    };
    this.dispatch(MCP_EVENT_CHANNELS.server, payload);
  }

  emitTools(
    serverId: string,
    transport: McpTransportKind,
    toolCount: number,
    source: McpToolsEvent["source"],
    toolNames?: string[],
  ): void {
    const payload: McpToolsEvent = {
      ...this.envelope(serverId, transport),
      toolCount,
      source,
    };
    if (toolNames && toolNames.length > 0 && toolNames.length <= MCP_TOOL_NAMES_LIMIT) {
      payload.toolNames = toolNames;
    }
    this.dispatch(MCP_EVENT_CHANNELS.tools, payload);
  }

  emitAuth(
    serverId: string,
    transport: McpTransportKind,
    phase: McpAuthPhase,
    opts?: { authorizationUrl?: string; error?: { message: string } },
  ): void {
    const payload: McpAuthEvent = {
      ...this.envelope(serverId, transport),
      phase,
    };
    // authorizationUrl is interactive-only and never carried on success/failure.
    if (phase === "auth_required" && opts?.authorizationUrl) {
      payload.authorizationUrl = opts.authorizationUrl;
    }
    if (opts?.error) {
      payload.error = opts.error;
    }
    this.dispatch(MCP_EVENT_CHANNELS.auth, payload);
  }

  private envelope(serverId: string, transport: McpTransportKind): McpEventEnvelope {
    return { v: MCP_EVENT_VERSION, serverId, transport, at: this.now() };
  }

  private dispatch(channel: string, data: unknown): void {
    const sink = this.sink;
    if (!sink) return;
    // Fire-and-forget: a faulty subscriber or sink must never wedge a
    // connection. PI's EventBus already wraps handlers; this guards the
    // synchronous emit() call and our own snapshot mirror.
    try {
      sink.emit(channel, data);
    } catch (err) {
      console.error(`MCP: failed to emit ${channel}`, err);
    }
    this.mirrorSnapshot();
  }

  private mirrorSnapshot(): void {
    const sink = this.sink;
    const provider = this.snapshotProvider;
    if (!sink?.appendEntry || !provider) return;
    try {
      const snapshot: McpStateSnapshot = {
        v: MCP_EVENT_VERSION,
        at: this.now(),
        servers: provider(),
      };
      sink.appendEntry(MCP_STATE_ENTRY_TYPE, snapshot);
    } catch (err) {
      console.error("MCP: failed to append mcp:state snapshot", err);
    }
  }
}

/** Shared no-op bus used until a real PI sink is wired in. */
export const NOOP_EVENT_BUS = new McpEventBus();
