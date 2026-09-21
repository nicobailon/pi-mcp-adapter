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
import type {
  Client,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
  ElicitResult,
  JSONRPCMessage,
  JSONRPCRequest,
  Transport,
} from "@modelcontextprotocol/client";
import { ProtocolError } from "@modelcontextprotocol/client";
import {
  createApplicationInputHandler,
  createTaskSessionEndpointId,
  createTaskSessionFromClient,
  DispatchError,
  JsonRpcResponseError,
  resultFromTaskOutcome,
  TaskCancelledError,
  TaskFailedError,
  type ApplicationElicitContentValue,
  type RawClientDispatch,
  type TaskEnabledSession,
} from "@modelcontextprotocol/ext-tasks/client";
import type { ServerDefinition } from "./types.ts";
import { logger } from "./logger.ts";

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

const RAW_REQUEST_ID_PREFIX = "pi-mcp-tasks-";

const DEFAULT_RAW_REQUEST_TIMEOUT_MS = 60_000;
const LATE_TASK_HANDLE_GRACE_MS = 60_000;

type JsonRpcResponseShape = { kind: "result"; result: unknown } | {
  kind: "error";
  error: { code: number; message: string; data?: unknown };
};

interface PendingRawRequest {
  id: string;
  resolve: (response: JsonRpcResponseShape) => void;
  reject: (error: Error) => void;
  state: "pending" | "observing";
  signal?: AbortSignal;
  onAbort?: () => void;
  requestTimer?: ReturnType<typeof setTimeout>;
  observationTimer?: ReturnType<typeof setTimeout>;
  observationController?: AbortController;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("This operation was aborted", "AbortError");
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
export class RawRequestChannel {
  private readonly transport: Transport;
  private readonly pending = new Map<string, PendingRawRequest>();
  private requestCounter = 0;
  private readonly defaultTimeoutMs: number;
  private attached = false;

  constructor(transport: Transport, defaultTimeoutMs?: number) {
    this.transport = transport;
    this.defaultTimeoutMs = defaultTimeoutMs ?? DEFAULT_RAW_REQUEST_TIMEOUT_MS;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const previousOnMessage = this.transport.onmessage;
    this.transport.onmessage = (message, extra) => {
      if (this.consumeRawResponse(message)) return;
      previousOnMessage?.(message, extra);
    };
    const previousOnClose = this.transport.onclose;
    this.transport.onclose = () => {
      this.rejectAll("MCP connection closed");
      previousOnClose?.();
    };
  }

  /** Sends a raw JSON-RPC request and resolves with its correlated response. */
  rawDispatch: RawClientDispatch = (request, options) => {
    if (!isJsonRecord(request) || typeof request.method !== "string") {
      return Promise.reject(new Error("Raw MCP request must be a JSON object with a string method"));
    }
    const params = request.params;
    if (params !== undefined && !isJsonRecord(params)) {
      return Promise.reject(new Error("Raw MCP request params must be a JSON object"));
    }
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const id = `${RAW_REQUEST_ID_PREFIX}${++this.requestCounter}`;
    const message = {
      jsonrpc: "2.0",
      id,
      method: request.method,
      ...(params === undefined ? {} : { params }),
    } as unknown as JSONRPCRequest;
    const timeoutMs = options?.context?.requestTimeoutMs ?? this.defaultTimeoutMs;

    return new Promise<JsonRpcResponseShape>((resolve, reject) => {
      const entry: PendingRawRequest = {
        id,
        resolve,
        reject,
        state: "pending",
        ...(signal === undefined ? {} : { signal }),
        ...(message.method === "tools/call" ? { observationController: new AbortController() } : {}),
      };
      entry.requestTimer = setTimeout(() => {
        this.terminateLocalWait(entry, new Error(`MCP task request "${message.method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, entry);
      if (signal) {
        entry.onAbort = () => {
          this.terminateLocalWait(entry, abortError(signal));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      const fail = (error: unknown) => {
        if (this.pending.get(id) !== entry) return;
        const wasPending = entry.state === "pending";
        this.finishRequest(entry, true);
        if (wasPending) reject(error instanceof Error ? error : new Error(String(error)));
      };
      // ext-tasks supplies the SEP-2663 Mcp-Name routing header (and any
      // host headers) via context.headers. A task-producing tools/call owns
      // its transport observation independently from the caller's wait.
      try {
        Promise.resolve(this.transport.send(message, {
          ...(options?.context?.headers === undefined ? {} : { headers: options.context.headers }),
          ...(entry.observationController !== undefined
            ? { requestSignal: entry.observationController.signal }
            : signal === undefined ? {} : { requestSignal: signal }),
        })).catch(fail);
      } catch (error) {
        fail(error);
      }
    }) as ReturnType<RawClientDispatch>;
  };

  private consumeRawResponse(message: JSONRPCMessage): boolean {
    if (!("id" in message) || typeof message.id !== "string") return false;
    if (!message.id.startsWith(RAW_REQUEST_ID_PREFIX)) return false;
    // A server request may choose any string ID, including our client-side
    // prefix. Method-bearing frames still belong to the SDK request handler.
    if ("method" in message) return false;
    const entry = this.pending.get(message.id);
    if (!entry) return true; // ours, but already completed or its bounded observation expired
    const wasObserving = entry.state === "observing";
    this.finishRequest(entry, true);
    if (wasObserving) {
      this.cancelLateTask(message);
      return true;
    }
    if ("error" in message) {
      const { code, message: errorMessage, data } = message.error;
      entry.resolve({ kind: "error", error: { code, message: errorMessage, ...(data === undefined ? {} : { data }) } });
    } else if ("result" in message) {
      entry.resolve({ kind: "result", result: message.result });
    } else {
      entry.reject(new Error("MCP task response frame carried neither result nor error"));
    }
    return true;
  }

  private terminateLocalWait(entry: PendingRawRequest, error: Error): void {
    if (this.pending.get(entry.id) !== entry || entry.state !== "pending") return;
    if (entry.observationController === undefined) {
      this.finishRequest(entry, false);
    } else {
      entry.state = "observing";
      this.clearLocalWait(entry);
      entry.observationTimer = setTimeout(() => {
        this.finishRequest(entry, true);
      }, LATE_TASK_HANDLE_GRACE_MS);
    }
    entry.reject(error);
  }

  private clearLocalWait(entry: PendingRawRequest): void {
    if (entry.requestTimer !== undefined) clearTimeout(entry.requestTimer);
    delete entry.requestTimer;
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    delete entry.onAbort;
  }

  private finishRequest(entry: PendingRawRequest, abortObservation: boolean): void {
    if (this.pending.get(entry.id) !== entry) return;
    this.clearLocalWait(entry);
    if (entry.observationTimer !== undefined) clearTimeout(entry.observationTimer);
    delete entry.observationTimer;
    this.pending.delete(entry.id);
    if (abortObservation) entry.observationController?.abort();
  }

  private cancelLateTask(message: JSONRPCMessage): void {
    if (!("result" in message) || !isJsonRecord(message.result)) return;
    if (message.result.resultType !== "task" || typeof message.result.taskId !== "string") return;
    const taskId = message.result.taskId;
    void this.rawDispatch(
      { method: "tasks/cancel", params: { taskId } },
      { context: { headers: { "Mcp-Name": taskId } } },
    ).catch(() => {});
  }

  rejectAll(reason: string): void {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      const wasPending = entry.state === "pending";
      this.finishRequest(entry, true);
      if (wasPending) entry.reject(new Error(reason));
    }
  }
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
export function serverAdvertisesTasks(client: Client): boolean {
  if (client.getProtocolEra?.() !== "modern") return false;
  const capabilities = client.getServerCapabilities();
  const extension = (capabilities?.extensions as Record<string, unknown> | undefined)?.[TASKS_EXTENSION_ID];
  return isJsonRecord(extension) && Object.keys(extension).length === 0;
}

/** Missing-handler errors carry the SDK's capability shape so call sites can classify them. */
function capabilityNotSupportedError(serverName: string, method: string, inputKey: string | undefined): Error {
  const error = new Error(
    `MCP server ${serverName} requested ${method} during a task, but this session has no handler for it`,
  );
  Object.assign(error, {
    code: "CAPABILITY_NOT_SUPPORTED",
    data: { key: inputKey ?? "unknown", method },
  });
  return error;
}

export interface AttachTaskSessionOptions {
  client: Client;
  serverName: string;
  definition: ServerDefinition;
  transport: Transport;
  requestTimeoutMs?: number | undefined;
  clientInfo: { name: string; version: string };
  clientCapabilities: Record<string, unknown>;
  onElicitation?: (request: ElicitRequest, signal?: AbortSignal) => Promise<ElicitResult>;
  onSampling?: (request: CreateMessageRequest, signal?: AbortSignal) => Promise<CreateMessageResult>;
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
export async function attachTaskSession(
  options: AttachTaskSessionOptions,
): Promise<TaskSessionAttachment | undefined> {
  const { client, serverName, definition } = options;
  if (!serverAdvertisesTasks(client)) return undefined;
  const protocolVersion = client.getNegotiatedProtocolVersion?.();
  if (protocolVersion === undefined) return undefined;

  const endpointId = await createTaskSessionEndpointId("pi-mcp-adapter", {
    server: serverName,
    ...(definition.command !== undefined
      ? { transport: { type: "stdio", command: definition.command, args: definition.args ?? [] } }
      : definition.url !== undefined
        ? { transport: { type: "http", url: definition.url } }
        : { transport: { type: "unix-socket", socket: definition.socket ?? null } }),
  });

  const onInputRequest = createApplicationInputHandler({
    elicitation: async (request, context) => {
      if (options.onElicitation === undefined) {
        throw capabilityNotSupportedError(serverName, "elicitation/create", context.inputId);
      }
      const result = await options.onElicitation(
        { method: "elicitation/create", params: request.params } as unknown as ElicitRequest,
        context.signal,
      );
      return {
        action: result.action,
        ...(result.content === undefined
          ? {}
          : { content: result.content as Readonly<Record<string, ApplicationElicitContentValue>> }),
      };
    },
    sampling: async (request, context) => {
      if (options.onSampling === undefined) {
        throw capabilityNotSupportedError(serverName, "sampling/createMessage", context.inputId);
      }
      const result = await options.onSampling(
        { method: "sampling/createMessage", params: request.params } as unknown as CreateMessageRequest,
        context.signal,
      );
      return {
        model: result.model,
        role: result.role,
        content: result.content as never,
      };
    },
    roots: async () => ({ roots: [] }),
  });

  const channel = new RawRequestChannel(options.transport, options.requestTimeoutMs);
  channel.attach();
  const session = createTaskSessionFromClient(client, {
    endpointId,
    rawDispatch: channel.rawDispatch,
    v2RequestFraming: {
      protocolVersion,
      clientInfo: options.clientInfo,
      clientCapabilities: options.clientCapabilities as never,
    },
    // Tool declarations only add per-tool taskSupport hints; the adapter's
    // cached tools/list is not threaded through here, and a miss is harmless.
    tools: { currentTool: () => undefined },
    onInputRequest,
    onError: (error) => logger.warn(`ext-tasks background error for ${serverName}: ${String(error)}`),
  });
  // A downgraded session (server capability mismatch) would silently route
  // plain tool calls through the generic request path, skipping callTool's
  // output-schema validation. Refuse it and keep the plain path instead.
  if (!session.capabilities.execution) {
    await session.close().catch(() => {});
    channel.rejectAll("Task session downgraded");
    return undefined;
  }
  return { session, channel };
}

export interface TaskToolCallOptions {
  name: string;
  args: Record<string, unknown>;
  meta?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
  requestTimeoutMs?: number | undefined;
}

/**
 * Preserves error-shape parity with Client.callTool: JSON-RPC failures —
 * immediate (JsonRpcResponseError) or terminal task errors (TaskFailedError
 * with a code) — become the typed ProtocolError subclass for their code, so
 * call-site handling (session recovery, URL elicitation) keeps working.
 * Local failures rethrow their original cause instead of being relabeled.
 */
function toCallToolError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (error instanceof TaskCancelledError && signal?.aborted === true) {
    return abortError(signal);
  }
  if (error instanceof JsonRpcResponseError) {
    return ProtocolError.fromError(error.code, error.message, error.data);
  }
  if (error instanceof TaskFailedError && error.code !== undefined) {
    return ProtocolError.fromError(error.code, error.message, error.data);
  }
  if (error instanceof DispatchError) {
    return error.cause ?? error;
  }
  return error;
}

/**
 * Calls a tool through a task session and blocks until settlement, preserving
 * the plain callTool contract: an immediate result returns as-is, a
 * task-backed execution is polled to completion, a failed task throws the
 * underlying JSON-RPC error, and aborting cancels the remote task.
 */
export async function callToolViaTaskSession(
  session: TaskEnabledSession,
  options: TaskToolCallOptions,
): Promise<Record<string, unknown>> {
  const { signal } = options;
  let execution;
  try {
    execution = await session.callTool(options.name, options.args as never, {
      ...(options.meta === undefined ? {} : { metadata: options.meta as never }),
      ...(signal === undefined ? {} : { signal }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    });
  } catch (error) {
    throw toCallToolError(error, signal);
  }
  let onAbort: (() => void) | undefined;
  if (signal !== undefined && execution.kind === "task") {
    // settle({ signal }) only stops waiting locally; propagate the abort as a
    // cooperative remote cancellation so the server can stop the work. The
    // signal may have aborted while callTool was resolving, so fire directly
    // for an abort the listener would miss.
    onAbort = () => {
      void execution.cancel().catch(() => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const settlement = await execution.settle(signal === undefined ? {} : { signal });
    const result = resultFromTaskOutcome(settlement.outcome);
    if (!isJsonRecord(result)) {
      throw new Error(`Task-backed tool ${options.name} settled with a non-object result`);
    }
    // Match Client.callTool's lifted shape, which strips the wire-only discriminator.
    const { resultType: _resultType, ...lifted } = result;
    return lifted;
  } catch (error) {
    throw toCallToolError(error, signal);
  } finally {
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    await execution.close().catch(() => {});
  }
}
