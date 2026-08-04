import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Transport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/client";

export const MCP_TRACE_SCHEMA_VERSION = 1;
export const DEFAULT_MCP_TRACE_MAX_BYTES = 256 * 1024;
export const DEFAULT_MCP_TRACE_MAX_EVENTS = 10_000;

export type McpTraceDirection = "outbound" | "inbound";
export type McpTraceTransport = "stdio" | "unix-socket" | "sse" | "streamable-http" | "unknown";
export type McpTraceMessageKind = "request" | "response" | "notification";

export interface McpTraceSettings {
  /** Enable metadata-only protocol tracing for all servers unless overridden. */
  enabled?: boolean;
  /** JSONL destination. Relative paths are resolved from the session cwd. */
  file?: string;
  /** Maximum bytes retained in the per-session JSONL file. */
  maxBytes?: number;
  /** Maximum events retained in the per-session JSONL file. */
  maxEvents?: number;
}

export interface McpTraceEvent {
  version: typeof MCP_TRACE_SCHEMA_VERSION;
  timestamp: string;
  direction: McpTraceDirection;
  server: string;
  transport: McpTraceTransport;
  kind: McpTraceMessageKind;
  status: "sent" | "received" | "error";
  method?: string;
  id?: string | number | null;
  relatedRequestId?: string | number;
  errorCode?: number | string;
  bytes?: number;
  durationMs?: number;
}

export interface McpTraceWriterOptions {
  filePath: string;
  maxBytes?: number;
  maxEvents?: number;
  appendFile?: (path: string, data: string, options: { encoding: "utf8" }) => Promise<void>;
  writeFile?: (path: string, data: string, options: { encoding: "utf8" }) => Promise<void>;
  mkdir?: (path: string, options: { recursive: true }) => Promise<string | undefined>;
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}

/** Redact strings before they can become durable trace metadata. */
export function redactTraceText(value: string, maxLength = 160): string {
  if (/\b(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\b/i.test(value)) {
    return "[REDACTED]";
  }
  let redacted = value
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_AUTH]")
    .replace(/\b(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  if (redacted.length > maxLength) redacted = `${redacted.slice(0, maxLength - 1)}…`;
  return redacted;
}

function messageKind(message: JSONRPCMessage): McpTraceMessageKind {
  if ("method" in message) return "id" in message ? "request" : "notification";
  return "response";
}

function traceId(value: unknown): string | number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return "[REDACTED_ID]";
  return undefined;
}

function messageBytes(message: JSONRPCMessage): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(message), "utf8");
  } catch {
    return undefined;
  }
}

export function createMcpTraceEvent(
  direction: McpTraceDirection,
  server: string,
  transport: McpTraceTransport,
  message: JSONRPCMessage,
  status: "sent" | "received" | "error",
  options?: { relatedRequestId?: unknown; durationMs?: number },
): McpTraceEvent {
  const kind = messageKind(message);
  const bytes = messageBytes(message);
  const event: McpTraceEvent = {
    version: MCP_TRACE_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    direction,
    server: redactTraceText(server, 120),
    transport,
    kind,
    status,
    ...(bytes !== undefined ? { bytes } : {}),
  };
  if ("method" in message) event.method = redactTraceText(message.method, 120);
  if ("id" in message) event.id = traceId(message.id) ?? null;
  const relatedRequestId = traceId(options?.relatedRequestId);
  if (relatedRequestId !== undefined && relatedRequestId !== null) event.relatedRequestId = relatedRequestId;
  if ("error" in message && message.error && typeof message.error.code === "number") {
    event.errorCode = message.error.code;
  }
  if (options?.durationMs !== undefined && Number.isFinite(options.durationMs)) {
    event.durationMs = Math.max(0, Math.round(options.durationMs * 100) / 100);
  }
  return event;
}

export class McpTraceWriter {
  private readonly maxBytes: number;
  private readonly maxEvents: number;
  private readonly append: NonNullable<McpTraceWriterOptions["appendFile"]>;
  private readonly resetFile: NonNullable<McpTraceWriterOptions["writeFile"]>;
  private readonly makeDirectory: NonNullable<McpTraceWriterOptions["mkdir"]>;
  private bytesWritten = 0;
  private eventsWritten = 0;
  private queue = Promise.resolve();
  private disabled = false;
  private initializationFailed = false;
  private readonly fileReady: Promise<void>;

  constructor(private readonly options: McpTraceWriterOptions) {
    this.maxBytes = boundedPositiveInteger(options.maxBytes, DEFAULT_MCP_TRACE_MAX_BYTES);
    this.maxEvents = boundedPositiveInteger(options.maxEvents, DEFAULT_MCP_TRACE_MAX_EVENTS);
    this.append = options.appendFile ?? (async (path, data, appendOptions) => {
      await appendFile(path, data, appendOptions);
    });
    this.resetFile = options.writeFile ?? (async (path, data, writeOptions) => {
      await writeFile(path, data, writeOptions);
    });
    this.makeDirectory = options.mkdir ?? (async path => {
      await mkdir(path, { recursive: true });
      return undefined;
    });
    this.fileReady = this.makeDirectory(dirname(this.options.filePath), { recursive: true })
      .then(() => this.resetFile(this.options.filePath, "", { encoding: "utf8" }))
      .catch(() => {
        // Tracing must never change MCP request/response behavior.
        this.initializationFailed = true;
        this.disabled = true;
      });
  }

  get filePath(): string {
    return this.options.filePath;
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  get stats(): { bytes: number; events: number } {
    return { bytes: this.bytesWritten, events: this.eventsWritten };
  }

  write(event: McpTraceEvent): void {
    if (this.disabled || this.eventsWritten >= this.maxEvents) return;
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch {
      this.disabled = true;
      return;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxBytes - this.bytesWritten) {
      this.disabled = true;
      return;
    }

    this.bytesWritten += bytes;
    this.eventsWritten += 1;
    this.queue = this.queue.then(async () => {
      await this.fileReady;
      if (this.initializationFailed) return;
      await this.append(this.options.filePath, line, { encoding: "utf8" });
    }).catch(() => {
      // Tracing must never change MCP request/response behavior.
      this.disabled = true;
    });
  }

  async flush(): Promise<void> {
    await this.fileReady;
    await this.queue;
  }
}

export function createMcpTraceWriter(
  sessionCwd: string | undefined,
  settings: McpTraceSettings = {},
  randomSuffix = Math.random().toString(36).slice(2, 10),
): McpTraceWriter {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const configuredPath = settings.file;
  const filePath = configuredPath
    ? (isAbsolute(configuredPath) ? configuredPath : resolve(sessionCwd ?? process.cwd(), configuredPath))
    : resolve(sessionCwd ?? process.cwd(), ".pi", "mcp-traces", `mcp-${timestamp}-${randomSuffix}.jsonl`);
  return new McpTraceWriter({
    filePath,
    ...(settings.maxBytes !== undefined ? { maxBytes: settings.maxBytes } : {}),
    ...(settings.maxEvents !== undefined ? { maxEvents: settings.maxEvents } : {}),
  });
}

export interface McpTraceObserver {
  record(event: McpTraceEvent): void;
}

export function isMcpTraceEnabled(
  definition: { trace?: boolean },
  settings?: McpTraceSettings,
): boolean {
  return definition.trace ?? settings?.enabled === true;
}

/**
 * Compose the SDK's transport callbacks in place instead of replacing the
 * transport object. SDK v2 detects its base stdio transport before connect so
 * it can run `server/discover` on a disposable sibling process; returning a
 * wrapper hides that identity and makes tracing change negotiation behavior.
 */
export function wrapTransportWithMcpTrace(
  transport: Transport,
  server: string,
  transportKind: McpTraceTransport,
  observer: McpTraceObserver,
): Transport {
  let messageHandler = transport.onmessage;
  let tracedMessageHandler: Transport["onmessage"];
  const originalSend = transport.send;
  const record = (event: McpTraceEvent): void => {
    try {
      observer.record(event);
    } catch {
      // An observer failure must never alter SDK transport behavior.
    }
  };

  try {
    Object.defineProperty(transport, "onmessage", {
      configurable: true,
      enumerable: true,
      get() {
        return tracedMessageHandler;
      },
      set(handler: Transport["onmessage"]) {
        messageHandler = handler;
        tracedMessageHandler = handler
          ? ((message: JSONRPCMessage, extra?: MessageExtraInfo) => {
              record(createMcpTraceEvent("inbound", server, transportKind, message, "received"));
              handler(message, extra);
            })
          : undefined;
      },
    });
    transport.onmessage = messageHandler;
  } catch {
    // Some future transport may make onmessage non-configurable. Keep tracing
    // best-effort rather than changing connection behavior.
  }

  transport.send = async (message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]) => {
    const started = performance.now();
    const messages = Array.isArray(message) ? message : [message];
    try {
      await originalSend.call(transport, message, options);
      for (const item of messages) {
        record(createMcpTraceEvent("outbound", server, transportKind, item, "sent", {
          durationMs: performance.now() - started,
        }));
      }
    } catch (error) {
      for (const item of messages) {
        record(createMcpTraceEvent("outbound", server, transportKind, item, "error", {
          durationMs: performance.now() - started,
        }));
      }
      throw error;
    }
  };

  return transport;
}

export function traceTransportKind(definition: { command?: string; url?: string; socket?: string }, transport: Transport): McpTraceTransport {
  if (definition.command) return "stdio";
  if (definition.socket) return "unix-socket";
  const constructorName = transport.constructor?.name.toLowerCase() ?? "";
  if (constructorName.includes("sse")) return "sse";
  if (constructorName.includes("streamable")) return "streamable-http";
  return definition.url ? "streamable-http" : "unknown";
}
