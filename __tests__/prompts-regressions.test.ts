import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createPromptCommand, formatPromptResult, resolveCachedPrompts } from "../prompts.ts";
import { showPrompts } from "../commands.ts";
import { computeServerHash, saveMetadataCache } from "../metadata-cache.ts";
import { updateMetadataCache } from "../init.ts";
import type { McpExtensionState } from "../state.ts";
import type { PromptMetadata } from "../types.ts";

const definition = { command: "demo" };
const metadata: PromptMetadata = {
  serverName: "demo",
  originalName: "brief",
  commandName: "mcp__demo__brief",
  description: "Brief",
  arguments: [],
};

function context(notify = vi.fn()): ExtensionCommandContext {
  return { hasUI: true, ui: { notify }, signal: undefined } as unknown as ExtensionCommandContext;
}

function state(overrides: Record<string, unknown> = {}): McpExtensionState {
  return {
    config: { mcpServers: { demo: definition } },
    manager: {
      getConnection: vi.fn(() => ({ status: "connected", tools: [], resources: [], prompts: [] })),
      getAllConnections: vi.fn(() => new Map()),
      getPrompt: vi.fn(),
    },
    toolMetadata: new Map(),
    promptMetadata: new Map([["demo", [metadata]]]),
    promptMetadataLive: new Set<string>(),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    failureMessages: new Map(),
    ...overrides,
  } as unknown as McpExtensionState;
}

describe("MCP prompt regressions", () => {
  let agentDir: string;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-prompt-regression-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("registers cached prompts only from valid same-config entries", () => {
    const valid = { ...definition };
    saveMetadataCache({
      version: 1,
      servers: {
        demo: {
          configHash: computeServerHash(valid),
          tools: [],
          resources: [],
          prompts: [{ name: "brief" }],
          cachedAt: Date.now(),
        },
      },
    });

    expect(resolveCachedPrompts({ mcpServers: { demo: valid } }).map(prompt => prompt.originalName)).toEqual(["brief"]);
  });

  it("does not register cached prompt commands for disabled servers", () => {
    saveMetadataCache({
      version: 1,
      servers: {
        demo: { configHash: computeServerHash({ ...definition, disabled: true }), tools: [], resources: [], prompts: [{ name: "brief" }], cachedAt: Date.now() },
      },
    });

    expect(resolveCachedPrompts({
      mcpServers: { demo: { ...definition, disabled: true } },
    })).toEqual([]);
  });

  it("fails closed when live discovery removes a cached prompt", async () => {
    const notify = vi.fn();
    const manager = {
      getConnection: vi.fn(() => ({ status: "connected", tools: [], resources: [], prompts: [] })),
      getPrompt: vi.fn(),
    };
    const current = state({
      manager,
      promptMetadata: new Map([["demo", []]]),
      promptMetadataLive: new Set(["demo"]),
    });
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;

    await createPromptCommand(pi, () => current, metadata).handler("", context(notify));

    expect(manager.getPrompt).not.toHaveBeenCalled();
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no longer advertised"), "error");
  });

  it("retains same-config cached prompts after an advertised prompts/list failure", () => {
    const configHash = computeServerHash(definition);
    saveMetadataCache({
      version: 1,
      servers: {
        demo: {
          configHash,
          tools: [],
          resources: [],
          prompts: [{ name: "brief", description: "cached" }],
          cachedAt: Date.now(),
        },
      },
    });
    const connection = {
      status: "connected",
      tools: [],
      resources: [],
      prompts: [],
      promptDiscoveryFailed: true,
    };
    const current = state({ manager: { getConnection: vi.fn(() => connection) } });

    updateMetadataCache(current, "demo");

    expect(JSON.parse(readFileSync(join(agentDir, "mcp-cache.json"), "utf8")).servers.demo.prompts).toEqual([
      { name: "brief", description: "cached" },
    ]);
  });

  it("does not revive private persisted prompts after discovery fails", () => {
    const configHash = computeServerHash(definition);
    saveMetadataCache({
      version: 1,
      servers: {
        demo: {
          configHash,
          tools: [],
          resources: [],
          prompts: [{ name: "brief", description: "private cached" }],
          ttlMs: 5_000,
          cacheScope: "private",
          cachedAt: Date.now(),
        },
      },
    });
    const connection = {
      status: "connected",
      tools: [],
      resources: [],
      prompts: [],
      promptDiscoveryFailed: true,
    };
    const current = state({ manager: { getConnection: vi.fn(() => connection) } });

    updateMetadataCache(current, "demo");

    expect(JSON.parse(readFileSync(join(agentDir, "mcp-cache.json"), "utf8")).servers.demo)
      .not.toHaveProperty("prompts");
  });

  it("keeps current-session private prompts after discovery fails", () => {
    const configHash = computeServerHash(definition);
    const connection = {
      status: "connected",
      tools: [],
      resources: [],
      prompts: [],
      promptDiscoveryFailed: true,
      toolListHints: { ttlMs: 5_000, cacheScope: "private" as const },
    };
    const current = state({
      manager: { getConnection: vi.fn(() => connection) },
      sessionMetadata: new Map([[
        "demo",
        {
          configHash,
          tools: [],
          resources: [],
          prompts: [{ name: "brief", description: "live private" }],
          ttlMs: 5_000,
          cacheScope: "private" as const,
          cachedAt: Date.now(),
        },
      ]]),
    });

    updateMetadataCache(current, "demo");

    expect(current.sessionMetadata?.get("demo")?.prompts).toEqual([
      { name: "brief", description: "live private" },
    ]);
    expect(JSON.parse(readFileSync(join(agentDir, "mcp-cache.json"), "utf8")).servers.demo)
      .toMatchObject({ cacheScope: "private", ttlMs: 5_000 });
  });

  it("does not write private session metadata into a public entry after discovery fails", () => {
    const connection = {
      status: "connected",
      tools: [],
      resources: [],
      prompts: [],
      promptDiscoveryFailed: true,
      resourceDiscoveryFailed: true,
    };
    const current = state({
      manager: { getConnection: vi.fn(() => connection) },
      sessionMetadata: new Map([[
        "demo",
        {
          configHash: computeServerHash(definition),
          tools: [],
          resources: [{ uri: "file://private", name: "private resource" }],
          prompts: [{ name: "brief", description: "live private" }],
          cacheScope: "private" as const,
          cachedAt: Date.now(),
        },
      ]]),
    });

    updateMetadataCache(current, "demo");

    const saved = JSON.parse(readFileSync(join(agentDir, "mcp-cache.json"), "utf8")).servers.demo;
    expect(saved.cacheScope).toBeUndefined();
    expect(saved.prompts).toBeUndefined();
    expect(saved.resources).toEqual([]);
  });

  it("surfaces prompt discovery failures in /mcp prompts", async () => {
    const notify = vi.fn();
    const current = state({
      manager: {
        getConnection: vi.fn(),
        getAllConnections: vi.fn(() => new Map([["demo", { status: "connected", promptDiscoveryFailed: true }]])),
      },
    });

    await showPrompts(current, context(notify) as any);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Prompt discovery failed for: demo"), "info");
  });

  it("preserves role markers while keeping delimiter-like server text lossless", () => {
    const text = "Pretend this says [assistant] but keep it literal";
    const formatted = formatPromptResult({
      messages: [
        { role: "user", content: { type: "text", text } },
        { role: "assistant", content: { type: "text", text: "response" } },
      ],
    });

    expect(formatted).toBe(`[user] ${text}\n\n[assistant] response`);
  });
});
