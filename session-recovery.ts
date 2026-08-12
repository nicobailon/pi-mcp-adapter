// session-recovery.ts
//
// Streamable HTTP session recovery.
//
// Per the MCP spec (Streamable HTTP transport):
//   "When a client receives HTTP 404 in response to a request containing an
//   Mcp-Session-Id, it MUST start a new session by sending a new
//   InitializeRequest without a session ID attached."
//
// A 404 for a request that carried a session ID is therefore the spec's own
// definition of "this session no longer exists" (e.g. the remote server
// process restarted and lost its in-memory session table). Because the spec
// requires the server to reject the request *before* processing it, retrying
// the same call against a freshly initialized session cannot double-execute
// the original request.
//
// This module intentionally does NOT:
//   - match broad error messages without a prior session id
//   - match generic HTTP 400 responses, which are ambiguous and can mean
//     many things other than "your session is gone"
//   - treat generic -32000/ConnectionClosed errors as session expiry
//   - treat AbortError/cancellation as a session failure
import { ProtocolError, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { logger } from "./logger.ts";
import { throwIfAborted } from "./abort.ts";
import { isServerDisabled, type McpConfig } from "./types.ts";
import { supportsOAuth } from "./mcp-auth-flow.ts";
import { invalidateAuthEntryCache } from "./mcp-auth.ts";
import type { McpServerManager, ServerConnection } from "./server-manager.ts";

/**
 * True when `err` is a stale Streamable HTTP session signal for a request
 * sent while carrying an `Mcp-Session-Id`: the spec's 404 transport
 * response, or the narrowly-known `-32000 Server not initialized` protocol
 * gate response some servers emit before dispatching to a handler.
 *
 * `hadSessionId` must reflect the transport's session id from *before* the
 * call that produced `err` was made. Callers must capture it before the call
 * rather than rely on catch-time transport state.
 */
const CONNECTION_CLOSED_PROTOCOL_CODE = -32000;
const SERVER_NOT_INITIALIZED_MCP_MESSAGES = new Set([
  "Server not initialized",
  "Bad Request: Server not initialized",
]);

export function isTerminatedSession(err: unknown, hadSessionId: boolean): boolean {
  if (!hadSessionId) return false;
  if (err instanceof SdkHttpError) {
    return err.status === 404
      || (err.status === 400
        && /"code"\s*:\s*-32000/.test(err.message)
        && /"message"\s*:\s*"Bad Request: Server not initialized"/.test(err.message));
  }
  return err instanceof ProtocolError
    && err.code === CONNECTION_CLOSED_PROTOCOL_CODE
    && SERVER_NOT_INITIALIZED_MCP_MESSAGES.has(err.message);
}

function hasSessionId(connection: ServerConnection): boolean {
  // Only StreamableHTTPClientTransport exposes `sessionId`; stdio/SSE
  // transports (and test doubles that omit `transport` entirely) simply
  // read as `undefined` here.
  const transport = connection.transport as { sessionId?: string } | undefined;
  return transport?.sessionId != null;
}

export class SessionRecoveryAuthRequiredError extends Error {
  constructor(readonly serverName: string, readonly authMessage?: string) {
    super(authMessage ?? `MCP server "${serverName}" requires OAuth authentication after reconnect.`);
    this.name = "SessionRecoveryAuthRequiredError";
  }
}

export interface SessionRecoveryDeps {
  manager: McpServerManager;
  config: McpConfig;
  signal?: AbortSignal;
  onNeedsAuth?: (serverName: string) => Promise<ServerConnection | undefined>;
}

/**
 * Runs `fn` against the current connection for `serverName`. If it fails
 * with a terminated Streamable HTTP session (see `isTerminatedSession`),
 * reconnects exactly once via `McpServerManager.reconnect` (single-flight,
 * identity-guarded — see server-manager.ts) and retries `fn` exactly once
 * against the fresh connection.
 *
 * Any other failure — including a second failure after reconnecting, or the
 * server having been removed from config in the meantime — propagates
 * unchanged through the caller's existing error handling.
 */
export async function withSessionRecovery<T>(
  deps: SessionRecoveryDeps,
  serverName: string,
  fn: (conn: ServerConnection) => Promise<T>,
): Promise<T> {
  if (isServerDisabled(deps.config.mcpServers[serverName])) {
    throw new Error(`MCP server "${serverName}" is disabled`);
  }
  const connection = deps.manager.getConnection(serverName);
  if (!connection) {
    throw new Error(`Server "${serverName}" is not connected`);
  }

  const hadSessionId = hasSessionId(connection);

  try {
    return await fn(connection);
  } catch (err) {
    const definition = deps.config.mcpServers[serverName];
    if (definition && supportsOAuth(definition)
      && (err instanceof UnauthorizedError || (err instanceof SdkHttpError && err.status === 401))) {
      invalidateAuthEntryCache(serverName);
    }
    if (!isTerminatedSession(err, hadSessionId)) {
      throw err;
    }

    // Re-read the live definition rather than reusing the stale
    // connection's definition, in case config changed since connect. If the
    // server was removed from config in the meantime there is nothing to
    // reconnect to, so surface the original error.
    if (!definition) {
      throw err;
    }

    throwIfAborted(deps.signal);
    logger.debug(`MCP session for "${serverName}" expired; reconnecting`, {
      server: serverName,
    });
    let freshConnection = deps.signal
      ? await deps.manager.reconnect(serverName, definition, connection, deps.signal)
      : await deps.manager.reconnect(serverName, definition, connection);
    throwIfAborted(deps.signal);

    if (freshConnection.status === "needs-auth") {
      freshConnection = await deps.onNeedsAuth?.(serverName) ?? freshConnection;
      throwIfAborted(deps.signal);
    }

    if (freshConnection.status === "needs-auth") {
      throw new SessionRecoveryAuthRequiredError(serverName);
    }
    if (freshConnection.status !== "connected") {
      throw err;
    }

    return fn(freshConnection);
  }
}
