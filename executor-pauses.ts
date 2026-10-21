import type { Client, ElicitRequestFormParams, ElicitResult, RequestOptions } from "@modelcontextprotocol/client";
import { throwIfAborted } from "./abort.ts";
import type { McpServerManager, ServerConnection } from "./server-manager.ts";

const EXECUTOR_PAUSING_TOOLS = new Set(["execute", "call"]);
const EXECUTOR_RESUMING_TOOLS = new Set([...EXECUTOR_PAUSING_TOOLS, "resume"]);
// Executor's default program budget is 5 minutes (executor packages/mcp/src/contracts/execute.ts)
// and it sends no progress notifications, so the SDK's 60-second default would kill a program
// well inside that budget. One extra minute covers transport and prompt overhead.
export const EXECUTOR_REQUEST_TIMEOUT_MS = 360_000;
const MAX_EXECUTOR_PAUSES = 16;

type ToolCallParams = Parameters<Client["callTool"]>[0];

export interface ExecutorPause {
  status: "approval-required" | "input-required";
  requestId: string;
  elicitation: ElicitRequestFormParams;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The name check accepts an absent name: on a 2026-07-28 connect the SDK reads serverInfo only
 * from discover `_meta["io.modelcontextprotocol/serverInfo"]`, and Executor returns serverInfo
 * as a top-level discover field, so a real Executor may report no name at all.
 */
export function isExecutorConnection(conn: Pick<ServerConnection, "client" | "tools">): boolean {
  const name = conn.client.getServerVersion?.()?.name;
  if (name !== undefined && name !== "Executor") return false;
  let execute = false;
  let call = false;
  let resume = false;
  for (const tool of conn.tools) {
    if (tool.name === "execute") execute = true;
    else if (tool.name === "call") call = true;
    else if (tool.name === "resume") {
      const properties = tool.inputSchema?.properties;
      resume = isRecord(properties) && "requestId" in properties && "response" in properties;
    }
  }
  return execute && call && resume;
}

/** Validates Executor's pending `structuredContent`; any other result is not a pause. */
export function parseExecutorPause(result: object): ExecutorPause | undefined {
  const content = (result as { structuredContent?: unknown }).structuredContent;
  if (!isRecord(content)) return undefined;
  const { status, requestId, elicitation } = content;
  if (status !== "approval-required" && status !== "input-required") return undefined;
  const schema = isRecord(elicitation) ? elicitation.requestedSchema : undefined;
  const properties = isRecord(schema) ? schema.properties : undefined;
  if (
    typeof requestId !== "string" || requestId === ""
    || !isRecord(elicitation) || elicitation.mode !== "form" || typeof elicitation.message !== "string"
    || !isRecord(schema) || schema.type !== "object" || !isRecord(properties)
    // An approval form asks no fields: Executor rejects an accept that carries content.
    || (status === "approval-required" && Object.keys(properties).length > 0)
  ) {
    throw new Error("Executor returned a malformed pending interaction");
  }
  // elicitation._meta is Executor's own metadata; the adapter has no contract for it and drops it.
  return {
    status,
    requestId,
    elicitation: {
      mode: "form",
      message: elicitation.message,
      requestedSchema: schema as ElicitRequestFormParams["requestedSchema"],
    },
  };
}

function resumeResponse(pause: ExecutorPause, decision: ElicitResult): Record<string, unknown> {
  if (decision.action !== "accept") return { action: decision.action };
  if (pause.status === "approval-required") return { action: "accept" };
  return { action: "accept", content: decision.content ?? {} };
}

/**
 * Calls a tool and, when the server is Executor, answers each approval or input pause with
 * Pi's dialogs and Executor's `resume` until the program finishes, so the caller only sees
 * the final result. Every other server gets exactly `call(params, requestOptions)`.
 *
 * The loop runs inside the caller's session-recovery closure: if the session dies while a
 * dialog is open, recovery reissues the original `execute`/`call`, as for any other tool.
 */
export async function callToolAnsweringExecutorPauses<T extends object>(args: {
  conn: Pick<ServerConnection, "client" | "definition" | "tools">;
  manager: Pick<McpServerManager, "promptFormElicitation">;
  serverName: string;
  params: ToolCallParams;
  requestOptions: RequestOptions | undefined;
  signal?: AbortSignal | undefined;
  call: (params: ToolCallParams, options: RequestOptions | undefined) => Promise<T>;
}): Promise<T> {
  const { conn, params, call } = args;
  if (!EXECUTOR_RESUMING_TOOLS.has(params.name) || !isExecutorConnection(conn)) {
    return call(params, args.requestOptions);
  }
  const options = conn.definition.requestTimeoutMs === undefined
    && (args.requestOptions?.timeout ?? 0) < EXECUTOR_REQUEST_TIMEOUT_MS
    ? { ...args.requestOptions, timeout: EXECUTOR_REQUEST_TIMEOUT_MS }
    : args.requestOptions;
  let result = await call(params, options);
  if (!EXECUTOR_PAUSING_TOOLS.has(params.name)) return result;
  for (let pauses = 0; pauses < MAX_EXECUTOR_PAUSES; pauses++) {
    const pause = parseExecutorPause(result);
    if (!pause) return result;
    const decision = await args.manager.promptFormElicitation(args.serverName, pause.elicitation, args.signal);
    if (!decision) return result;
    throwIfAborted(args.signal);
    result = await call({
      name: "resume",
      arguments: { requestId: pause.requestId, response: resumeResponse(pause, decision) },
      ...(params._meta ? { _meta: params._meta } : {}),
    }, options);
  }
  throw new Error(`Executor paused more than ${MAX_EXECUTOR_PAUSES} times in one call`);
}
