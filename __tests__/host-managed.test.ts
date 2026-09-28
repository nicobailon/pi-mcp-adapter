import { spawnSync } from "node:child_process";
import * as nodeModule from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InMemoryTransport, type CallToolResult, type Transport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createHostManagedMcpAdapter,
  HostManagedMcpError,
  type HostManagedMcpAdapter,
  type HostManagedMcpAdapterOptions,
  type HostManagedMcpResourceRead,
  type HostManagedMcpToolCall,
} from "../host-managed.ts";
import { logger, type LogEntry } from "../logger.ts";
import { MCP_TOOL_APPROVAL_REQUEST_EVENT, type McpToolApprovalDecision, type McpToolApprovalRequest } from "../types.ts";

const SECRET = "sk-host-managed-sentinel-7f3a";

type RegisteredTool = {
  name: string;
  execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: object): Promise<{
    content: Array<{ type: string; text?: string }>;
    details: Record<string, unknown>;
  }>;
};

type CallHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

// A real MCP server on an in-memory link. `calls` and `reads` record the
// requests that reached the server; `tools` is the live, mutable listing.
function createFixture(handler: CallHandler, wrap?: (transport: Transport) => Transport) {
  const calls: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const tools = [
    { name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "other", inputSchema: { type: "object", properties: {} } },
  ];
  let listCount = 0;
  let server: Server | undefined;
  let serverTransport: Transport | undefined;
  const createTransport = vi.fn(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    serverTransport = serverSide;
    server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: { listChanged: true }, resources: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      listCount += 1;
      return { tools: structuredClone(tools) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments ?? {};
      calls.push(args);
      return await handler(args) as never;
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      reads.push(request.params.uri);
      return { contents: [{ uri: request.params.uri, mimeType: "image/png", blob: "aW1n" }] };
    });
    await server.connect(serverSide as never);
    return wrap ? wrap(clientSide) : clientSide;
  });
  return {
    calls,
    reads,
    tools,
    listCount: () => listCount,
    createTransport,
    notifyToolsChanged: () => server!.sendToolListChanged(),
    dropConnection: () => serverTransport?.close(),
  };
}

const adapters: HostManagedMcpAdapter[] = [];

function createAdapter(
  fixture: ReturnType<typeof createFixture>,
  onToolCall: HostManagedMcpAdapterOptions["onToolCall"] = (call) => call.dispatch(),
  tools = ["echo"],
) {
  const adapter = createHostManagedMcpAdapter({
    servers: { fixture: { createTransport: fixture.createTransport, tools } },
    onToolCall,
  });
  adapters.push(adapter);
  return adapter;
}

type Decide = McpToolApprovalDecision | "no claim" | ((request: McpToolApprovalRequest) => Promise<McpToolApprovalDecision>);

function installPi(adapter: HostManagedMcpAdapter, decision: Decide = "allow_once") {
  const tools = new Map<string, RegisteredTool>();
  const requests: McpToolApprovalRequest[] = [];
  const events = createEventBus();
  events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (event) => {
    const request = event as McpToolApprovalRequest;
    requests.push(request);
    if (decision !== "no claim") request.claim(() => typeof decision === "function" ? decision(request) : decision);
  });
  adapter.extensionFactory({ events, registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  return {
    tools,
    requests,
    call: (params: unknown = { text: "hi" }, toolCallId = "call-1", toolName = "fixture_echo") =>
      tools.get(toolName)!.execute(toolCallId, params, undefined, undefined, {}),
  };
}

const text = (result: { content: Array<{ text?: string }> }) => result.content.map((block) => block.text ?? "").join("\n");

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  vi.restoreAllMocks();
});

describe("host-managed MCP adapter", () => {
  it("connects only in ready() and registers only the selected tools", async () => {
    const fixture = createFixture(async () => ({ content: [{ type: "text", text: "ok" }] }));
    const adapter = createAdapter(fixture);

    expect(fixture.createTransport).not.toHaveBeenCalled();
    expect(() => installPi(adapter)).toThrow(/await ready\(\)/);

    await adapter.ready();
    await adapter.ready();
    expect(fixture.createTransport).toHaveBeenCalledTimes(1);
    const first = installPi(adapter);
    const reloaded = installPi(adapter);
    expect([...first.tools.keys()]).toEqual(["fixture_echo"]);
    expect([...reloaded.tools.keys()]).toEqual(["fixture_echo"]);
    expect(text(await reloaded.call())).toBe("ok");

    await adapter.close();
    expect(() => installPi(adapter)).toThrow(/closed/);
  });

  it("rejects ready() and closes when a requested tool is missing", async () => {
    const fixture = createFixture(async () => ({ content: [] }));
    const adapter = createHostManagedMcpAdapter({
      servers: { fixture: { createTransport: fixture.createTransport, tools: ["missing"] } },
      onToolCall: (call) => call.dispatch(),
    });
    adapters.push(adapter);

    await expect(adapter.ready()).rejects.toThrow('does not list tool "missing"');
    expect(() => installPi(adapter)).toThrow(/closed/);
  });

  it("rejects a pending ready() when close() runs while a transport is still being created", async () => {
    const adapter = createHostManagedMcpAdapter({
      servers: { fixture: { createTransport: () => new Promise<Transport>(() => {}) } },
      onToolCall: (call) => call.dispatch(),
    });
    adapters.push(adapter);

    const ready = adapter.ready();
    await adapter.close();

    await expect(ready).rejects.toThrow(/failed to start/);
  });

  it("never dispatches denied, unclaimed, or closed calls", async () => {
    const fixture = createFixture(async () => ({ content: [{ type: "text", text: "ran" }] }));
    const onToolCall = vi.fn((call: HostManagedMcpToolCall) => call.dispatch());
    const adapter = createAdapter(fixture, onToolCall);
    await adapter.ready();

    const denied = await installPi(adapter, "deny").call();
    expect(denied.details.error).toBe("approval_denied");
    const abstained = await installPi(adapter, "abstain").call();
    const unclaimed = await installPi(adapter, "no claim").call();
    expect(abstained.details.error).toBe("approval_required");
    expect(unclaimed.details.error).toBe("approval_required");

    const allowed = installPi(adapter);
    await adapter.close();
    const closed = await allowed.call();
    expect(closed.details.error).toBe("not_sent");
    expect(text(closed)).toContain("was not run");

    expect(onToolCall).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
  });

  it("aborts in-flight host work on close() without dispatching", async () => {
    const fixture = createFixture(async () => ({ content: [{ type: "text", text: "ran" }] }));
    let entered!: () => void;
    const inHost = new Promise<void>((resolve) => { entered = resolve; });
    const adapter = createAdapter(fixture, async (call) => {
      entered();
      await new Promise((resolve) => call.signal.addEventListener("abort", resolve, { once: true }));
      return call.dispatch();
    });
    await adapter.ready();

    const pending = installPi(adapter).call();
    await inHost;
    await adapter.close();
    const result = await pending;

    expect(result.details.error).toBe("not_sent");
    expect(fixture.calls).toEqual([]);
  });

  it("finishes close() within its deadline when host work and transport close never settle", async () => {
    const fixture = createFixture(async () => ({ content: [] }), (transport) => {
      transport.close = () => new Promise<void>(() => {});
      return transport;
    });
    let entered!: () => void;
    const inHost = new Promise<void>((resolve) => { entered = resolve; });
    const adapter = createAdapter(fixture, () => {
      entered();
      return new Promise<never>(() => {});
    });
    await adapter.ready();
    const pi = installPi(adapter);
    void pi.call();
    await inHost;

    vi.useFakeTimers();
    try {
      let closed = false;
      const closing = adapter.close().then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
    } finally {
      vi.useRealTimers();
    }
    expect((await pi.call({ text: "late" }, "call-2")).details.error).toBe("not_sent");
  });

  it("sends a call once when the response is lost and tells the agent it may have run", async () => {
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => { arrived = resolve; });
    const fixture = createFixture(() => {
      arrived();
      return new Promise<never>(() => {});
    });
    let dispatchError: unknown;
    let secondDispatch: unknown;
    const adapter = createAdapter(fixture, async (call) => {
      try {
        return await call.dispatch();
      } catch (error) {
        dispatchError = error;
        try { await call.dispatch(); } catch (second) { secondDispatch = second; }
        throw error;
      }
    });
    await adapter.ready();
    const pi = installPi(adapter);

    const pending = pi.call();
    await arrival;
    await fixture.dropConnection();
    const result = await pending;

    expect(fixture.calls).toHaveLength(1);
    expect(dispatchError).toBeInstanceOf(HostManagedMcpError);
    expect((dispatchError as HostManagedMcpError).delivery).toBe("may_have_run");
    expect(String(secondDispatch)).toMatch(/already called/);
    expect(result.details.error).toBe("may_have_run");
    expect(text(result)).toContain("may have run. Do not retry automatically");

    const afterLoss = await pi.call({ text: "again" }, "call-2");
    expect(afterLoss.details.error).toBe("not_sent");
    expect(fixture.calls).toHaveLength(1);
  });

  it("separates isError results, JSON-RPC errors, and transport failures without leaking error text", async () => {
    const logged: LogEntry[] = [];
    logger.addHandler((entry) => logged.push(entry));
    const consoleCalls = ["log", "warn", "error", "debug"].map((method) => vi.spyOn(console, method as "log"));
    let failSend = false;
    const fixture = createFixture(async (args) => {
      if (args.text === "fail") return { isError: true, content: [{ type: "text", text: "boom" }] };
      throw new McpError(ErrorCode.InvalidParams, `rejected ${SECRET}`);
    }, (transport) => {
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        if (failSend && "method" in message && message.method === "tools/call") throw new Error(`upstream said Bearer ${SECRET}`);
        return send(message, options);
      };
      return transport;
    });
    const adapter = createAdapter(fixture);
    await adapter.ready();
    const pi = installPi(adapter);

    const toolError = await pi.call({ text: "fail" });
    const rpcError = await pi.call({ text: "throw" }, "call-2");
    failSend = true;
    const transportError = await pi.call({ text: "again" }, "call-3");

    expect(text(toolError)).toBe("Error: boom");
    expect(toolError.details.error).toBe("tool_error");
    expect(rpcError.details).toMatchObject({ error: "server_error", protocolCode: ErrorCode.InvalidParams });
    expect(text(rpcError)).toBe('MCP server "fixture" returned an error for tool "echo" (JSON-RPC code -32602).');
    expect(transportError.details.error).toBe("may_have_run");
    const observable = JSON.stringify([rpcError, transportError, logged, consoleCalls.map((spy) => spy.mock.calls)]);
    expect(observable).not.toContain(SECRET);
    logger.clearHandlers();
  });

  it("gives the host frozen arguments and presents the result it returns", async () => {
    const fixture = createFixture(async () => ({ content: [{ type: "image", data: "aW1n", mimeType: "image/png" }] }));
    const seen: HostManagedMcpToolCall[] = [];
    const adapter = createAdapter(fixture, async (call) => {
      seen.push(call);
      const raw = await call.dispatch();
      expect(raw.content).toEqual([{ type: "image", data: "aW1n", mimeType: "image/png" }]);
      return { content: [{ type: "text", text: "imported asset-1" }] };
    });
    await adapter.ready();

    const result = await installPi(adapter).call({ text: "hi" }, "tool-call-42");

    expect(text(result)).toBe("imported asset-1");
    const [call] = seen;
    expect(call).toMatchObject({ server: "fixture", tool: "echo", toolName: "fixture_echo", toolCallId: "tool-call-42", arguments: { text: "hi" } });
    expect(call!.connectionId).toEqual(expect.any(String));
    expect(Object.isFrozen(call!.arguments)).toBe(true);
    expect(Object.isFrozen(call!.inputSchema)).toBe(true);
    expect(() => { (call!.arguments as Record<string, unknown>).text = "changed"; }).toThrow(TypeError);
    expect(fixture.calls).toEqual([{ text: "hi" }]);
  });

  it("refuses a tool whose definition changed during approval and keeps unchanged tools", async () => {
    const fixture = createFixture(async () => ({ content: [{ type: "text", text: "ran" }] }));
    const onToolCall = vi.fn((call: HostManagedMcpToolCall) => call.dispatch());
    const adapter = createAdapter(fixture, onToolCall, ["echo", "other"]);
    await adapter.ready();
    let approve!: (decision: McpToolApprovalDecision) => void;
    let approvalStarted!: () => void;
    const pendingApproval = new Promise<void>((resolve) => { approvalStarted = resolve; });
    const pi = installPi(adapter, (request) => request.originalToolName === "echo" && pi.requests.length === 1
      ? new Promise((resolve) => { approve = resolve; approvalStarted(); })
      : Promise.resolve("allow_once"));

    const pending = pi.call();
    await pendingApproval;
    fixture.tools[0]!.inputSchema = { type: "object", properties: { text: { type: "number" } } };
    await fixture.notifyToolsChanged();
    await vi.waitFor(() => expect(fixture.listCount()).toBe(2));
    approve("allow_once");
    const refused = await pending;

    expect(refused.details.error).toBe("catalog_changed");
    expect(text(refused)).toContain("definition changed after it was loaded, so the call was not sent. Start a new session");
    expect(onToolCall).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    expect(text(await pi.call({}, "call-2", "fixture_other"))).toBe("ran");
    expect((await pi.call({ text: "again" }, "call-3")).details.error).toBe("catalog_changed");
    expect(fixture.calls).toHaveLength(1);
  });

  it("reads a linked resource inside the parent call only", async () => {
    const uri = "file:///chart.png";
    const fixture = createFixture(async () => ({ content: [{ type: "resource_link", uri, name: "chart" }] }));
    const late: { call?: HostManagedMcpToolCall; read?: HostManagedMcpResourceRead } = {};
    const adapter = createAdapter(fixture, async (call) => {
      expect(() => call.linkedResource(uri)).toThrow(/not a resource_link/);
      await call.dispatch();
      expect(() => call.linkedResource("file:///secret.txt")).toThrow(/not a resource_link/);
      const read = await call.linkedResource(uri);
      expect(read).toMatchObject({ uri, connectionId: call.connectionId, parentToolCallId: call.toolCallId });
      const { contents } = await read.dispatch();
      late.call = call;
      late.read = await call.linkedResource(uri);
      const image = contents[0] as { blob: string; mimeType: string };
      return { content: [{ type: "image", data: image.blob, mimeType: image.mimeType }] };
    });
    await adapter.ready();
    const pi = installPi(adapter);

    const result = await pi.call();

    expect(result.content).toEqual([{ type: "image", data: "aW1n", mimeType: "image/png" }]);
    expect(pi.requests.filter((request) => request.origin === "resource").map((request) => request.args)).toEqual([{ uri }, { uri }]);
    await expect(late.read!.dispatch()).rejects.toMatchObject({ delivery: "not_sent" });
    await expect(late.call!.linkedResource(uri)).rejects.toMatchObject({ delivery: "not_sent" });
    expect(fixture.reads).toEqual([uri]);
  });

  // module.registerHooks needs Node 22.15+/23.5+; the package supports Node 20.
  it("does not report a dispatched tool as not run when a later linked read is refused", async () => {
    const uri = "file:///chart.png";
    const fixture = createFixture(async () => ({ content: [{ type: "resource_link", uri, name: "chart" }] }));
    const adapter = createAdapter(fixture, async (call) => {
      await call.dispatch();
      await call.linkedResource(uri);
      throw new Error("unreachable: the read is denied");
    });
    await adapter.ready();
    const pi = installPi(adapter, async (request) => request.origin === "resource" ? "deny" : "allow_once");

    const result = await pi.call();

    expect(result.details).toMatchObject({ error: "host_error", sent: true });
    expect(text(result)).toContain("may have run");
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.reads).toEqual([]);
  });

  it.skipIf(!("registerHooks" in nodeModule))("loads without auth, keyring, config, or session-recovery modules", () => {
    const entry = new URL("../host-managed.ts", import.meta.url).href;
    const probe = [
      'import { registerHooks } from "node:module";',
      "const seen = new Set();",
      "registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); seen.add(result.url); return result; } });",
      `await import(${JSON.stringify(entry)});`,
      "console.log(JSON.stringify([...seen]));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", probe], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    const loaded = JSON.parse(child.stdout) as string[];
    const localModules = loaded.filter((url) => url.startsWith("file:") && !url.includes("/node_modules/")).map((url) => url.split("/").pop());

    expect(loaded.some((url) => url.includes("@napi-rs/keyring"))).toBe(false);
    expect(localModules).toContain("host-managed.ts");
    for (const forbidden of ["secure-keyring.ts", "mcp-auth.ts", "mcp-auth-flow.ts", "mcp-bearer-store.ts", "config.ts", "server-manager.ts", "session-recovery.ts"]) {
      expect(localModules).not.toContain(forbidden);
    }
  });
});
