import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import { startUiServer, type UiServerHandle } from "../ui-server.ts";
import type { ConsentManager } from "../consent-manager.ts";

vi.mock("open", () => ({ default: vi.fn(async () => undefined) }));

const fixture = fileURLToPath(new URL("./fixtures/tools-only-server.mjs", import.meta.url));
const IDLE_MS = 10 * 60 * 1000;

let manager: McpServerManager;
let uiHandle: UiServerHandle | undefined;

// The lifecycle closes a server exactly when manager.isIdle(name, timeout) is true.
const idle = () => manager.isIdle("demo", IDLE_MS);
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

function gatedState() {
  let answer!: (choice: string) => void;
  let opened!: () => void;
  const dialogOpened = new Promise<void>(resolve => { opened = resolve; });
  const select = vi.fn(() => {
    opened();
    return new Promise<string>(resolve => { answer = resolve; });
  });
  const state = {
    config: { mcpServers: { demo: { command: process.execPath, args: [fixture], approveTools: true } } },
    toolMetadata: new Map(),
    resourceCounts: new Map(),
    promptMetadata: new Map(),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    approvedToolCalls: new Map(),
    manager,
    failureTracker: new Map(),
    failureMessages: new Map(),
    ui: { select, setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as McpExtensionState;
  return { state, dialogOpened, answer: (choice: string) => answer(choice) };
}

function post(port: number, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "localhost", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function startUi(state?: McpExtensionState) {
  return startUiServer({
    serverName: "demo",
    toolName: "noop",
    toolArgs: {},
    resource: { uri: "ui://demo/app", html: "<h1>App</h1>", mimeType: "text/html", meta: { permissions: [] } },
    manager,
    consentManager: { ensureApproved: vi.fn(), registerDecision: vi.fn() } as unknown as ConsentManager,
    ...(state ? { state } : {}),
  });
}

describe("idle shutdown never closes a server that is in use", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    manager = new McpServerManager();
    await manager.connect("demo", { command: process.execPath, args: [fixture] });
  });

  afterEach(async () => {
    uiHandle?.close("test-cleanup");
    uiHandle = undefined;
    await manager.closeAll();
    vi.useRealTimers();
  });

  it("keeps a proxy call's server busy while approval is pending, then releases it", async () => {
    const { state, dialogOpened, answer } = gatedState();
    const call = executeCall(state, "demo_noop", {}, "demo");
    await dialogOpened;
    advance(IDLE_MS + 1);
    expect(idle()).toBe(false);

    answer("Allow once");
    await expect(call).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
    advance(IDLE_MS + 1);
    expect(idle()).toBe(true);
  });

  it("releases a direct tool's server after a denied or aborted approval without calling the tool", async () => {
    const callTool = vi.spyOn(manager.getConnection("demo")!.client, "callTool");
    const execute = (state: McpExtensionState, signal?: AbortSignal) => createDirectToolExecutor(() => state, () => null, {
      serverName: "demo",
      originalName: "noop",
      prefixedName: "demo_noop",
      description: "",
    })("call-1", {}, signal, undefined, {} as never);

    const denial = gatedState();
    const denied = execute(denial.state);
    await denial.dialogOpened;
    advance(IDLE_MS + 1);
    expect(idle()).toBe(false);
    denial.answer("Deny");
    await expect(denied).resolves.toMatchObject({ details: { error: "approval_denied", server: "demo", tool: "noop" } });
    advance(IDLE_MS + 1);
    expect(idle()).toBe(true);

    const abort = gatedState();
    const controller = new AbortController();
    const reason = new Error("stopped");
    reason.name = "AbortError";
    const aborted = execute(abort.state, controller.signal);
    await abort.dialogOpened;
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    advance(IDLE_MS + 1);
    expect(idle()).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("keeps an app's server busy while its tool call waits for approval", async () => {
    const { state, dialogOpened, answer } = gatedState();
    uiHandle = await startUi(state);
    const response = post(uiHandle.port, "/proxy/tools/call", {
      token: uiHandle.sessionToken,
      params: { name: "noop", arguments: {} },
    });
    await dialogOpened;
    advance(IDLE_MS + 1);
    expect(idle()).toBe(false);

    answer("Allow once");
    await expect(response).resolves.toMatchObject({ ok: true, result: { content: [{ type: "text", text: "ok" }] } });
    advance(IDLE_MS + 1);
    expect(idle()).toBe(true);
  });

  it("keeps a server up while its UI page heartbeats, and lets it idle once heartbeats stop", async () => {
    uiHandle = await startUi();
    advance(IDLE_MS + 1);
    await expect(post(uiHandle.port, "/proxy/ui/heartbeat", { token: uiHandle.sessionToken, params: {} }))
      .resolves.toEqual({ ok: true, result: {} });
    expect(idle()).toBe(false);

    advance(IDLE_MS + 1);
    expect(idle()).toBe(true);
  });

  it("gives an accepted URL elicitation one more idle timeout", async () => {
    const ui = { select: vi.fn().mockResolvedValue("Open"), input: vi.fn(), notify: vi.fn() };
    manager.setElicitationConfig({ allowUrl: true, ui: ui as never });
    advance(IDLE_MS - 1000);
    await expect(manager.handleUrlElicitationRequired("demo", new UrlElicitationRequiredError([
      { mode: "url", message: "Sign in", elicitationId: "sign-in", url: "https://example.com/sign-in" },
    ]))).resolves.toBe("accept");

    advance(2000);
    expect(idle()).toBe(false);
    advance(IDLE_MS);
    expect(idle()).toBe(true);
  });
});
