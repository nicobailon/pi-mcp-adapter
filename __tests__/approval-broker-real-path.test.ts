import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalRequest } from "../types.ts";
import { MCP_RUNTIME_TOOL_CALL_EVENT, type McpRuntimeToolCallRequest } from "../index.ts";

// Real host event bus, registered tools, session, and stdio MCP transport.
// The receipt log distinguishes broker denial from a call dispatched to the server.
describe("approval broker through the runtime tool-call event", () => {
  it.each(["deny", "abstain", "no claim"] as const)(
    "consults the broker before a cached grant: %s",
    async (secondDecision) => {
      const root = await mkdtemp(join(tmpdir(), "pi-mcp-approval-broker-"));
      const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
      const originalArgv = [...process.argv];
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const agentDir = join(root, "agent");
        const cwd = join(root, "project");
        await Promise.all([mkdir(agentDir), mkdir(cwd)]);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const receipts = join(root, "receipts.jsonl");
        await writeFile(receipts, "");
        const configPath = join(agentDir, "mcp-adapter.json");
        await writeFile(configPath, JSON.stringify({
          mcpServers: {
            fixture: {
              command: process.execPath,
              args: [resolve("__tests__/fixtures/approval-broker-server.mjs")],
              env: { MCP_APPROVAL_RECEIPTS: receipts },
              lifecycle: "eager",
            },
          },
          settings: { approveTools: true, sampling: false, elicitation: false },
        }));
        process.argv.push("--mcp-config", configPath);
        const requests: McpToolApprovalRequest[] = [];
        const errors: string[] = [];
        let events: { emit(channel: string, data: unknown): void } | undefined;
        const settingsManager = SettingsManager.inMemory();
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager,
          additionalExtensionPaths: [resolve("index.ts")],
          extensionFactories: [(pi) => {
            events = pi.events;
            pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (request: McpToolApprovalRequest) => {
              requests.push(request);
              const decision = requests.length === 1 ? "allow_for_session"
                : requests.length === 2 ? secondDecision : "abstain";
              if (decision !== "no claim") expect(request.claim(() => decision)).toBe(true);
            });
          }],
        });
        await loader.reload();
        ({ session } = await createAgentSession({
          cwd, agentDir, resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "all",
        }));
        await session.bindExtensions({ mode: "print", onError: error => errors.push(error.error) });
        await session.extensionRunner.emit({ type: "agent_start" });
        const call = (value: string) => {
          const request: McpRuntimeToolCallRequest = { version: 1, tool: "fixture_echo", args: { value } };
          events!.emit(MCP_RUNTIME_TOOL_CALL_EVENT, request);
          return request.result!;
        };
        const results = [];
        for (const value of ["same", "same", "same", "new"]) results.push(await call(value));
        expect(results[0]).toMatchObject({ ok: true });
        expect(results[1]).toMatchObject(secondDecision === "deny"
          ? { ok: false, error: { message: "MCP tool call failed: approval_denied" } } : { ok: true });
        // A denial is not revocation: the next abstention still uses the grant.
        expect(results[2]).toMatchObject({ ok: true });
        expect(results[3]).toMatchObject({ ok: false, error: { message: "MCP tool call failed: approval_required" } });
        expect(requests).toHaveLength(4);
        expect(new Set(requests.map(request => request.requestId)).size).toBe(4);
        requests.forEach((request, index) => expect(request).toMatchObject({
          origin: "script", serverName: "fixture", originalToolName: "echo",
          prefixedToolName: "fixture_echo", args: { value: index === 3 ? "new" : "same" },
        }));
        const received = (await readFile(receipts, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        expect(received).toHaveLength(secondDecision === "deny" ? 2 : 3);
        received.forEach(receipt => expect(receipt).toMatchObject({ name: "echo", arguments: { value: "same" } }));
        expect(errors).toEqual([]);
      } finally {
        try {
          await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
        } finally {
          session?.dispose();
          process.argv.splice(0, process.argv.length, ...originalArgv);
          if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
          await rm(root, { recursive: true, force: true });
        }
      }
    },
    20_000,
  );
});
