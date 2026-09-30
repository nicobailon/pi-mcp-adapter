import type { Transport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
export declare const MCP_TRACE_SCHEMA_VERSION = 1;
export declare const DEFAULT_MCP_TRACE_MAX_BYTES: number;
export declare const DEFAULT_MCP_TRACE_MAX_EVENTS = 10000;
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
    appendFile?: (path: string, data: string, options: {
        encoding: "utf8";
    }) => Promise<void>;
    writeFile?: (path: string, data: string, options: {
        encoding: "utf8";
    }) => Promise<void>;
    mkdir?: (path: string, options: {
        recursive: true;
    }) => Promise<string | undefined>;
}
/** Redact strings before they can become durable trace metadata. */
export declare function redactTraceText(value: string, maxLength?: number): string;
export declare function createMcpTraceEvent(direction: McpTraceDirection, server: string, transport: McpTraceTransport, message: JSONRPCMessage, status: "sent" | "received" | "error", options?: {
    relatedRequestId?: unknown;
    durationMs?: number;
}): McpTraceEvent;
export declare class McpTraceWriter {
    private readonly options;
    private readonly maxBytes;
    private readonly maxEvents;
    private readonly append;
    private readonly resetFile;
    private readonly makeDirectory;
    private bytesWritten;
    private eventsWritten;
    private queue;
    private disabled;
    private initializationFailed;
    private readonly fileReady;
    constructor(options: McpTraceWriterOptions);
    get filePath(): string;
    get isDisabled(): boolean;
    get stats(): {
        bytes: number;
        events: number;
    };
    write(event: McpTraceEvent): void;
    flush(): Promise<void>;
}
export declare function createMcpTraceWriter(sessionCwd: string | undefined, settings?: McpTraceSettings, randomSuffix?: string): McpTraceWriter;
export interface McpTraceObserver {
    record(event: McpTraceEvent): void;
}
export declare function isMcpTraceEnabled(definition: {
    trace?: boolean;
}, settings?: McpTraceSettings): boolean;
/**
 * Compose the SDK's transport callbacks in place instead of replacing the
 * transport object. SDK v2 detects its base stdio transport before connect so
 * it can run `server/discover` on a disposable sibling process; returning a
 * wrapper hides that identity and makes tracing change negotiation behavior.
 */
export declare function wrapTransportWithMcpTrace(transport: Transport, server: string, transportKind: McpTraceTransport, observer: McpTraceObserver): Transport;
export declare function traceTransportKind(definition: {
    command?: string;
    url?: string;
    socket?: string;
}, transport: Transport): McpTraceTransport;
