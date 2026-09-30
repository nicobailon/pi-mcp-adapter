/**
 * Centralized logging for MCP UI operations.
 * Provides structured, contextual logs with levels.
 */
const LEVEL_PRIORITY = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
const LEVEL_PREFIX = {
    debug: "[MCP-UI:DEBUG]",
    info: "[MCP-UI]",
    warn: "[MCP-UI:WARN]",
    error: "[MCP-UI:ERROR]",
};
class Logger {
    minLevel = "info";
    handlers = [];
    defaultContext = {};
    setLevel(level) {
        this.minLevel = level;
    }
    setDefaultContext(context) {
        this.defaultContext = context;
    }
    addHandler(handler) {
        this.handlers.push(handler);
    }
    clearHandlers() {
        this.handlers = [];
    }
    shouldLog(level) {
        return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
    }
    emit(level, message, context, error) {
        if (!this.shouldLog(level))
            return;
        const entry = {
            level,
            message,
            context: { ...this.defaultContext, ...context },
            ...(error !== undefined ? { error } : {}),
            timestamp: new Date(),
        };
        // Default console output
        const prefix = LEVEL_PREFIX[level];
        const contextStr = formatContext(entry.context);
        const fullMessage = contextStr ? `${prefix} ${message} ${contextStr}` : `${prefix} ${message}`;
        if (level === "error") {
            console.error(fullMessage, error ?? "");
        }
        else if (level === "warn") {
            console.warn(fullMessage);
        }
        else if (level === "debug") {
            console.debug(fullMessage);
        }
        else {
            console.log(fullMessage);
        }
        // Custom handlers
        for (const handler of this.handlers) {
            try {
                handler(entry);
            }
            catch {
                // Ignore handler errors
            }
        }
    }
    debug(message, context) {
        this.emit("debug", message, context);
    }
    info(message, context) {
        this.emit("info", message, context);
    }
    warn(message, context) {
        this.emit("warn", message, context);
    }
    error(message, error, context) {
        this.emit("error", message, context, error);
    }
    /**
     * Create a child logger with additional default context.
     */
    child(context) {
        return new ChildLogger(this, context);
    }
}
class ChildLogger {
    parent;
    context;
    constructor(parent, context) {
        this.parent = parent;
        this.context = context;
    }
    debug(message, context) {
        this.parent.debug(message, { ...this.context, ...context });
    }
    info(message, context) {
        this.parent.info(message, { ...this.context, ...context });
    }
    warn(message, context) {
        this.parent.warn(message, { ...this.context, ...context });
    }
    error(message, error, context) {
        this.parent.error(message, error, { ...this.context, ...context });
    }
    child(context) {
        return new ChildLogger(this.parent, { ...this.context, ...context });
    }
}
function formatContext(context) {
    if (!context || Object.keys(context).length === 0)
        return "";
    const parts = [];
    for (const [key, value] of Object.entries(context)) {
        if (value !== undefined && value !== null) {
            parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
        }
    }
    return parts.length > 0 ? `(${parts.join(", ")})` : "";
}
// Singleton instance
export const logger = new Logger();
// Enable debug mode via environment variable
if (process.env.MCP_UI_DEBUG === "1" || process.env.MCP_UI_DEBUG === "true") {
    logger.setLevel("debug");
}
//# sourceMappingURL=logger.js.map