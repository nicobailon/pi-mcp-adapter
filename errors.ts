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
export class McpUiError extends Error {
  readonly code: string;
  readonly context: McpUiErrorContext;
  readonly recoveryHint: string | undefined;
  readonly cause: Error | undefined;

  constructor(
    message: string,
    options: {
      code: string;
      context?: McpUiErrorContext;
      recoveryHint?: string;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = "McpUiError";
    this.code = options.code;
    this.context = options.context ?? {};
    this.recoveryHint = options.recoveryHint;
    this.cause = options.cause;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      recoveryHint: this.recoveryHint,
      stack: this.stack,
    };
  }
}

/**
 * Error fetching a UI resource from the MCP server.
 */
export class ResourceFetchError extends McpUiError {
  constructor(
    uri: string,
    reason: string,
    options?: { server?: string; cause?: Error }
  ) {
    super(`Failed to fetch UI resource "${uri}": ${reason}`, {
      code: "RESOURCE_FETCH_ERROR",
      context: { uri, ...(options?.server !== undefined ? { server: options.server } : {}) },
      recoveryHint: "Check that the MCP server is connected and the resource URI is valid.",
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = "ResourceFetchError";
  }
}

/**
 * Error parsing or validating UI resource content.
 */
export class ResourceParseError extends McpUiError {
  constructor(
    uri: string,
    reason: string,
    options?: { server?: string; mimeType?: string }
  ) {
    super(`Invalid UI resource "${uri}": ${reason}`, {
      code: "RESOURCE_PARSE_ERROR",
      context: {
        uri,
        ...(options?.server !== undefined ? { server: options.server } : {}),
        ...(options?.mimeType !== undefined ? { mimeType: options.mimeType } : {}),
      },
      recoveryHint: "Ensure the resource returns valid HTML with the correct MIME type.",
    });
    this.name = "ResourceParseError";
  }
}

/**
 * Error connecting to the AppBridge.
 */
export class BridgeConnectionError extends McpUiError {
  constructor(reason: string, options?: { session?: string; cause?: Error }) {
    super(`AppBridge connection failed: ${reason}`, {
      code: "BRIDGE_CONNECTION_ERROR",
      context: options?.session !== undefined ? { session: options.session } : {},
      recoveryHint: "Check browser console for detailed errors. The iframe may have failed to load.",
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = "BridgeConnectionError";
  }
}

/**
 * Error related to user consent for tool calls.
 */
export class ConsentError extends McpUiError {
  readonly denied: boolean;

  constructor(
    server: string,
    options: { denied?: boolean; requiresApproval?: boolean }
  ) {
    const message = options.denied
      ? `Tool calls for "${server}" were denied for this session`
      : `Tool call approval required for "${server}"`;

    super(message, {
      code: options.denied ? "CONSENT_DENIED" : "CONSENT_REQUIRED",
      context: { server },
      recoveryHint: options.denied
        ? "The user denied tool access. Start a new session to try again."
        : "Prompt the user for consent before calling tools.",
    });
    this.name = "ConsentError";
    this.denied = options.denied ?? false;
  }
}

/**
 * Error with UI server session management.
 */
export class SessionError extends McpUiError {
  constructor(
    reason: string,
    options?: { session?: string; cause?: Error }
  ) {
    super(`Session error: ${reason}`, {
      code: "SESSION_ERROR",
      context: options?.session !== undefined ? { session: options.session } : {},
      recoveryHint: "The session may have expired or been closed. Try opening the UI again.",
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = "SessionError";
  }
}

/**
 * Error starting or operating the UI server.
 */
export class ServerError extends McpUiError {
  constructor(
    reason: string,
    options?: { port?: number; cause?: Error }
  ) {
    super(`UI server error: ${reason}`, {
      code: "SERVER_ERROR",
      context: options?.port !== undefined ? { port: options.port } : {},
      recoveryHint: "Check if the port is available. Another process may be using it.",
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = "ServerError";
  }
}

/**
 * Error communicating with the MCP server.
 */
export class McpServerError extends McpUiError {
  constructor(
    server: string,
    reason: string,
    options?: { tool?: string; cause?: Error }
  ) {
    super(`MCP server "${server}" error: ${reason}`, {
      code: "MCP_SERVER_ERROR",
      context: { server, ...(options?.tool !== undefined ? { tool: options.tool } : {}) },
      recoveryHint: "Check that the MCP server is running and responsive.",
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = "McpServerError";
  }
}

/**
 * Wrap an unknown error into an McpUiError.
 */
export function wrapError(error: unknown, context?: McpUiErrorContext): McpUiError {
  if (error instanceof McpUiError) {
    // Merge contexts
    return new McpUiError(error.message, {
      code: error.code,
      context: { ...error.context, ...context },
      ...(error.recoveryHint !== undefined ? { recoveryHint: error.recoveryHint } : {}),
      ...(error.cause !== undefined ? { cause: error.cause } : {}),
    });
  }

  const cause = error instanceof Error ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);

  return new McpUiError(message, {
    code: "UNKNOWN_ERROR",
    ...(context !== undefined ? { context } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Check if an error is a specific MCP UI error type.
 */
export function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof McpUiError && error.code === code;
}

/**
 * Stable adapter error code for an SDK-native input_required result that the
 * current client cannot fulfil because its embedded-request handler is not
 * registered. The SDK keeps the request key/method in `SdkError.data`; this
 * adapter detail intentionally copies only bounded, actionable fields.
 */
export const INPUT_REQUIRED_NEEDS_UI = "input_required_needs_ui" as const;

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

const INPUT_REQUIRED_METHODS = new Set([
  "elicitation/create",
  "sampling/createMessage",
]);
const MAX_INPUT_REQUIRED_SERVER_LENGTH = 96;
const MAX_INPUT_REQUIRED_TARGET_LENGTH = 160;
const MAX_INPUT_REQUIRED_DETAIL_LENGTH = 128;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

interface EmbeddedInputRequest {
  inputKey: string;
  inputMethod: string;
  server?: string;
  tool?: string;
  resourceUri?: string;
}

function findEmbeddedInputRequest(error: unknown): EmbeddedInputRequest | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const record = asRecord(current);
    if (!record) return undefined;

    if (record.code === INPUT_REQUIRED_NEEDS_UI) {
      const details = asRecord(record.details);
      const inputKey = boundedText(details?.inputKey, MAX_INPUT_REQUIRED_DETAIL_LENGTH);
      const inputMethod = boundedText(details?.inputMethod, MAX_INPUT_REQUIRED_DETAIL_LENGTH);
      if (inputKey && inputMethod && INPUT_REQUIRED_METHODS.has(inputMethod)) {
        const server = boundedText(details?.server, MAX_INPUT_REQUIRED_SERVER_LENGTH);
        const tool = boundedText(details?.tool, MAX_INPUT_REQUIRED_TARGET_LENGTH);
        const resourceUri = boundedText(details?.resourceUri, MAX_INPUT_REQUIRED_TARGET_LENGTH);
        return {
          inputKey,
          inputMethod,
          ...(server ? { server } : {}),
          ...(tool ? { tool } : {}),
          ...(resourceUri ? { resourceUri } : {}),
        };
      }
    }

    if (record.code === "CAPABILITY_NOT_SUPPORTED") {
      const data = asRecord(record.data);
      const inputKey = boundedText(data?.key, MAX_INPUT_REQUIRED_DETAIL_LENGTH);
      const inputMethod = boundedText(data?.method, MAX_INPUT_REQUIRED_DETAIL_LENGTH);
      if (inputKey && inputMethod && INPUT_REQUIRED_METHODS.has(inputMethod)) {
        return { inputKey, inputMethod };
      }
    }

    current = record.cause;
  }
  return undefined;
}

/**
 * Convert a missing embedded-input handler into an adapter-owned result
 * detail. Matching requires the SDK's typed code/data shape (or this module's
 * typed wrapper), rather than arbitrary error-message text.
 */
export function getInputRequiredNeedsUiDetails(
  error: unknown,
  identity: InputRequiredIdentity,
): InputRequiredNeedsUiDetails | undefined {
  const request = findEmbeddedInputRequest(error);
  if (!request) return undefined;

  const server = boundedText(request.server ?? identity.server, MAX_INPUT_REQUIRED_SERVER_LENGTH) ?? "unknown";
  const tool = boundedText(request.tool ?? identity.tool, MAX_INPUT_REQUIRED_TARGET_LENGTH);
  const resourceUri = boundedText(request.resourceUri ?? identity.resourceUri, MAX_INPUT_REQUIRED_TARGET_LENGTH);
  const target = resourceUri
    ? `read resource "${resourceUri}"`
    : tool
      ? `call tool "${tool}"`
      : "complete the MCP request";
  const guidance = request.inputMethod === "elicitation/create"
    ? "Run this call in an interactive Pi session with elicitation enabled, then retry."
    : "Run this call in an interactive Pi session with the required MCP capability enabled, then retry.";
  const message = `MCP server "${server}" requested input to ${target}, but this session has no handler for "${request.inputMethod}" (input "${request.inputKey}"). ${guidance}`;

  return {
    error: INPUT_REQUIRED_NEEDS_UI,
    server,
    ...(tool ? { tool } : {}),
    ...(resourceUri ? { resourceUri } : {}),
    inputKey: request.inputKey,
    inputMethod: request.inputMethod,
    message,
  };
}

/** Error form used by UiResourceHandler so an outer tool call can preserve the classification. */
export class InputRequiredNeedsUiError extends McpUiError {
  constructor(readonly details: InputRequiredNeedsUiDetails, cause?: Error) {
    super(details.message, {
      code: INPUT_REQUIRED_NEEDS_UI,
      context: { ...details },
      recoveryHint: "Run this call in an interactive Pi session with the required MCP input handler enabled, then retry.",
      ...(cause ? { cause } : {}),
    });
    this.name = "InputRequiredNeedsUiError";
  }
}
