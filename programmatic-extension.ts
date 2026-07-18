import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpSourceIdentity } from "./programmatic-types.ts";
import { ProgrammaticMcpRuntime } from "./programmatic-runtime.ts";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function safeFailure(error: unknown, signal?: AbortSignal) {
  const code = signal?.aborted
    ? "MCP_LAUNCH_CANCELLED"
    : error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "ADAPTER_FAILED";
  return {
    content: [{ type: "text" as const, text: "MCP programmatic runtime operation failed" }],
    details: { error: code },
  };
}

function parseIdentity(value: string | undefined): McpSourceIdentity {
  if (value === undefined) throw new Error("source identity is required");
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("source identity must be an object");
  }
  return parsed as McpSourceIdentity;
}

/** Register the source-qualified proxy used by programmatic adapter instances. */
export function registerProgrammaticExtension(
  pi: ExtensionAPI,
  runtime: ProgrammaticMcpRuntime,
  toolName: "mcp" | "mcp_sources",
): void {
  let generation = 0;
  let sessionTail = Promise.resolve();

  function enqueueSession(operation: () => Promise<void>): Promise<void> {
    const queued = sessionTail.then(operation, operation);
    sessionTail = queued.catch(() => undefined);
    return queued;
  }

  pi.on("session_start", (_event, context) => {
    const current = ++generation;
    return enqueueSession(async () => {
      if (current !== generation) return;
      await runtime.attachSession(context);
      if (current !== generation) await runtime.detachSession();
    });
  });

  pi.on("session_shutdown", () => {
    const current = ++generation;
    return enqueueSession(async () => {
      if (current === generation) await runtime.detachSession();
    });
  });

  (pi.registerTool as (tool: unknown) => unknown)({
    name: toolName,
    label: toolName === "mcp" ? "MCP" : "MCP Sources",
    description: "Source-qualified MCP gateway for programmatic configuration sources",
    promptSnippet: "MCP gateway for isolated programmatic sources",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal("status"),
        Type.Literal("capabilities"),
        Type.Literal("list"),
        Type.Literal("call"),
      ])),
      source: Type.Optional(Type.String({
        description: "Exact McpSourceIdentity encoded as JSON",
      })),
      server: Type.Optional(Type.String({ description: "Source-local server key" })),
      tool: Type.Optional(Type.String({ description: "Native MCP tool name" })),
      args: Type.Optional(Type.String({ description: "Tool arguments encoded as a JSON object" })),
    }),
    async execute(
      _toolCallId: string,
      params: {
        action?: "status" | "capabilities" | "list" | "call";
        source?: string;
        server?: string;
        tool?: string;
        args?: string;
      },
      signal?: AbortSignal,
    ) {
      const operationSignal = signal ?? new AbortController().signal;
      try {
        operationSignal.throwIfAborted();
        const action = params.action ?? "status";
        if (action === "status") return textResult(await runtime.inspectSources(operationSignal));
        if (action === "capabilities") return textResult(await runtime.capabilities(operationSignal));
        const identity = parseIdentity(params.source);
        if (params.server === undefined) throw new Error("server key is required");
        if (action === "list") {
          return textResult(await runtime.listTools(identity, params.server, operationSignal));
        }
        if (params.tool === undefined) throw new Error("tool name is required");
        let args: Record<string, unknown> = {};
        if (params.args !== undefined) {
          const parsed = JSON.parse(params.args);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("tool arguments must be an object");
          }
          args = parsed as Record<string, unknown>;
        }
        return textResult(await runtime.callTool(identity, params.server, params.tool, args, operationSignal));
      } catch (error) {
        return safeFailure(error, operationSignal);
      }
    },
  });
}
