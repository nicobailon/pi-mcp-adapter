import type { Client, ElicitRequestFormParams, RequestOptions } from "@modelcontextprotocol/client";
import { throwIfAborted } from "./abort.ts";
import { connectAccount, findAccountGap } from "./executor-accounts.ts";
import type { McpServerManager, ServerConnection } from "./server-manager.ts";

const EXECUTOR_TOOLS = new Set(["execute", "call", "resume"]);
// Executor programs run for up to 5 minutes and send no progress notifications, so the SDK's
// 60-second default would cut them off. The extra minute covers transport and prompt time.
const EXECUTOR_REQUEST_TIMEOUT_MS = 360_000;
const MAX_EXECUTOR_PAUSES = 16;

type ToolCallParams = Parameters<Client["callTool"]>[0];
type TextResult = { content: Array<{ type: "text"; text: string }>; isError: boolean };

interface ExecutorPause {
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
  const name = conn.client?.getServerVersion?.()?.name;
  if (name !== undefined && name !== "Executor") return false;
  return hasExecutorModelTools(conn.tools);
}

/**
 * Executor's model-mode tools: `execute`, `call` and a `resume` that takes the answer. The `resume`
 * schema check keeps out Executor's browser mode, whose `resume` takes only a requestId because
 * the operator answers in the browser.
 */
export function hasExecutorModelTools(tools: ReadonlyArray<{ name: string; inputSchema?: unknown }>): boolean {
  const schema = tools.find(tool => tool.name === "resume")?.inputSchema;
  const resume = isRecord(schema) ? schema.properties : undefined;
  return tools.some(tool => tool.name === "execute")
    && tools.some(tool => tool.name === "call")
    && isRecord(resume) && "requestId" in resume && "response" in resume;
}

function parseExecutorPause(result: object): ExecutorPause | undefined {
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
    // An approval form asks no fields: Executor rejects an approval that carries field values.
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

function textResult(text: string, isError: boolean): TextResult {
  return { content: [{ type: "text", text }], isError };
}

/** Any outcome still holding a requestId (`unavailable`, `busy`) is replaced: the model gets only what to do next. */
function redactExecutorOutcome<T extends object>(result: T): T | TextResult {
  const content = (result as { structuredContent?: unknown }).structuredContent;
  if (!isRecord(content) || typeof content.requestId !== "string") return result;
  return textResult(
    typeof content.message === "string"
      ? content.message
      : "Executor is still answering an earlier request for this call; try the call again.",
    (result as { isError?: boolean }).isError === true,
  );
}

/**
 * Calls a tool and, when the server is Executor, answers each approval or input pause with
 * Pi's dialogs and Executor's `resume` until the program finishes, so the caller only sees
 * the final result. Every other server gets exactly `call(params, requestOptions)`.
 *
 * The loop runs inside the caller's session-recovery closure: if the session dies while a
 * dialog is open, recovery reissues the original `execute`/`call`, as for any other tool.
 *
 * A `resume` the caller asks for is refused without contacting the server, so only Pi answers
 * Executor's pauses. The loop's own `resume` goes straight to `call` and is not refused.
 *
 * When a single `call` fails because the user has no account linked to the app, Pi connects it
 * through Executor's own link and retries the call once. Otherwise the result stands unchanged.
 */
export async function callToolAnsweringExecutorPauses<T extends object>({
  conn, manager, serverName, params, toolName, requestOptions, signal, call,
}: {
  conn: Pick<ServerConnection, "client" | "definition" | "tools">;
  manager: Pick<McpServerManager, "promptFormElicitation" | "urlElicitationPrompt">;
  serverName: string;
  params: ToolCallParams;
  /** The tool the user knows, when `params` names another: an Executor app tool's path, sent through `call`. */
  toolName?: string;
  requestOptions: RequestOptions | undefined;
  signal?: AbortSignal | undefined;
  call: (params: ToolCallParams, options: RequestOptions | undefined) => Promise<T>;
}): Promise<T | TextResult> {
  if (!EXECUTOR_TOOLS.has(params.name) || !isExecutorConnection(conn)) return call(params, requestOptions);
  if (params.name === "resume") {
    return textResult(
      "Pi answers Executor's approval and input requests itself and then resumes the program. "
        + "Call `execute` or `call` again instead; do not call `resume`.",
      true,
    );
  }
  const serverTimeout = conn.definition.requestTimeoutMs ?? 0;
  const options = Number.isFinite(serverTimeout) && serverTimeout > 0
    ? requestOptions
    : { ...requestOptions, timeout: Math.max(requestOptions?.timeout ?? 0, EXECUTOR_REQUEST_TIMEOUT_MS) };
  const answer = () => answerPauses({ manager, serverName, params, toolName: toolName ?? params.name, options, signal, call });
  const result = await answer();
  const gap = findAccountGap(params, result);
  if (!gap?.retrySafe) return result;
  const connected = await connectAccount({ gap, serverName, manager, signal, call: program => call(program, options) });
  if (connected === "pending") {
    return textResult(
      `The ${gap.slug} account has not finished connecting in Executor. Finish connecting it, then try the call again.`,
      true,
    );
  }
  // The retried result is returned as it is: a second missing account is not connected again.
  return connected === "connected" ? answer() : result;
}

async function answerPauses<T extends object>({ manager, serverName, params, toolName, options, signal, call }: {
  manager: Pick<McpServerManager, "promptFormElicitation">;
  serverName: string;
  params: ToolCallParams;
  toolName: string;
  options: RequestOptions | undefined;
  signal?: AbortSignal | undefined;
  call: (params: ToolCallParams, options: RequestOptions | undefined) => Promise<T>;
}): Promise<T | TextResult> {
  let result = await call(params, options);
  for (let pauses = 0; ; pauses++) {
    const pause = parseExecutorPause(result);
    if (!pause) return redactExecutorOutcome(result);
    if (pauses === MAX_EXECUTOR_PAUSES) throw new Error(`Executor paused more than ${MAX_EXECUTOR_PAUSES} times in one call`);
    const decision = await manager.promptFormElicitation(serverName, pause.elicitation, signal);
    if (!decision) {
      return textResult(
        `MCP tool "${toolName}" on server "${serverName}" paused for your `
          + `${pause.status === "approval-required" ? "approval" : "input"}, which Pi can only ask for `
          + "in an interactive Pi session with MCP input enabled. Run it there and try again.",
        true,
      );
    }
    throwIfAborted(signal);
    // Send an approval as a bare accept, the shape Executor's own clients use, not Pi's `content: {}`.
    const response = pause.status === "approval-required" && decision.action === "accept" ? { action: "accept" } : decision;
    try {
      result = await call({
        name: "resume",
        arguments: { requestId: pause.requestId, response },
        ...(params._meta ? { _meta: params._meta } : {}),
      }, options);
    } catch (error) {
      if (signal?.aborted) throw error;
      // A plain Error keeps session recovery from replaying the original execute/call, which would re-run the program.
      throw new Error(
        `Resuming the Executor program failed: ${error instanceof Error ? error.message : String(error)}. `
          + "Some of its steps may already have run; check their effects before running it again.",
        { cause: error },
      );
    }
  }
}
