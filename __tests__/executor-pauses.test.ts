import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { RequestOptions } from "@modelcontextprotocol/client";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { callToolAnsweringExecutorPauses } from "../executor-pauses.ts";
import { runMcpScript } from "../mcp-code.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager, type ServerConnection } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { ToolMetadata } from "../types.ts";

const fixture = fileURLToPath(new URL("./fixtures/executor-server.mjs", import.meta.url));
const managers: McpServerManager[] = [];
const tempDirs: string[] = [];

function metadata(originalName: string): ToolMetadata {
  return {
    name: `executor_${originalName}`,
    originalName,
    description: `Executor ${originalName}`,
    inputSchema: { type: "object", properties: {} },
  };
}

async function connectExecutor(options: { select?: string[]; input?: string[]; serverName?: string } = {}) {
  const ui = {
    select: vi.fn(async () => options.select?.shift()),
    input: vi.fn(async () => options.input?.shift()),
    notify: vi.fn(),
  };
  const tempDir = await mkdtemp(`${tmpdir()}/pi-mcp-executor-`);
  tempDirs.push(tempDir);
  const logPath = `${tempDir}/events.jsonl`;
  const definition = {
    command: process.execPath,
    args: [fixture],
    protocolVersion: "2026-07-28" as const,
    env: { EXECUTOR_LOG_FILE: logPath, ...(options.serverName ? { EXECUTOR_SERVER_NAME: options.serverName } : {}) },
  };
  const manager = new McpServerManager();
  manager.setDefaultRequestTimeoutMs(2_000);
  manager.setElicitationConfig({ ui, allowUrl: false });
  await manager.connect("executor", definition);
  managers.push(manager);
  const state = {
    manager,
    config: { settings: { toolPrefix: "server" }, mcpServers: { executor: definition } },
    toolMetadata: new Map([["executor", ["execute", "call", "resume"].map(metadata)]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    ui,
    completedUiSessions: [],
    uiServer: null,
  } as unknown as McpExtensionState;
  const resumes = async () => (await readFile(logPath, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.name === "resume").map(event => event.arguments);
  return { state, ui, resumes };
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find(block => block.type === "text")?.text ?? "";
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.closeAll()));
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("Executor pauses", () => {
  it("answers an approval pause in Pi and returns only the final result", async () => {
    const { state, ui, resumes } = await connectExecutor({ select: ["Continue"] });

    const result = await executeCall(state, "executor_call", { path: "gmail.send_email" }, "executor");

    expect(textOf(result)).toContain("email sent");
    expect(`${textOf(result)} ${JSON.stringify(result.details)}`).not.toMatch(/apr_|requestId|approval-required/);
    expect(ui.select).toHaveBeenCalledOnce();
    expect(await resumes()).toEqual([{ requestId: "apr_1", response: { action: "accept" } }]);
  });

  it("resumes a declined approval with decline and returns Executor's outcome", async () => {
    const { state, resumes } = await connectExecutor({ select: ["Decline"] });

    const result = await executeCall(state, "executor_call", { path: "gmail.send_email" }, "executor");

    expect(textOf(result)).toContain("send_email was not approved: decline");
    expect(await resumes()).toEqual([{ requestId: "apr_1", response: { action: "decline" } }]);
  });

  it("sends the answer to an input pause back through resume", async () => {
    const { state, ui, resumes } = await connectExecutor({ select: ["Continue", "Enter value", "Submit"], input: ["work"] });

    const result = await executeCall(state, "executor_execute", { code: "pickInbox()" }, "executor");

    expect(textOf(result)).toContain("inbox work");
    expect(textOf(result)).not.toMatch(/elc_|requestId/);
    expect(ui.input).toHaveBeenCalledOnce();
    expect(await resumes()).toEqual([{ requestId: "elc_1", response: { action: "accept", content: { inbox: "work" } } }]);
  });

  it.each(["direct", "mcpScript"] as const)("answers the pause on the %s path", async (path) => {
    const { state, ui } = await connectExecutor({ select: ["Continue"] });

    const result = path === "direct"
      ? await createDirectToolExecutor(() => state, () => null, {
          serverName: "executor",
          prefixedName: "executor_call",
          originalName: "call",
          description: "Executor call",
          inputSchema: { type: "object", properties: {} },
        })("call-1", {}, undefined, undefined, undefined as never)
      : await runMcpScript(state, 'return await tools.call("executor_call", {});');

    expect(textOf(result)).toContain("email sent");
    expect(textOf(result)).not.toMatch(/apr_|requestId/);
    expect(ui.select).toHaveBeenCalledOnce();
  });

  it("passes a lookalike pending result from another server through untouched", async () => {
    const { state, ui, resumes } = await connectExecutor({ select: ["Continue"], serverName: "lookalike" });

    const result = await executeCall(state, "executor_call", {}, "executor");

    expect(textOf(result)).toContain('"requestId":"apr_1"');
    expect(ui.select).not.toHaveBeenCalled();
    expect(await resumes()).toEqual([]);
  });

  it("gives execute, call and resume a 6-minute timeout unless the server sets one", async () => {
    const timeoutFor = async (requestTimeoutMs: number | undefined, requestOptions: RequestOptions | undefined) => {
      const seen: Array<RequestOptions | undefined> = [];
      await callToolAnsweringExecutorPauses({
        conn: {
          client: { getServerVersion: () => undefined },
          definition: requestTimeoutMs === undefined ? {} : { requestTimeoutMs },
          tools: [
            { name: "execute" },
            { name: "call" },
            { name: "resume", inputSchema: { type: "object", properties: { requestId: {}, response: {} } } },
          ],
        } as unknown as Pick<ServerConnection, "client" | "definition" | "tools">,
        manager: { promptFormElicitation: async () => undefined },
        serverName: "executor",
        params: { name: "call", arguments: {} },
        requestOptions,
        call: async (_params, options) => {
          seen.push(options);
          return { content: [] };
        },
      });
      return seen[0]?.timeout;
    };

    expect(await timeoutFor(undefined, undefined)).toBe(360_000);
    expect(await timeoutFor(undefined, { timeout: 2_000 })).toBe(360_000);
    expect(await timeoutFor(undefined, { timeout: 600_000 })).toBe(600_000);
    expect(await timeoutFor(5_000, { timeout: 5_000 })).toBe(5_000);
  });
});
