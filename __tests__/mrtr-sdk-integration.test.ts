import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { getInputRequiredNeedsUiDetails } from "../errors.ts";
import { executeCall } from "../proxy-modes.ts";
import { runMcpScript } from "../mcp-code.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { DirectToolSpec, ToolMetadata } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

const fixture = fileURLToPath(new URL("./fixtures/mrtr-server.mjs", import.meta.url));
const managers: McpServerManager[] = [];
const tempDirs: string[] = [];

type TestUi = {
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
};

function createUi(answers: Array<string | undefined>): TestUi {
  return {
    select: vi.fn(async () => answers.shift()),
    input: vi.fn(async () => undefined),
    notify: vi.fn(),
  };
}

function metadata(originalName: string, extra: Partial<ToolMetadata> = {}): ToolMetadata {
  return {
    name: `mrtr_${originalName}`,
    originalName,
    description: `MRTR ${originalName}`,
    inputSchema: { type: "object", properties: {} },
    ...extra,
  };
}

async function createConnectedState(options: {
  answers?: Array<string | undefined>;
  log?: boolean;
  protocolVersion?: "legacy" | "2026-07-28";
  metadata?: ToolMetadata[];
} = {}): Promise<{
  manager: McpServerManager;
  state: McpExtensionState;
  ui?: TestUi;
  logPath?: string;
}> {
  const ui = options.answers === undefined ? undefined : createUi(options.answers);
  const definition: Record<string, unknown> = {
    command: process.execPath,
    args: [fixture],
    protocolVersion: options.protocolVersion ?? "2026-07-28",
  };
  let logPath: string | undefined;
  if (options.log) {
    const tempDir = await mkdtemp(`${tmpdir()}/pi-mcp-mrtr-`);
    tempDirs.push(tempDir);
    logPath = `${tempDir}/events.jsonl`;
    definition.env = { MRTR_LOG_FILE: logPath };
  }

  const manager = new McpServerManager();
  manager.setDefaultRequestTimeoutMs(2_000);
  if (ui) manager.setElicitationConfig({ ui, allowUrl: false });
  await manager.connect("mrtr", definition as never);
  managers.push(manager);

  const defaultMetadata = [
    metadata("one_round"),
    metadata("two_rounds"),
    metadata("needs_ui"),
    metadata("abort_pending"),
    metadata("legacy_complete"),
  ];
  const state = {
    manager,
    config: { settings: { toolPrefix: "server" }, mcpServers: { mrtr: definition } },
    toolMetadata: new Map([["mrtr", options.metadata ?? defaultMetadata]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    ui,
    uiResourceHandler: new UiResourceHandler(manager),
    completedUiSessions: [],
    uiServer: null,
  } as unknown as McpExtensionState;

  return { manager, state, ...(ui ? { ui } : {}), ...(logPath ? { logPath } : {}) };
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.find((block) => block.type === "text")?.text ?? "";
}

async function readEvents(logPath: string | undefined): Promise<Array<Record<string, unknown>>> {
  if (!logPath) return [];
  const text = await readFile(logPath, "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MCP 2026-07-28 SDK-native multi-round input flows", () => {
  it("bounds typed missing-handler details without matching arbitrary error text", () => {
    const details = getInputRequiredNeedsUiDetails({
      code: "CAPABILITY_NOT_SUPPORTED",
      data: { key: "k".repeat(500), method: "elicitation/create" },
      message: "untrusted server text",
    }, {
      server: "server-".repeat(100),
      tool: "tool-".repeat(100),
    });

    expect(details).toBeDefined();
    expect(details?.error).toBe("input_required_needs_ui");
    expect(details?.inputKey.length).toBeLessThanOrEqual(128);
    expect(details?.inputMethod).toBe("elicitation/create");
    expect(details?.message).not.toContain("untrusted server text");
    expect(getInputRequiredNeedsUiDetails({ message: "CAPABILITY_NOT_SUPPORTED elicitation/create" }, {
      server: "server",
      tool: "tool",
    })).toBeUndefined();
  });

  it("fulfills one input_required result through the proxy executeCall path and keeps final output compact", async () => {
    const { state, ui } = await createConnectedState({ answers: ["Continue"] });

    const result = await executeCall(state, "mrtr_one_round", {}, "mrtr");

    expect(textOf(result)).toBe("one-round complete");
    expect(textOf(result)).not.toMatch(/input_required|requestState|elicitation\/create|Fulfilling input required/);
    expect(result.details).toMatchObject({ mode: "call", server: "mrtr", tool: "one_round" });
    expect(ui?.select).toHaveBeenCalledOnce();
  });

  it("echoes requestState byte-for-byte on both retries", async () => {
    const { state, ui, logPath } = await createConnectedState({ answers: ["Continue", "Continue"], log: true });

    const result = await executeCall(state, "mrtr_two_rounds", {}, "mrtr");
    const events = await readEvents(logPath);
    const calls = events.filter((event) => event.method === "tools/call" && event.name === "two_rounds");

    expect(textOf(result)).toBe("two-round complete");
    expect(calls).toHaveLength(3);
    expect((calls[0]?.params as Record<string, unknown> | undefined)?.requestState).toBeUndefined();
    expect((calls[1]?.params as Record<string, unknown> | undefined)?.requestState).toBe("two-round-state:first:v1");
    expect((calls[2]?.params as Record<string, unknown> | undefined)?.requestState).toBe("two-round-state:second:v1");
    expect(ui?.select).toHaveBeenCalledTimes(2);
  });

  it("fulfills the same modern input flow through a direct MCP tool executor", async () => {
    const { state, ui } = await createConnectedState({ answers: ["Continue"] });
    const spec: DirectToolSpec = {
      serverName: "mrtr",
      prefixedName: "mrtr_one_round",
      originalName: "one_round",
      description: "MRTR one_round",
      inputSchema: { type: "object", properties: {} },
    };

    const result = await createDirectToolExecutor(() => state, () => null, spec)(
      "call-1",
      {},
      undefined,
      undefined,
      undefined as never,
    );

    expect(textOf(result)).toBe("one-round complete");
    expect(result.details).toMatchObject({ server: "mrtr", tool: "one_round" });
    expect(ui?.select).toHaveBeenCalledOnce();
  });

  it.each([
    ["proxy resource", "proxy"],
    ["direct resource", "direct"],
  ] as const)("reads an input-required resource through the %s path", async (_label, adapter) => {
    const resourceUri = "test://mrtr/resource";
    const resource = metadata("resource", { resourceUri });
    const { state, ui } = await createConnectedState({ answers: ["Continue"], metadata: [resource] });

    const result = adapter === "proxy"
      ? await executeCall(state, "mrtr_resource", {}, "mrtr")
      : await createDirectToolExecutor(() => state, () => null, {
          serverName: "mrtr",
          prefixedName: "mrtr_resource",
          originalName: "resource",
          description: "MRTR resource",
          resourceUri,
        })("call-resource", {}, undefined, undefined, undefined as never);

    expect(textOf(result)).toContain("resource complete");
    expect(textOf(result)).not.toMatch(/input_required|requestState|elicitation\/create/);
    expect(result.details).toMatchObject({ server: "mrtr", resourceUri });
    expect(ui?.select).toHaveBeenCalledOnce();
  });

  it("reads an input-required UI resource through UiResourceHandler", async () => {
    const { manager, state, ui } = await createConnectedState({ answers: ["Continue"] });

    const result = await state.uiResourceHandler!.readUiResource("mrtr", "ui://mrtr/resource", {
      config: state.config,
    });

    expect(result).toMatchObject({
      uri: "ui://mrtr/resource",
      html: "<main>resource UI complete</main>",
      mimeType: "text/html",
    });
    expect(manager.getConnection("mrtr")?.inFlight).toBe(0);
    expect(ui?.select).toHaveBeenCalledOnce();
  });

  it("keeps a legacy result without resultType as a complete adapter result", async () => {
    const { state } = await createConnectedState({ protocolVersion: "legacy" });

    const result = await executeCall(state, "mrtr_legacy_complete", {}, "mrtr");

    expect(textOf(result)).toBe("legacy complete");
    expect(result.details).toMatchObject({ mode: "call", server: "mrtr", tool: "legacy_complete" });
    expect(result.details).not.toHaveProperty("error");
  });

  it.each([
    ["proxy", "tool"],
    ["direct", "tool"],
    ["proxy", "resource"],
    ["direct", "resource"],
    ["proxy", "ui"],
    ["direct", "ui"],
  ] as const)("shapes missing input handlers as input_required_needs_ui through the %s %s path", async (adapter, kind) => {
    const resourceUri = kind === "resource" ? "test://mrtr/resource" : "ui://mrtr/resource";
    const tool = kind === "tool"
      ? metadata("needs_ui")
      : kind === "resource"
        ? metadata("resource", { resourceUri })
        : metadata("app", { uiResourceUri: resourceUri });
    const { state } = await createConnectedState({ metadata: [tool] });
    const directSpec: DirectToolSpec = {
      serverName: "mrtr",
      prefixedName: tool.name,
      originalName: tool.originalName,
      description: tool.description,
      ...(tool.resourceUri ? { resourceUri: tool.resourceUri } : {}),
      ...(tool.uiResourceUri ? { uiResourceUri: tool.uiResourceUri } : {}),
    };

    const result = adapter === "proxy"
      ? await executeCall(state, tool.name, {}, "mrtr")
      : await createDirectToolExecutor(() => state, () => null, directSpec)(
          "call-no-ui",
          {},
          undefined,
          undefined,
          undefined as never,
        );

    expect(result.details).toMatchObject({
      error: "input_required_needs_ui",
      server: "mrtr",
      ...(kind === "resource" ? { resourceUri } : { tool: tool.originalName }),
      ...(kind === "ui" ? { resourceUri } : {}),
      inputMethod: "elicitation/create",
      inputKey: expect.any(String),
    });
    expect(textOf(result)).toContain("Run this call in an interactive Pi session");
    expect(textOf(result).length).toBeLessThan(600);
  });

  it("preserves input_required_needs_ui through a direct UI resource read", async () => {
    const { state } = await createConnectedState();

    await expect(state.uiResourceHandler!.readUiResource("mrtr", "ui://mrtr/resource", {
      config: state.config,
    })).rejects.toMatchObject({
      code: "input_required_needs_ui",
      details: expect.objectContaining({
        error: "input_required_needs_ui",
        server: "mrtr",
        resourceUri: "ui://mrtr/resource",
        inputMethod: "elicitation/create",
      }),
    });
  });

  it("keeps the shaped error in mcpScript's existing failure envelope", async () => {
    const { state } = await createConnectedState();

    const result = await runMcpScript(state, 'return await tools.call("mrtr_needs_ui", {});');
    const payload = JSON.parse(textOf(result));

    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "input_required_needs_ui",
        message: expect.stringContaining("Run this call in an interactive Pi session"),
      },
    });
    expect(result.details).toMatchObject({
      mode: "script",
      calls: [{ path: "mrtr_needs_ui", ok: false, error: "input_required_needs_ui" }],
    });
  });

  it("settles an aborted proxy call while embedded input is pending and never retries", async () => {
    let releaseInput!: (value: string | undefined) => void;
    const pendingInput = new Promise<string | undefined>((resolve) => {
      releaseInput = resolve;
    });
    const ui = {
      select: vi.fn(() => pendingInput),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
    };
    const logDir = await mkdtemp(`${tmpdir()}/pi-mcp-mrtr-abort-`);
    tempDirs.push(logDir);
    const logPath = `${logDir}/events.jsonl`;
    const definition = {
      command: process.execPath,
      args: [fixture],
      protocolVersion: "2026-07-28" as const,
      env: { MRTR_LOG_FILE: logPath },
    };
    const manager = new McpServerManager();
    manager.setDefaultRequestTimeoutMs(2_000);
    manager.setElicitationConfig({ ui, allowUrl: false });
    await manager.connect("mrtr", definition);
    managers.push(manager);
    const state = {
      manager,
      config: { settings: { toolPrefix: "server" }, mcpServers: { mrtr: definition } },
      toolMetadata: new Map([["mrtr", [metadata("abort_pending")]]]),
      serverInstructions: new Map(),
      failureTracker: new Map(),
      ui,
      uiResourceHandler: new UiResourceHandler(manager),
      completedUiSessions: [],
      uiServer: null,
    } as unknown as McpExtensionState;
    const controller = new AbortController();
    const call = executeCall(state, "mrtr_abort_pending", {}, "mrtr", undefined, controller.signal);

    for (let i = 0; i < 20 && ui.select.mock.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.select).toHaveBeenCalledOnce();
    controller.abort(new Error("user cancelled"));
    const result = await call;
    expect(result.details).toMatchObject({ error: "aborted", server: "mrtr", tool: "abort_pending" });
    expect(manager.getConnection("mrtr")?.inFlight).toBe(0);

    releaseInput(undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const events = await readEvents(logPath);
    expect(events.filter((event) => event.method === "tools/call" && event.name === "abort_pending")).toHaveLength(1);
  });
});
