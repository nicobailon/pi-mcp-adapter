/**
 * Custom error types for MCP UI operations.
 * Provides structured errors with context and recovery hints.
 */
export interface McpUiErrorContext {
    server?: string;
    tool?: string;
    uri?: string;
    session?: string;
    [key: string]: unknown;
}
/**
 * Base error class for MCP UI errors.
 */
export declare class McpUiError extends Error {
    readonly code: string;
    readonly context: McpUiErrorContext;
    readonly recoveryHint: string | undefined;
    readonly cause: Error | undefined;
    constructor(message: string, options: {
        code: string;
        context?: McpUiErrorContext;
        recoveryHint?: string;
        cause?: Error;
    });
    toJSON(): Record<string, unknown>;
}
/**
 * Error fetching a UI resource from the MCP server.
 */
export declare class ResourceFetchError extends McpUiError {
    constructor(uri: string, reason: string, options?: {
        server?: string;
        cause?: Error;
    });
}
/**
 * Error parsing or validating UI resource content.
 */
export declare class ResourceParseError extends McpUiError {
    constructor(uri: string, reason: string, options?: {
        server?: string;
        mimeType?: string;
    });
}
/**
 * Error connecting to the AppBridge.
 */
export declare class BridgeConnectionError extends McpUiError {
    constructor(reason: string, options?: {
        session?: string;
        cause?: Error;
    });
}
/**
 * Error related to user consent for tool calls.
 */
export declare class ConsentError extends McpUiError {
    readonly denied: boolean;
    constructor(server: string, options: {
        denied?: boolean;
        requiresApproval?: boolean;
    });
}
/**
 * Error with UI server session management.
 */
export declare class SessionError extends McpUiError {
    constructor(reason: string, options?: {
        session?: string;
        cause?: Error;
    });
}
/**
 * Error starting or operating the UI server.
 */
export declare class ServerError extends McpUiError {
    constructor(reason: string, options?: {
        port?: number;
        cause?: Error;
    });
}
/**
 * Error communicating with the MCP server.
 */
export declare class McpServerError extends McpUiError {
    constructor(server: string, reason: string, options?: {
        tool?: string;
        cause?: Error;
    });
}
/**
 * Wrap an unknown error into an McpUiError.
 */
export declare function wrapError(error: unknown, context?: McpUiErrorContext): McpUiError;
/**
 * Check if an error is a specific MCP UI error type.
 */
export declare function isErrorCode(error: unknown, code: string): boolean;
/**
 * Stable adapter error code for an SDK-native input_required result that the
 * current client cannot fulfil because its embedded-request handler is not
 * registered. The SDK keeps the request key/method in `SdkError.data`; this
 * adapter detail intentionally copies only bounded, actionable fields.
 */
export declare const INPUT_REQUIRED_NEEDS_UI: "input_required_needs_ui";
export interface InputRequiredNeedsUiDetails {
    error: typeof INPUT_REQUIRED_NEEDS_UI;
    server: string;
    tool?: string;
    resourceUri?: string;
    inputKey: string;
    inputMethod: string;
    message: string;
}
export interface InputRequiredIdentity {
    server: string;
    tool?: string;
    resourceUri?: string;
}
/**
 * Convert a missing embedded-input handler into an adapter-owned result
 * detail. Matching requires the SDK's typed code/data shape (or this module's
 * typed wrapper), rather than arbitrary error-message text.
 */
export declare function getInputRequiredNeedsUiDetails(error: unknown, identity: InputRequiredIdentity): InputRequiredNeedsUiDetails | undefined;
/** Error form used by UiResourceHandler so an outer tool call can preserve the classification. */
export declare class InputRequiredNeedsUiError extends McpUiError {
    readonly details: InputRequiredNeedsUiDetails;
    constructor(details: InputRequiredNeedsUiDetails, cause?: Error);
}
