import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, isAbsolute, resolve } from "node:path";
export const MCP_TRACE_SCHEMA_VERSION = 1;
export const DEFAULT_MCP_TRACE_MAX_BYTES = 256 * 1024;
export const DEFAULT_MCP_TRACE_MAX_EVENTS = 10_000;
function boundedPositiveInteger(value, fallback) {
    if (!Number.isFinite(value) || value === undefined || value <= 0)
        return fallback;
    return Math.floor(value);
}
/** Redact strings before they can become durable trace metadata. */
export function redactTraceText(value, maxLength = 160) {
    if (/\b(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\b/i.test(value)) {
        return "[REDACTED]";
    }
    let redacted = value
        .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
        .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_AUTH]")
        .replace(/\b(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
    if (redacted.length > maxLength)
        redacted = `${redacted.slice(0, maxLength - 1)}…`;
    return redacted;
}
function messageKind(message) {
    if ("method" in message)
        return "id" in message ? "request" : "notification";
    return "response";
}
function traceId(value) {
    if (value === null)
        return null;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string")
        return "[REDACTED_ID]";
    return undefined;
}
function messageBytes(message) {
    try {
        return Buffer.byteLength(JSON.stringify(message), "utf8");
    }
    catch {
        return undefined;
    }
}
export function createMcpTraceEvent(direction, server, transport, message, status, options) {
    const kind = messageKind(message);
    const bytes = messageBytes(message);
    const event = {
        version: MCP_TRACE_SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        direction,
        server: redactTraceText(server, 120),
        transport,
        kind,
        status,
        ...(bytes !== undefined ? { bytes } : {}),
    };
    if ("method" in message)
        event.method = redactTraceText(message.method, 120);
    if ("id" in message)
        event.id = traceId(message.id) ?? null;
    const relatedRequestId = traceId(options?.relatedRequestId);
    if (relatedRequestId !== undefined && relatedRequestId !== null)
        event.relatedRequestId = relatedRequestId;
    if ("error" in message && message.error && typeof message.error.code === "number") {
        event.errorCode = message.error.code;
    }
    if (options?.durationMs !== undefined && Number.isFinite(options.durationMs)) {
        event.durationMs = Math.max(0, Math.round(options.durationMs * 100) / 100);
    }
    return event;
}
export class McpTraceWriter {
    options;
    maxBytes;
    maxEvents;
    append;
    resetFile;
    makeDirectory;
    bytesWritten = 0;
    eventsWritten = 0;
    queue = Promise.resolve();
    disabled = false;
    initializationFailed = false;
    fileReady;
    constructor(options) {
        this.options = options;
        this.maxBytes = boundedPositiveInteger(options.maxBytes, DEFAULT_MCP_TRACE_MAX_BYTES);
        this.maxEvents = boundedPositiveInteger(options.maxEvents, DEFAULT_MCP_TRACE_MAX_EVENTS);
        this.append = options.appendFile ?? (async (path, data, appendOptions) => {
            await appendFile(path, data, appendOptions);
        });
        this.resetFile = options.writeFile ?? (async (path, data, writeOptions) => {
            await writeFile(path, data, writeOptions);
        });
        this.makeDirectory = options.mkdir ?? (async (path) => {
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
    get filePath() {
        return this.options.filePath;
    }
    get isDisabled() {
        return this.disabled;
    }
    get stats() {
        return { bytes: this.bytesWritten, events: this.eventsWritten };
    }
    write(event) {
        if (this.disabled || this.eventsWritten >= this.maxEvents)
            return;
        let line;
        try {
            line = `${JSON.stringify(event)}\n`;
        }
        catch {
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
            if (this.initializationFailed)
                return;
            await this.append(this.options.filePath, line, { encoding: "utf8" });
        }).catch(() => {
            // Tracing must never change MCP request/response behavior.
            this.disabled = true;
        });
    }
    async flush() {
        await this.fileReady;
        await this.queue;
    }
}
export function createMcpTraceWriter(sessionCwd, settings = {}, randomSuffix = Math.random().toString(36).slice(2, 10)) {
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
export function isMcpTraceEnabled(definition, settings) {
    return definition.trace ?? settings?.enabled === true;
}
/**
 * Compose the SDK's transport callbacks in place instead of replacing the
 * transport object. SDK v2 detects its base stdio transport before connect so
 * it can run `server/discover` on a disposable sibling process; returning a
 * wrapper hides that identity and makes tracing change negotiation behavior.
 */
export function wrapTransportWithMcpTrace(transport, server, transportKind, observer) {
    let messageHandler = transport.onmessage;
    let tracedMessageHandler;
    const originalSend = transport.send;
    const record = (event) => {
        try {
            observer.record(event);
        }
        catch {
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
            set(handler) {
                messageHandler = handler;
                tracedMessageHandler = handler
                    ? ((message, extra) => {
                        record(createMcpTraceEvent("inbound", server, transportKind, message, "received"));
                        handler(message, extra);
                    })
                    : undefined;
            },
        });
        transport.onmessage = messageHandler;
    }
    catch {
        // Some future transport may make onmessage non-configurable. Keep tracing
        // best-effort rather than changing connection behavior.
    }
    transport.send = async (message, options) => {
        const started = performance.now();
        const messages = Array.isArray(message) ? message : [message];
        try {
            await originalSend.call(transport, message, options);
            for (const item of messages) {
                record(createMcpTraceEvent("outbound", server, transportKind, item, "sent", {
                    durationMs: performance.now() - started,
                }));
            }
        }
        catch (error) {
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
export function traceTransportKind(definition, transport) {
    if (definition.command)
        return "stdio";
    if (definition.socket)
        return "unix-socket";
    const constructorName = transport.constructor?.name.toLowerCase() ?? "";
    if (constructorName.includes("sse"))
        return "sse";
    if (constructorName.includes("streamable"))
        return "streamable-http";
    return definition.url ? "streamable-http" : "unknown";
}
//# sourceMappingURL=mcp-trace.js.map