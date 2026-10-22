import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SdkErrorCode, SdkHttpError, type RequestOptions } from "@modelcontextprotocol/client";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { callToolAnsweringExecutorPauses } from "../executor-pauses.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager, type ServerConnection } from "../server-manager.ts";
import { withSessionRecovery } from "../session-recovery.ts";
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

async function connectExecutor(options: {
  select?: Array<string | undefined>;
  input?: string[];
  env?: Record<string, string>;
  headless?: boolean;
} = {}) {
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
    env: { EXECUTOR_LOG_FILE: logPath, ...options.env },
  };
  const manager = new McpServerManager();
  manager.setDefaultRequestTimeoutMs(2_000);
  if (!options.headless) manager.setElicitationConfig({ ui, allowUrl: false });
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

const approvalPending = {
  content: [],
  structuredContent: {
    status: "approval-required",
    requestId: "apr_1",
    elicitation: { mode: "form", message: "Approve?", requestedSchema: { type: "object", properties: {} } },
  },
};

function fakeExecutorConnection(definition: { requestTimeoutMs?: number }): ServerConnection {
  return {
    client: { getServerVersion: () => undefined },
    transport: { sessionId: "session-1" },
    definition,
    tools: [
      { name: "execute" },
      { name: "call" },
      { name: "resume", inputSchema: { type: "object", properties: { requestId: {}, response: {} } } },
    ],
  } as never;
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
    expect(ui.select).toHaveBeenCalledWith(expect.stringContaining('Arguments:\n{\n  "to": "a@example.com"\n}'), ["Continue", "Decline"]);
    expect(await resumes()).toEqual([{ requestId: "apr_1", response: { action: "accept" } }]);
  });

  it("resumes a declined approval with decline and returns Executor's outcome", async () => {
    const { state, resumes } = await connectExecutor({ select: ["Decline"] });

    const result = await executeCall(state, "executor_call", { path: "gmail.send_email" }, "executor");

    expect(textOf(result)).toContain("send_email was not approved: decline");
    expect(await resumes()).toEqual([{ requestId: "apr_1", response: { action: "decline" } }]);
  });

  it("answers the pause once when the proxy hands the call off to its registered Pi tool", async () => {
    const { state, ui, resumes } = await connectExecutor({ select: ["Continue"] });
    // The registered tool runs a handed-off call as the proxy would, without a second hand-off.
    const handOff = vi.fn(async ({ serverName, toolMeta, args }: { serverName: string; toolMeta: ToolMetadata; args: Record<string, unknown> | undefined }) =>
      executeCall(state, toolMeta.name, args, serverName));

    const result = await executeCall(state, "executor_call", { path: "gmail.send_email" }, "executor", undefined, undefined, undefined, undefined, undefined, handOff);

    expect(handOff).toHaveBeenCalledOnce();
    expect(textOf(result)).toContain("email sent");
    expect(ui.select).toHaveBeenCalledOnce();
    expect(await resumes()).toEqual([{ requestId: "apr_1", response: { action: "accept" } }]);
  });

  it.each(["direct", "proxy"] as const)("answers the pause on the %s path", async (path) => {
    const { state, ui } = await connectExecutor({ select: ["Continue"] });

    const result = path === "direct"
      ? await createDirectToolExecutor(() => state, () => null, {
          serverName: "executor",
          prefixedName: "executor_call",
          originalName: "call",
          description: "Executor call",
          inputSchema: { type: "object", properties: {} },
        })("call-1", {}, undefined, undefined, undefined as never)
      : await executeCall(state, "executor_call", {});

    expect(textOf(result)).toContain("email sent");
    expect(textOf(result)).not.toMatch(/apr_|requestId/);
    expect(ui.select).toHaveBeenCalledOnce();
  });

  it.each([
    ["a server with another name", { EXECUTOR_SERVER_NAME: "lookalike" }],
    ["Executor's browser mode, whose resume takes no response", { EXECUTOR_RESUME_SCHEMA: "browser" }],
  ])("passes a pending result from %s through untouched", async (_label, env) => {
    const { state, ui, resumes } = await connectExecutor({ select: ["Continue"], env });

    const result = await executeCall(state, "executor_call", {}, "executor");

    expect(textOf(result)).toContain('"requestId":"apr_1"');
    expect(ui.select).not.toHaveBeenCalled();
    expect(await resumes()).toEqual([]);
  });

  it("answers an approval and then an input pause before returning the final result", async () => {
    const { state, ui, resumes } = await connectExecutor({
      select: ["Continue", "Continue", "Enter value", "Submit"],
      input: ["work"],
    });

    const result = await executeCall(state, "executor_execute", { code: "chain" }, "executor");

    expect(textOf(result)).toContain("inbox work");
    expect(textOf(result)).not.toMatch(/apr_|elc_|requestId/);
    expect(ui.input).toHaveBeenCalledOnce();
    expect(await resumes()).toEqual([
      { requestId: "apr_2", response: { action: "accept" } },
      { requestId: "elc_1", response: { action: "accept", content: { inbox: "work" } } },
    ]);
  });

  it.each(["proxy", "direct"] as const)("refuses a resume from the model on the %s path without sending it", async (path) => {
    const { state, resumes } = await connectExecutor();
    const args = { requestId: "apr_1", response: { action: "accept" } };

    const result = path === "proxy"
      ? await executeCall(state, "executor_resume", args, "executor")
      : await createDirectToolExecutor(() => state, () => null, {
          serverName: "executor",
          prefixedName: "executor_resume",
          originalName: "resume",
          description: "Executor resume",
          inputSchema: { type: "object", properties: {} },
        })("call-1", args, undefined, undefined, undefined as never);

    expect(textOf(result)).toContain("Pi answers Executor's approval and input requests itself");
    expect(result.details).toMatchObject({ error: "tool_error" });
    expect(await resumes()).toEqual([]);
  });

  it("fails a pause in a session that cannot show dialogs without leaking the requestId", async () => {
    const { state, resumes } = await connectExecutor({ headless: true });

    const result = await executeCall(state, "executor_call", {}, "executor");

    expect(textOf(result)).toContain("interactive Pi session");
    expect(`${textOf(result)} ${JSON.stringify(result.details)}`).not.toMatch(/apr_|elc_|requestId/);
    expect(await resumes()).toEqual([]);
  });

  it.each([
    ["unavailable", "Decline", "That question was already answered."],
    ["busy", undefined, "Executor is still answering an earlier request for this call; try the call again."],
  ])("shows a %s outcome as a message without its requestId", async (_status, answer, message) => {
    const { state } = await connectExecutor({ select: [answer] });

    const result = await executeCall(state, "executor_execute", { code: "pickInbox()" }, "executor");

    expect(textOf(result)).toBe(message);
    expect(JSON.stringify(result.details)).not.toMatch(/elc_|requestId/);
  });

  it.each([
    [16, "done after 16 pauses"],
    [17, "Executor paused more than 16 times in one call"],
  ])("answers up to 16 pauses in one call (%i pauses)", async (pauses, text) => {
    const { state } = await connectExecutor({ select: Array(pauses).fill("Continue") });

    const result = await executeCall(state, "executor_execute", { code: `pauses:${pauses}` }, "executor");

    expect(textOf(result)).toContain(text);
  });

  it("does not let session recovery re-run a program after its resume fails", async () => {
    const conn = fakeExecutorConnection({});
    const reconnect = vi.fn();
    const sent: string[] = [];

    const run = withSessionRecovery(
      {
        manager: { getConnection: () => conn, reconnect } as never,
        config: { mcpServers: { executor: { url: "https://example.test/mcp" } } },
      },
      "executor",
      connection => callToolAnsweringExecutorPauses({
        conn: connection,
        manager: { promptFormElicitation: async () => ({ action: "accept" }) },
        serverName: "executor",
        params: { name: "execute", arguments: {} },
        requestOptions: undefined,
        call: async params => {
          sent.push(params.name);
          if (params.name === "resume") {
            throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Session not found", { status: 404 });
          }
          return approvalPending;
        },
      }),
    );

    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining("Resuming the Executor program failed: Session not found"),
      cause: expect.any(SdkHttpError),
    });
    expect(sent).toEqual(["execute", "resume"]);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("gives execute, call and their resumes a 6-minute timeout unless the server sets one", async () => {
    const timeoutsFor = async (requestTimeoutMs: number | undefined, requestOptions: RequestOptions | undefined) => {
      const seen: Array<number | undefined> = [];
      await callToolAnsweringExecutorPauses({
        conn: fakeExecutorConnection(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        manager: { promptFormElicitation: async () => ({ action: "accept" }) },
        serverName: "executor",
        params: { name: "call", arguments: {} },
        requestOptions,
        call: async (params, options) => {
          seen.push(options?.timeout);
          return params.name === "call" ? approvalPending : { content: [] };
        },
      });
      return seen;
    };

    expect(await timeoutsFor(undefined, undefined)).toEqual([360_000, 360_000]);
    expect(await timeoutsFor(undefined, { timeout: 2_000 })).toEqual([360_000, 360_000]);
    expect(await timeoutsFor(undefined, { timeout: 600_000 })).toEqual([600_000, 600_000]);
    expect(await timeoutsFor(5_000, { timeout: 5_000 })).toEqual([5_000, 5_000]);
    for (const unset of [0, -1, Number.NaN]) {
      expect(await timeoutsFor(unset, { timeout: 2_000 })).toEqual([360_000, 360_000]);
    }
  });
});
