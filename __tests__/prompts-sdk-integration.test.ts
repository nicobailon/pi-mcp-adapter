import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { lazyConnect } from "../init.ts";
import { McpServerManager } from "../server-manager.ts";
import { createPromptCommand } from "../prompts.ts";
import { reconstructPromptMetadata } from "../metadata-cache.ts";
import type { McpExtensionState } from "../state.ts";
import type { PromptMetadata } from "../types.ts";
import { formatPromptCommandName } from "../types.ts";

const fixture = fileURLToPath(new URL("./fixtures/prompts-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];

async function createConnectedManager() {
  const manager = new McpServerManager();
  await manager.connect("real", definition);
  managers.push(manager);
  return manager;
}

function buildPromptMetadata(manager: McpServerManager, prefix: "server" | "none" | "short" = "server"): PromptMetadata[] {
  const conn = manager.getConnection("real")!;
  return reconstructPromptMetadata("real", conn.prompts, prefix);
}

function commandCtx(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  return {
    hasUI: true,
    ui: { notify: vi.fn() },
    signal: undefined,
    ...overrides,
  } as unknown as ExtensionCommandContext;
}

function buildState(manager: McpServerManager, promptMetadata: PromptMetadata[]): McpExtensionState {
  return {
    manager,
    config: { mcpServers: { real: definition } },
    toolMetadata: new Map(),
    promptMetadata: new Map([["real", promptMetadata]]),
    promptMetadataLive: new Set(),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    completedUiSessions: [],
  } as unknown as McpExtensionState;
}

describe("prompts with the real MCP SDK", () => {
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(m => m.closeAll()));
  });

  it("discovers prompts advertised by the server", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);

    expect(metadata.map(p => p.commandName).sort()).toEqual([
      formatPromptCommandName("brief", "real", "server"),
      formatPromptCommandName("haiku", "real", "server"),
    ].sort());

    const brief = metadata.find(p => p.originalName === "brief")!;
    expect(brief.arguments).toHaveLength(2);
    expect(brief.arguments[0]).toMatchObject({ name: "topic", required: true });
  });

  it("dispatches a positional argument and forwards the prompt text to pi", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);
    const brief = metadata.find(p => p.originalName === "brief")!;
    const state = buildState(manager, metadata);
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;

    const command = createPromptCommand(pi, () => state, brief);
    await command.handler("mcp", commandCtx());

    expect(pi.sendUserMessage).toHaveBeenCalledWith("Give me the brief on mcp for today.");
  });

  it("passes named arguments through to prompts/get", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);
    const brief = metadata.find(p => p.originalName === "brief")!;
    const state = buildState(manager, metadata);
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;

    const command = createPromptCommand(pi, () => state, brief);
    await command.handler('topic="model context protocol" date=2026-01-01', commandCtx());

    expect(pi.sendUserMessage).toHaveBeenCalledWith(
      "Give me the brief on model context protocol for 2026-01-01.",
    );
  });

  it("preserves multi-turn role attribution", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);
    const haiku = metadata.find(p => p.originalName === "haiku")!;
    const state = buildState(manager, metadata);
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;

    const command = createPromptCommand(pi, () => state, haiku);
    await command.handler("", commandCtx());

    const [[sent]] = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(sent).toContain("[user] Write a haiku about MCP.");
    expect(sent).toContain("[assistant] Bridges of context…");
  });

  it("surfaces server errors for unknown prompts as a notify, not a user message", async () => {
    const manager = await createConnectedManager();
    const metadata = buildPromptMetadata(manager);
    const brief = metadata.find(p => p.originalName === "brief")!;
    const state = buildState(manager, metadata);
    // Point the command at a prompt name the server doesn't know.
    const bogus: PromptMetadata = { ...brief, originalName: "does-not-exist" };
    state.promptMetadata!.set("real", [bogus]);
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
    const notify = vi.fn();

    const command = createPromptCommand(pi, () => state, bogus);
    await command.handler("ai", commandCtx({ ui: { notify } as any }));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("does-not-exist"), "error");
  });
});

describe("prompt arguments refreshed by a real lazy connection", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-prompt-refresh-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map(m => m.closeAll()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("maps positional values using the refreshed argument order", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    const cached = reconstructPromptMetadata("real", [{
      name: "brief",
      arguments: [{ name: "date" }, { name: "topic", required: true }],
    }], "server");
    const state = buildState(manager, cached);
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;

    await createPromptCommand(pi, () => state, cached[0], { lazyConnect })
      .handler("mcp 2026-01-01", commandCtx());

    expect(state.promptMetadataLive!.has("real")).toBe(true);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Give me the brief on mcp for 2026-01-01.");
  });

  it("validates required arguments added since the cached definition", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    const cached = reconstructPromptMetadata("real", [{ name: "brief", arguments: [] }], "server");
    const state = buildState(manager, cached);
    const getPrompt = vi.spyOn(manager, "getPrompt");
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
    const notify = vi.fn();

    await createPromptCommand(pi, () => state, cached[0], { lazyConnect })
      .handler("", commandCtx({ ui: { notify } as any }));

    expect(state.promptMetadataLive!.has("real")).toBe(true);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Missing required argument: topic"), "error");
    expect(getPrompt).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });
});

describe("prompts capability negotiation", () => {
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(m => m.closeAll()));
  });

  it("returns an empty prompt list for servers that omit the capability", async () => {
    // The stock elicitation fixture only advertises tools + resources, so
    // fetchAllPrompts short-circuits without hitting the wire.
    const elicitationFixture = fileURLToPath(new URL("./fixtures/elicitation-server.mjs", import.meta.url));
    const manager = new McpServerManager();
    managers.push(manager);
    await manager.connect("elicit", { command: process.execPath, args: [elicitationFixture] });

    const connection = manager.getConnection("elicit")!;
    expect(connection.prompts).toEqual([]);
  });
});
