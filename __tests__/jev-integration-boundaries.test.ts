import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../index.ts";
import { semanticSearch, type SemanticSearchEvaluator } from "../semantic-search.ts";
import { getTestSecureKeyringReadCount, resetTestSecureKeyring } from "../secure-keyring.ts";
import { isToolCallApprovalRequired } from "../tool-approval.ts";
import type { McpExtensionState } from "../state.ts";

function state(): McpExtensionState {
  return {
    config: {
      settings: { approveTools: true, jev: { semanticSearch: true, allowedServers: ["demo"] } },
      mcpServers: { demo: { command: "unused" } },
    },
    toolMetadata: new Map([["demo", [{ name: "demo_act", originalName: "act", description: "Perform an action" }]]]),
    failureTracker: new Map(),
    manager: { getConnection: vi.fn(() => undefined), isConnecting: vi.fn(() => false) },
  } as unknown as McpExtensionState;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Jev integration boundaries", () => {
  it("does no credential or network I/O during extension registration", () => {
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory");
    vi.stubEnv("TYPESAFE_API_KEY", "configured-but-inert");
    resetTestSecureKeyring();
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
    expect(getTestSecureKeyringReadCount()).toBe(0);
  });

  it("keeps high semantic confidence separate from tool approval", async () => {
    const runtime = state();
    const evaluator: SemanticSearchEvaluator = async (_state, input) => {
      const id = (input.state as { candidates: Array<{ id: string }> }).candidates[0]!.id;
      return { ok: true, data: { model: "fixture", usage: { inputTokens: 1, outputTokens: 1 }, answers: { match: { type: "choice", choice: id, confidence: 1, probabilities: { [id]: 1, none: 0 } } } } };
    };
    const result = await semanticSearch(runtime, "do it", undefined, undefined, evaluator);
    expect(result).toMatchObject({ ok: true, matches: [{ tool: { name: "demo_act" }, score: 1 }] });
    expect(isToolCallApprovalRequired(runtime.config, "demo", runtime.toolMetadata.get("demo")![0]!, runtime.toolMetadata)).toBe(true);
  });

  it("packages both recipes and documents the privacy and inherited-environment boundary", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.files).toEqual(expect.arrayContaining(["examples/jev-semantic-filter.mjs", "examples/jev-accessibility-loop.mjs"]));
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("https://api.typesafe.ai");
    expect(readme).toContain("https://docs.typesafe.ai/legal");
    expect(readme).toContain("privacy and retention");
    expect(readme).toContain("no-training commitment does not mean zero retention");
    expect(readme).toContain("Stdio MCP subprocesses inherit the host environment");
    expect(readme).toContain("Script evaluation remains disabled");
  });
});
