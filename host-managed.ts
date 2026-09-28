// host-managed.ts - MCP tools for an embedding application that owns the
// transport, credentials, approval, dispatch record, and instance lifetime.
//
// Unlike the ordinary extension, this profile reads no config files, never
// touches OAuth or the keyring, registers no commands, UI, or proxy tools, and
// never reconnects, recovers a session, or resends a tools/call request.
import { randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  type CallToolResult,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { createJsonSchemaValidator } from "./json-schema-validator.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { requestBrokerApproval } from "./tool-approval.ts";
import { toToolParameters } from "./tool-parameters.ts";
import { cleanupMaterializedBinaryResources, resolveMcpResultContent } from "./tool-registrar.ts";
import { formatToolName } from "./types.ts";
import { normalizeDirectToolInputSchema, normalizeToolArguments, truncateAtWord, withToolCallIdMeta } from "./utils.ts";

const CLOSE_DRAIN_TIMEOUT_MS = 5_000;

export interface HostManagedMcpServer {
  /**
   * Called once by ready(). Return an unconnected transport. It must not carry
   * an auth provider or any behavior that replays a request; the adapter sends
   * each tools/call at most once on its own layer only.
   */
  createTransport(context: { server: string; signal: AbortSignal }): Transport | Promise<Transport>;
  /** MCP tool names to expose. Omit to expose every tool the server lists. */
  tools?: readonly string[];
}

export interface HostManagedMcpToolCall {
  readonly server: string;
  /** MCP tool name. */
  readonly tool: string;
  /** Pi tool name the model called. */
  readonly toolName: string;
  readonly toolCallId: string;
  /** Opaque identity of the connection this call is bound to. */
  readonly connectionId: string;
  /** Deep-frozen arguments; exactly what dispatch() sends. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Deep-frozen input schema that was registered with Pi. */
  readonly inputSchema: Tool["inputSchema"];
  /** Aborted by the Pi call or by close(). */
  readonly signal: AbortSignal;
  /**
   * Send the tools/call request once and return the validated raw result.
   * Rejects with HostManagedMcpError. Calling it twice throws.
   */
  dispatch(): Promise<CallToolResult>;
}

export interface HostManagedMcpAdapterOptions {
  servers: Record<string, HostManagedMcpServer>;
  /**
   * Runs after approval for every tool call. Record the call, invoke
   * `call.dispatch()` at most once, and return the result to present to the
   * model through the normal output guard.
   */
  onToolCall(call: HostManagedMcpToolCall): Promise<CallToolResult>;
  /** Per-request timeout in milliseconds. The MCP SDK default applies when omitted. */
  requestTimeoutMs?: number;
}

export interface HostManagedMcpAdapter {
  /** Connect every server and freeze the tool catalog. Memoized; rejects and closes the adapter on any failure. */
  ready(): Promise<void>;
  /** Stop new calls, abort and drain in-flight calls, then close every connection. Idempotent. */
  close(): Promise<void>;
  /** Pi extension factory. Throws before ready() resolves or after close(). */
  extensionFactory(pi: ExtensionAPI): void;
}

/**
 * - `not_sent`: the request never left the adapter; the tool did not run.
 * - `may_have_run`: the request was sent and its outcome is unknown.
 * - `server_error`: the server answered with a JSON-RPC error.
 * - `invalid_result`: the server answered, but the result failed validation.
 */
export type HostManagedMcpDelivery = "not_sent" | "may_have_run" | "server_error" | "invalid_result";

const DELIVERY_MESSAGES: Record<HostManagedMcpDelivery, string> = {
  not_sent: "the request was not sent",
  may_have_run: "the request failed after it was sent; the tool may have run",
  server_error: "the server returned an error response",
  invalid_result: "the server returned an invalid result; the tool may have run",
};

/** Fixed-message dispatch failure. The raw error is kept only as `cause`. */
export class HostManagedMcpError extends Error {
  readonly delivery: HostManagedMcpDelivery;
  readonly server: string;
  readonly protocolCode?: number;

  constructor(delivery: HostManagedMcpDelivery, server: string, options: { cause?: unknown; protocolCode?: number } = {}) {
    super(`MCP server "${server}": ${DELIVERY_MESSAGES[delivery]}`, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "HostManagedMcpError";
    this.delivery = delivery;
    this.server = server;
    if (options.protocolCode !== undefined) this.protocolCode = options.protocolCode;
  }
}

interface Connection {
  readonly id: string;
  readonly client: Client;
  readonly transport: Transport;
  open: boolean;
}

interface CatalogTool {
  readonly server: string;
  readonly toolName: string;
  readonly definition: Tool;
  /** Definition passed to the SDK: output validation happens here, not in the SDK. */
  readonly sdkDefinition: Tool;
  readonly validateOutput: JsonSchemaValidator<unknown> | undefined;
}

type ToolResult = AgentToolResult<Record<string, unknown>>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function classifyDispatchError(server: string, cause: unknown): HostManagedMcpError {
  if (cause instanceof HostManagedMcpError) return cause;
  // Output-schema validation runs in this module, so a ProtocolError here is a
  // JSON-RPC error response from the server.
  if (cause instanceof ProtocolError) return new HostManagedMcpError("server_error", server, { cause, protocolCode: cause.code });
  if (cause instanceof SdkError && cause.code === SdkErrorCode.InvalidResult) {
    return new HostManagedMcpError("invalid_result", server, { cause });
  }
  if (cause instanceof SdkError && cause.code === SdkErrorCode.NotConnected) {
    return new HostManagedMcpError("not_sent", server, { cause });
  }
  return new HostManagedMcpError("may_have_run", server, { cause });
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function dispatchFailureResult(tool: CatalogTool, error: HostManagedMcpError): ToolResult {
  const name = tool.definition.name;
  const details: Record<string, unknown> = { error: error.delivery, server: tool.server, tool: name };
  const unknownOutcome = "Do not retry automatically; check its effects first.";
  switch (error.delivery) {
    case "not_sent":
      return textResult(`MCP tool "${name}" on server "${tool.server}" was not run: the request was not sent because the call was cancelled or the MCP connection is closed.`, details);
    case "may_have_run":
      return textResult(`MCP tool "${name}" on server "${tool.server}" failed after the request was sent, so it may have run. ${unknownOutcome}`, details);
    case "server_error": {
      const code = error.protocolCode !== undefined ? ` (JSON-RPC code ${error.protocolCode})` : "";
      if (error.protocolCode !== undefined) details.protocolCode = error.protocolCode;
      return textResult(`MCP server "${tool.server}" returned an error for tool "${name}"${code}.`, details);
    }
    case "invalid_result":
      return textResult(`MCP tool "${name}" on server "${tool.server}" returned an invalid result, so it may have run. ${unknownOutcome}`, details);
  }
}

export function createHostManagedMcpAdapter(options: HostManagedMcpAdapterOptions): HostManagedMcpAdapter {
  const servers = Object.entries(options.servers);
  const onToolCall = options.onToolCall;
  const timeout = options.requestTimeoutMs !== undefined && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : undefined;
  const lifetime = new AbortController();
  const connections = new Map<string, Connection>();
  const inFlight = new Set<Promise<ToolResult>>();
  let catalog: readonly CatalogTool[] | undefined;
  let readyPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const requestOptions = (signal: AbortSignal) => (timeout !== undefined ? { signal, timeout } : { signal });

  async function connectServer(
    server: string,
    definition: HostManagedMcpServer,
    validators: ReturnType<typeof createJsonSchemaValidator>,
  ): Promise<CatalogTool[]> {
    let listed: Tool[];
    try {
      const transport = await definition.createTransport({ server, signal: lifetime.signal });
      const client = new Client(
        { name: `pi-mcp-${server}`, version: "1.0.0" },
        // No client capabilities, and no multi-round-trip auto-fulfilment: that
        // driver would resend the original tools/call with collected input.
        { capabilities: {}, jsonSchemaValidator: validators, inputRequired: { autoFulfill: false } },
      );
      // Raw transport errors can carry credentials; the adapter never logs them.
      client.onerror = () => {};
      const connection: Connection = { id: randomUUID(), client, transport, open: true };
      client.onclose = () => { connection.open = false; };
      connections.set(server, connection);
      if (closed) {
        // close() already swept the connections it could see.
        await transport.close().catch(() => {});
        throw new HostManagedMcpError("not_sent", server);
      }
      await client.connect(transport, requestOptions(lifetime.signal));
      listed = (await client.listTools(undefined, requestOptions(lifetime.signal))).tools;
    } catch (cause) {
      throw new Error(`Host-managed MCP server "${server}" failed to start`, { cause });
    }

    const byName = new Map(listed.map((tool) => [tool.name, tool]));
    const selected = definition.tools ? [...new Set(definition.tools)] : [...byName.keys()];
    return selected.map((name) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Host-managed MCP server "${server}" does not list tool "${name}"`);
      const frozen = deepFreeze(structuredClone(tool));
      const { outputSchema, ...withoutOutputSchema } = frozen;
      let validateOutput: JsonSchemaValidator<unknown> | undefined;
      if (outputSchema) {
        try {
          validateOutput = validators.getValidator(structuredClone(outputSchema) as JsonSchemaType);
        } catch (cause) {
          throw new Error(`Host-managed MCP tool "${name}" on server "${server}" has an invalid outputSchema`, { cause });
        }
      }
      return {
        server,
        toolName: formatToolName(name, server, "server"),
        definition: frozen,
        // The SDK reports its own output-schema failures as ProtocolError,
        // indistinguishable from a server error response; validate here instead.
        sdkDefinition: Object.freeze(withoutOutputSchema),
        validateOutput,
      };
    });
  }

  async function start(): Promise<void> {
    try {
      const validators = createJsonSchemaValidator();
      const perServer = await Promise.all(servers.map(([server, definition]) => connectServer(server, definition, validators)));
      const tools = perServer.flat();
      const owners = new Map<string, CatalogTool>();
      for (const tool of tools) {
        const owner = owners.get(tool.toolName);
        if (owner) {
          throw new Error(`Host-managed MCP tools "${owner.server}/${owner.definition.name}" and "${tool.server}/${tool.definition.name}" both map to Pi tool "${tool.toolName}"`);
        }
        owners.set(tool.toolName, tool);
      }
      if (closed) throw new Error("Host-managed MCP adapter closed before it was ready");
      catalog = Object.freeze(tools);
    } catch (error) {
      await close();
      throw error;
    }
  }

  async function executeTool(
    pi: ExtensionAPI,
    tool: CatalogTool,
    toolCallId: string,
    params: unknown,
    piSignal: AbortSignal | undefined,
  ): Promise<ToolResult> {
    const name = tool.definition.name;
    const connection = connections.get(tool.server);
    if (closed || !connection?.open) return dispatchFailureResult(tool, new HostManagedMcpError("not_sent", tool.server));

    let args: Readonly<Record<string, unknown>>;
    try {
      args = deepFreeze(normalizeToolArguments(params));
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), { error: "invalid_arguments", server: tool.server, tool: name });
    }

    const signal = combineAbortSignals(lifetime.signal, piSignal) ?? lifetime.signal;
    let decision: string;
    try {
      decision = await requestBrokerApproval(pi.events, tool.server, { name: tool.toolName, originalName: name }, args, "direct", signal);
    } catch {
      return dispatchFailureResult(tool, new HostManagedMcpError("not_sent", tool.server));
    }
    if (decision === "deny") {
      return textResult(`The user declined approval to run MCP tool "${name}" on server "${tool.server}".`, { error: "approval_denied", server: tool.server, tool: name });
    }
    if (decision !== "allow_once" && decision !== "allow_for_session") {
      return textResult(`MCP tool "${name}" on server "${tool.server}" was not run: no approval handler allowed it.`, { error: "approval_required", server: tool.server, tool: name });
    }
    if (closed || !connection.open || signal.aborted) return dispatchFailureResult(tool, new HostManagedMcpError("not_sent", tool.server));

    let dispatched = false;
    let sent = false;
    const send = async (): Promise<CallToolResult> => {
      if (closed || !connection.open || signal.aborted) throw new HostManagedMcpError("not_sent", tool.server);
      sent = true;
      let result: CallToolResult;
      try {
        const meta = withToolCallIdMeta(undefined, toolCallId);
        result = await connection.client.callTool(
          { name, arguments: args as Record<string, unknown>, ...(meta ? { _meta: meta } : {}) },
          { ...requestOptions(signal), toolDefinition: tool.sdkDefinition },
        );
      } catch (cause) {
        throw classifyDispatchError(tool.server, cause);
      }
      if (tool.validateOutput && !result.isError) {
        let valid = false;
        try {
          valid = result.structuredContent !== undefined && tool.validateOutput(result.structuredContent).valid;
        } catch {
          valid = false;
        }
        if (!valid) throw new HostManagedMcpError("invalid_result", tool.server);
      }
      return result;
    };
    const call: HostManagedMcpToolCall = Object.freeze({
      server: tool.server,
      tool: name,
      toolName: tool.toolName,
      toolCallId,
      connectionId: connection.id,
      arguments: args,
      inputSchema: tool.definition.inputSchema,
      signal,
      dispatch() {
        if (dispatched) throw new Error(`dispatch() was already called for MCP tool call "${toolCallId}"`);
        dispatched = true;
        return send();
      },
    });

    let result: CallToolResult;
    try {
      result = await onToolCall(call);
    } catch (error) {
      if (error instanceof HostManagedMcpError) return dispatchFailureResult(tool, error);
      const details = { error: "host_error", server: tool.server, tool: name, sent };
      return sent
        ? textResult(`The host failed while handling MCP tool "${name}" on server "${tool.server}" after the request was sent, so it may have run. Do not retry automatically; check its effects first.`, details)
        : textResult(`The host rejected MCP tool "${name}" on server "${tool.server}"; it was not run.`, details);
    }

    const content = resolveMcpResultContent(result as unknown as Record<string, unknown>, lifetime.signal);
    const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
    const guardOptions = resolveMcpOutputGuardOptions(undefined);
    if (result.isError) {
      const guarded = await guardMcpOutput(outputContent, { ...guardOptions, prefix: "Error: ", emptyTextFallback: "Tool execution failed" });
      return { content: guarded.content, details: { error: "tool_error", server: tool.server, ...guardedMcpDetails(guarded) } };
    }
    const guarded = await guardMcpOutput(outputContent, guardOptions);
    return { content: guarded.content, details: { server: tool.server, tool: name, ...guardedMcpDetails(guarded) } };
  }

  function track(execution: Promise<ToolResult>): Promise<ToolResult> {
    inFlight.add(execution);
    void execution.finally(() => inFlight.delete(execution)).catch(() => {});
    return execution;
  }

  async function shutdown(): Promise<void> {
    closed = true;
    lifetime.abort();
    if (inFlight.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, CLOSE_DRAIN_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
    }
    await Promise.allSettled([...connections.values()].map(async (connection) => {
      connection.open = false;
      await connection.transport.close();
    }));
    cleanupMaterializedBinaryResources(lifetime.signal);
  }

  function close(): Promise<void> {
    closePromise ??= shutdown();
    return closePromise;
  }

  return {
    ready() {
      readyPromise ??= closed ? Promise.reject(new Error("Host-managed MCP adapter is closed")) : start();
      return readyPromise;
    },
    close,
    extensionFactory(pi: ExtensionAPI) {
      if (closed) throw new Error("Host-managed MCP adapter is closed");
      if (!catalog) throw new Error("Host-managed MCP adapter is not ready; await ready() before loading extensionFactory");
      for (const tool of catalog) {
        const description = tool.definition.description ?? "";
        (pi.registerTool as (tool: unknown) => unknown)({
          name: tool.toolName,
          label: `MCP: ${tool.definition.name}`,
          description: description || "(no description)",
          promptSnippet: truncateAtWord(description, 100) || `MCP tool from ${tool.server}`,
          parameters: toToolParameters(normalizeDirectToolInputSchema(structuredClone(tool.definition.inputSchema))),
          execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined) =>
            track(executeTool(pi, tool, toolCallId, params, signal)),
        });
      }
    },
  };
}
