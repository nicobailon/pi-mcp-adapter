/**
 * Centralized logging for MCP UI operations.
 * Provides structured, contextual logs with levels.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogContext {
    server?: string;
    session?: string;
    tool?: string;
    uri?: string;
    [key: string]: unknown;
}
export interface LogEntry {
    level: LogLevel;
    message: string;
    context?: LogContext;
    error?: Error;
    timestamp: Date;
}
type LogHandler = (entry: LogEntry) => void;
declare class Logger {
    private minLevel;
    private handlers;
    private defaultContext;
    setLevel(level: LogLevel): void;
    setDefaultContext(context: LogContext): void;
    addHandler(handler: LogHandler): void;
    clearHandlers(): void;
    private shouldLog;
    private emit;
    debug(message: string, context?: LogContext): void;
    info(message: string, context?: LogContext): void;
    warn(message: string, context?: LogContext): void;
    error(message: string, error?: Error, context?: LogContext): void;
    /**
     * Create a child logger with additional default context.
     */
    child(context: LogContext): ChildLogger;
}
declare class ChildLogger {
    private parent;
    private context;
    constructor(parent: Logger, context: LogContext);
    debug(message: string, context?: LogContext): void;
    info(message: string, context?: LogContext): void;
    warn(message: string, context?: LogContext): void;
    error(message: string, error?: Error, context?: LogContext): void;
    child(context: LogContext): ChildLogger;
}
export declare const logger: Logger;
export {};
