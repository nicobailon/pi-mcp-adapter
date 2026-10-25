import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../index.ts";
import { semanticSearch, type SemanticClassifierRegistry } from "../semantic-search.ts";
import { isToolCallApprovalRequired } from "../tool-approval.ts";
import type { McpExtensionState } from "../state.ts";

function state(): McpExtensionState {
  return {
    owner: { signal: new AbortController().signal },
    config: {
      settings: { approveTools: true, semanticSearch: { allowedServers: ["demo"] } },
      mcpServers: { demo: { command: "unused" } },
    },
    toolMetadata: new Map([["demo", [{ name: "demo_act", originalName: "act", description: "Perform an action" }]]]),
    failureTracker: new Map(),
    manager: { getConnection: vi.fn(() => undefined), isConnecting: vi.fn(() => false) },
  } as unknown as McpExtensionState;
}

afterEach(() => vi.restoreAllMocks());

describe("semantic search boundaries", () => {
  it("does no network I/O during extension registration", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const registerTool = vi.fn();
    createMcpAdapter({ config: { settings: {}, mcpServers: {} } })({
      registerTool,
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      events: { on: vi.fn(), emit: vi.fn() },
      getAllTools: vi.fn(() => []),
    } as any);
    expect(registerTool).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps high semantic confidence separate from tool approval", async () => {
    const runtime = state();
    const classifier = {
      findOfType: (_type, provider, id) => ({ provider, id }) as never,
      getProviderAuthStatus: () => ({ configured: true }),
      classify: async (_model, context) => {
        const id = (context.state as { candidates: Array<{ id: string }> }).candidates[0]!.id;
        return { api: "fixture", provider: "typesafe", model: "jev-latest", stopReason: "stop", timestamp: 0, answers: { match: { type: "choice", choice: id, confidence: 1, probabilities: { [id]: 1, none: 0 } } } };
      },
    } satisfies SemanticClassifierRegistry;
    const result = await semanticSearch(runtime, "do it", undefined, undefined, classifier);
    expect(result).toMatchObject({ ok: true, matches: [{ tool: { name: "demo_act" }, score: 1 }] });
    expect(isToolCallApprovalRequired(runtime.config, "demo", runtime.toolMetadata.get("demo")![0]!, runtime.toolMetadata)).toBe(true);
  });

  it("documents the privacy and inherited-environment boundary", () => {
    const readme = readFileSync(new URL("../docs/scripting.md", import.meta.url), "utf8");
    expect(readme).toContain("https://api.typesafe.ai");
    expect(readme).toContain("https://docs.typesafe.ai/legal");
    expect(readme).toContain("privacy and retention");
    expect(readme).toContain("no-training commitment does not mean zero retention");
    expect(readme).toContain("Stdio MCP subprocesses inherit the host environment");
    expect(readme).toContain("Jev ranks matching tools but never executes them");
  });
});
