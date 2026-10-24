import { TaskExecutionClosedError } from "@modelcontextprotocol/ext-tasks/client";
import type { BackgroundToolExecution } from "./mcp-tasks.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { SendMessageFn } from "./state.ts";
import type { ContentBlock } from "./types.ts";
import { logger } from "./logger.ts";

export interface RenderedTaskResult {
  content: ContentBlock[];
  details: Record<string, unknown>;
}

export interface BackgroundTaskStart {
  server: string;
  tool: string;
  taskId: string;
  execution: BackgroundToolExecution;
  /** Renders a completed tool result the way the call site renders an inline one. */
  render: (result: Record<string, unknown>) => Promise<RenderedTaskResult>;
}

/**
 * Tool calls whose server answered with a task. Each runs to settlement here,
 * holding its server's in-flight count, and its outcome reaches the model as
 * one follow-up message. Stopping the runtime or closing the connection
 * cancels the remote task.
 */
export class BackgroundTaskRegistry {
  constructor(
    private readonly manager: Pick<McpServerManager, "decrementInFlight" | "touch">,
    private readonly sendMessage: SendMessageFn,
    private readonly ownerSignal: AbortSignal,
  ) {}

  /**
   * Takes over the call's in-flight count. Resolves once the outcome is
   * delivered and the count released.
   */
  start(task: BackgroundTaskStart): Promise<void> {
    // The same cancel a blocking call sends when the runtime stops, ahead of the connection teardown.
    const cancel = () => void task.execution.cancel().catch(() => {});
    if (this.ownerSignal.aborted) cancel();
    else this.ownerSignal.addEventListener("abort", cancel, { once: true });
    return task.execution.settle()
      .then(async ({ outcome }) => {
        const label = `MCP task ${task.taskId} (${task.server}/${task.tool})`;
        const identity = { id: task.taskId, server: task.server, tool: task.tool };
        let message: { content: ContentBlock[]; details: Record<string, unknown> };
        if (outcome.status === "completed") {
          const { resultType: _resultType, ...result } = outcome.result as Record<string, unknown>;
          const rendered = await task.render(result);
          message = {
            content: [{ type: "text", text: `${label} completed.` }, ...rendered.content],
            details: { task: { ...identity, status: "completed" }, ...rendered.details },
          };
        } else if (outcome.status === "failed" && !(outcome.error.cause instanceof TaskExecutionClosedError)) {
          message = {
            content: [{ type: "text", text: `${label} failed.` }, { type: "text", text: outcome.error.message }],
            details: { task: { ...identity, status: "failed" }, error: "task_failed" },
          };
        } else {
          const reason = outcome.status === "failed"
            ? `The connection to ${task.server} closed.`
            : outcome.task?.statusMessage ?? "Task was cancelled by the server";
          message = {
            content: [{ type: "text", text: `${label} cancelled.` }, { type: "text", text: reason }],
            details: { task: { ...identity, status: "cancelled" }, error: "task_cancelled" },
          };
        }
        this.sendMessage(
          { customType: "mcp-task-result", display: true, ...message },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      })
      .catch((error: unknown) => {
        logger.warn(`MCP task ${task.server}/${task.taskId} could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.ownerSignal.removeEventListener("abort", cancel);
        this.manager.decrementInFlight(task.server);
        this.manager.touch(task.server);
      });
  }
}
