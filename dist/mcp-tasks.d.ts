/**
 * MCP Tasks extension support (io.modelcontextprotocol/tasks, SEP-2663).
 *
 * Built on @modelcontextprotocol/ext-tasks, the official requester-side
 * package. On 2026-07-28 connections the SDK client's wire codec rejects
 * task-shaped traffic (resultType: "task" inbound, tasks/* methods outbound),
 * so ext-tasks requires a host-supplied raw dispatch channel: a way to send
 * JSON-RPC frames on the connection's transport and correlate their responses
 * below the SDK client. RawRequestChannel provides that channel, mirroring
 * the reference integration in the MCP Inspector.
 *
 * The channel attaches to the already-connected transport by chaining its
 * message and close handlers, never replacing the transport object itself.
 * This keeps the transport's class identity and optional surface
 * (hasPerRequestStream, stdio stderr/pid) intact for the SDK's version
 * negotiation probe and per-request-stream cancellation, and it means inbound
 * raw responses pass through an installed trace wrapper before being
 * consumed, so both directions of task traffic appear in /mcp-trace.
 *
 * Enabled per server via `tasks: true`. A task session is only attached when
 * the connected 2026-07-28 server advertises the extension, so non-task
 * servers keep the exact pre-existing call path.
 */
import type { Client, CreateMessageRequest, CreateMessageResult, ElicitRequest, ElicitResult, Transport } from "@modelcontextprotocol/client";
import { type ApplicationRoot, type RawClientDispatch, type TaskEnabledSession } from "@modelcontextprotocol/ext-tasks/client";
import type { ServerDefinition } from "./types.ts";
export declare const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
/**
 * Raw JSON-RPC request channel chained onto a connected transport. Raw
 * requests use string ids with a reserved prefix, which cannot collide with
 * the SDK's numeric ids; their responses are consumed before the SDK client
 * sees them. All other traffic passes through unchanged.
 *
 * Attach only after Client.connect has installed its transport handlers:
 * attach() reads the current onmessage/onclose (through any wrapper
 * accessors) and chains in front of them.
 */
export declare class RawRequestChannel {
    private readonly transport;
    private readonly pending;
    private requestCounter;
    private readonly defaultTimeoutMs;
    private attached;
    constructor(transport: Transport, defaultTimeoutMs?: number);
    attach(): void;
    /** Sends a raw JSON-RPC request and resolves with its correlated response. */
    rawDispatch: RawClientDispatch;
    private consumeRawResponse;
    private terminateLocalWait;
    private clearLocalWait;
    private finishRequest;
    private cancelLateTask;
    rejectAll(reason: string): void;
}
/**
 * Whether a connected 2026-07-28 server advertises the tasks extension.
 * ext-tasks requires the exact empty-object declaration; anything else
 * downgrades the session, so mirror its check here.
 *
 * Legacy (2025-11-25) task servers are intentionally out of scope: driving
 * their opt-in `task` parameter requires per-tool taskSupport declarations,
 * which this integration does not supply.
 */
export declare function serverAdvertisesTasks(client: Client): boolean;
export interface AttachTaskSessionOptions {
    client: Client;
    serverName: string;
    definition: ServerDefinition;
    transport: Transport;
    requestTimeoutMs?: number | undefined;
    clientInfo: {
        name: string;
        version: string;
    };
    clientCapabilities: Record<string, unknown>;
    onElicitation?: (request: ElicitRequest, signal?: AbortSignal) => Promise<ElicitResult>;
    onSampling?: (request: CreateMessageRequest, signal?: AbortSignal) => Promise<CreateMessageResult>;
    /** What a task's roots input request gets; the same list the connection's roots/list handler returns. */
    roots?: ApplicationRoot[] | undefined;
}
export interface TaskSessionAttachment {
    session: TaskEnabledSession;
    channel: RawRequestChannel;
}
/**
 * Attaches an ext-tasks requester session to a connected client when the
 * server advertises task support. Returns undefined otherwise, leaving the
 * plain callTool path untouched.
 */
export declare function attachTaskSession(options: AttachTaskSessionOptions): Promise<TaskSessionAttachment | undefined>;
export interface TaskToolCallOptions {
    name: string;
    args: Record<string, unknown>;
    meta?: Record<string, unknown> | undefined;
    signal?: AbortSignal | undefined;
    requestTimeoutMs?: number | undefined;
}
/**
 * Calls a tool through a task session and blocks until settlement, preserving
 * the plain callTool contract: an immediate result returns as-is, a
 * task-backed execution is polled to completion, a failed task throws the
 * underlying JSON-RPC error, and aborting cancels the remote task.
 */
export declare function callToolViaTaskSession(session: TaskEnabledSession, options: TaskToolCallOptions): Promise<Record<string, unknown>>;
type ToolCallExecution = Awaited<ReturnType<TaskEnabledSession["callTool"]>>;
export type BackgroundToolExecution = Extract<ToolCallExecution, {
    kind: "task";
}>;
export type StartedToolCall = {
    kind: "result";
    result: Record<string, unknown>;
} | {
    kind: "task";
    execution: BackgroundToolExecution;
    taskId: string;
};
/**
 * Like callToolViaTaskSession, but returns a task-backed execution as soon as
 * the server hands out its task. The caller owns the returned execution.
 * Aborting `signal` before the handle arrives cancels the task; aborting it
 * afterwards doesn't touch it.
 */
export declare function startToolViaTaskSession(session: TaskEnabledSession, options: TaskToolCallOptions): Promise<StartedToolCall>;
export {};
