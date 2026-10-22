import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSearch } from "../proxy-modes.ts";
import { semanticSearch, type SemanticSearchEvaluator } from "../semantic-search.ts";
import type { JevEvaluateInput, JevEvaluationEnvelope } from "../jev-contracts.ts";
import type { McpExtensionState } from "../state.ts";

afterEach(() => vi.unstubAllEnvs());

function stateWithTools(count = 3): McpExtensionState {
  const abort = new AbortController();
  return {
    owner: { signal: abort.signal },
    config: {
      mcpServers: { demo: { command: "demo" }, other: { command: "other" } },
      settings: { jev: { semanticSearch: true, allowedServers: ["demo", "other"] } },
    },
    toolMetadata: new Map([
      ["demo", Array.from({ length: count }, (_, index) => ({
        name: `demo_tool_${index}`,
        originalName: `tool_${index}`,
        description: index === 0 ? "Search invoices" : `Unrelated capability ${index}`,
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      }))],
      ["other", [{ name: "other_weather", originalName: "weather", description: "Forecast conditions" }]],
    ]),
    failureTracker: new Map(),
    manager: { isConnecting: vi.fn(() => false), getConnection: vi.fn(() => undefined) },
  } as unknown as McpExtensionState;
}

function choiceEvaluator(selectPath: string | "none", scores?: Record<string, number>): SemanticSearchEvaluator {
  return vi.fn(async (_state, input): Promise<JevEvaluationEnvelope> => {
    const candidates = (input.state as { candidates: Array<{ id: string; path: string }> }).candidates;
    const labels = [...candidates.map(candidate => candidate.id), "none"];
    const selected = selectPath === "none" ? "none" : candidates.find(candidate => candidate.path === selectPath)?.id ?? "none";
    const probabilities = Object.fromEntries(labels.map(label => [label, scores?.[label] ?? (label === selected ? 0.8 : 0.01)]));
    return {
      ok: true,
      data: {
        answers: { match: { type: "choice", choice: selected, confidence: 0.9, probabilities } },
        model: "jev-test",
        usage: { inputTokens: 12, outputTokens: 3 },
      },
    };
  });
}

function gatewaySemantic(state: McpExtensionState, query: string, evaluator: SemanticSearchEvaluator, regex = false) {
  return executeSearch(state, query, regex, undefined, false, 12, 0, "semantic", undefined, evaluator) as Promise<any>;
}

describe("semantic search", () => {
  it("is explicit and keeps lexical search shape unchanged", async () => {
    const state = stateWithTools();
    const evaluator = choiceEvaluator("other_weather");
    const lexical = executeSearch(state, "weather", false, undefined, false);
    expect(lexical).not.toBeInstanceOf(Promise);
    expect((lexical as any).details.backend).toBeUndefined();
    expect(evaluator).not.toHaveBeenCalled();

    const semantic = await gatewaySemantic(state, "umbrella planning", evaluator);
    expect(semantic.details).toMatchObject({
      backend: { requested: "semantic", used: "semantic", degraded: false, model: "jev-test", abstained: false },
    });
    expect(semantic.details.matches[0]).toEqual({ server: "other", tool: "other_weather", score: 0.8 });
  });

  it("rejects semantic regex without evaluating", async () => {
    const evaluator = choiceEvaluator("none");
    const result = await gatewaySemantic(stateWithTools(), "weather", evaluator, true);
    expect(result.details).toMatchObject({ error: "invalid_search_mode" });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("rejects empty semantic queries and invalid worker modes without evaluating", async () => {
    const state = stateWithTools();
    const evaluator = choiceEvaluator("none");
    const empty = await gatewaySemantic(state, "   ", evaluator);
    expect(empty.details).toMatchObject({ error: "empty_query" });
    expect(evaluator).not.toHaveBeenCalled();

    const direct = executeSearch(state, "weather", false, undefined, false, 12, 0, "invalid" as any);
    expect((direct as any).details).toMatchObject({ error: "invalid_search_mode" });
  });

  it("does no evaluator or credential work when semantic search is disabled", async () => {
    const state = stateWithTools();
    state.config.settings!.jev = { semanticSearch: false, allowedServers: ["demo"] };
    const evaluator = choiceEvaluator("none");
    vi.stubEnv("SYSTEMONE_API_KEY", "configured-key");
    const result = await gatewaySemantic(state, "anything", evaluator);
    expect(result.details).toMatchObject({ error: "disabled" });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("uses every enabled server by default when a credential is available", async () => {
    const state = stateWithTools();
    delete state.config.settings;
    state.config.mcpServers.other!.disabled = true;
    vi.stubEnv("SYSTEMONE_API_KEY", "configured-key");
    const inspect = vi.fn(async (_state: McpExtensionState, input: JevEvaluateInput) => {
      expect(input.sources).toEqual(["demo"]);
      return choiceEvaluator("demo_tool_0")(_state, input, {});
    });
    const result = await semanticSearch(state, "invoices", undefined, undefined, inspect);
    expect(result.ok && result.matches[0]?.server).toBe("demo");
    expect(result.ok && result.matches).toHaveLength(3);
  });

  it("explains missing policy and catalog setup before evaluating", async () => {
    const state = stateWithTools();
    const evaluator = choiceEvaluator("none");
    state.config.settings!.jev = { semanticSearch: true, allowedServers: [] };
    const noServers = await gatewaySemantic(state, "anything", evaluator);
    expect(noServers.content[0].text).toContain("settings.jev.allowedServers is empty");
    expect(noServers.details).toMatchObject({ error: "data_policy_denied" });

    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo"] };
    const blockedServer = await executeSearch(state, "anything", false, "other", false, 12, 0, "semantic", undefined, evaluator);
    expect(blockedServer.details).toMatchObject({ error: "data_policy_denied" });
    expect(blockedServer.content[0].text).toContain('Server "other" is not allowed');
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("uses only eligible cached metadata without connecting and sends compact opaque candidates", async () => {
    const state = stateWithTools();
    state.config.mcpServers.other!.disabled = true;
    state.failureTracker.set("demo", Date.now());
    const evaluator = choiceEvaluator("none");
    const result = await semanticSearch(state, "anything", undefined, undefined, evaluator);
    expect(result).toMatchObject({ ok: false, error: { code: "no_eligible_tools" } });
    expect(evaluator).not.toHaveBeenCalled();

    state.failureTracker.clear();
    state.config.mcpServers.other!.disabled = false;
    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo"] };
    const inspect = vi.fn(async (_state: McpExtensionState, input: JevEvaluateInput) => {
      const sent = input.state as { candidates: Array<Record<string, unknown>> };
      expect(input.sources).toEqual(["demo"]);
      expect(sent.candidates.every(candidate => /^c\d+$/.test(String(candidate.id)))).toBe(true);
      expect(JSON.stringify(sent.candidates)).not.toContain("inputSchema");
      return choiceEvaluator("none")(_state, input, {});
    });
    await semanticSearch(state, "anything", undefined, undefined, inspect);
  });

  it("caps at 127 and reserves a deterministic nonlexical recovery lane", async () => {
    const state = stateWithTools(140);
    for (let index = 0; index < 70; index++) state.toolMetadata.get("demo")![index]!.description = `needle match ${index}`;
    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo"], semanticCandidateLimit: 127 };
    const sent: Array<Array<{ path: string; description: string }>> = [];
    const inspect: SemanticSearchEvaluator = async (_state, input) => {
      sent.push((input.state as { candidates: Array<{ path: string; description: string }> }).candidates);
      return choiceEvaluator("none")(_state, input, {});
    };
    await semanticSearch(state, "needle", undefined, undefined, inspect);
    await semanticSearch(state, "needle", undefined, undefined, inspect);
    const first = sent[0]!;
    const second = sent[1]!;
    expect(first).toHaveLength(127);
    expect(first.map(candidate => candidate.path)).toEqual(second.map(candidate => candidate.path));
    expect(first.slice(63).some(candidate => !candidate.description.includes("needle"))).toBe(true);
  });

  it("ranks by probabilities and abstains for none or threshold", async () => {
    const state = stateWithTools();
    const ranked = await semanticSearch(state, "query", undefined, undefined, choiceEvaluator("demo_tool_0", { c0: 0.3, c1: 0.7, c2: 0.2, c3: 0.1, none: 0.05 }));
    expect(ranked.ok && ranked.matches.map(match => match.tool.name).slice(0, 2)).toEqual(["demo_tool_1", "demo_tool_0"]);
    const none = await semanticSearch(state, "query", undefined, undefined, choiceEvaluator("none"));
    expect(none).toMatchObject({ ok: true, matches: [], backend: { abstained: true } });
    const renderedNone = await gatewaySemantic(state, "query", choiceEvaluator("none"));
    expect(renderedNone.content[0].text).toBe('Jev found no suitable tool for "query"');
    const inconsistentNone = await semanticSearch(state, "query", undefined, undefined, choiceEvaluator("none", { c0: 0.9, none: 0.1 }));
    expect(inconsistentNone).toMatchObject({ ok: true, matches: [], backend: { abstained: true } });
    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo", "other"], semanticMinProbability: 0.9 };
    const below = await semanticSearch(state, "query", undefined, undefined, choiceEvaluator("demo_tool_0"));
    expect(below).toMatchObject({ ok: true, matches: [], backend: { abstained: true } });
  });

  it("degrades only availability failures and keeps hard errors diagnosable", async () => {
    const state = stateWithTools();
    for (const code of ["timeout", "rate_limited", "service_unavailable"] as const) {
      const evaluator: SemanticSearchEvaluator = async () => ({ ok: false, error: { code, message: "down" } });
      const result = await gatewaySemantic(state, "invoices", evaluator);
      expect(result.details).toMatchObject({ backend: { requested: "semantic", used: "lexical", degraded: true, reason: code } });
    }
    for (const code of ["credential_missing", "credential_unavailable", "endpoint_unavailable", "authentication_failed", "payment_required", "data_policy_denied", "invalid_response"] as const) {
      const evaluator: SemanticSearchEvaluator = async () => ({ ok: false, error: { code, message: "hard failure" } });
      const result = await gatewaySemantic(state, "invoices", evaluator);
      expect(result.details).toMatchObject({ error: code, message: "hard failure" });
      expect(result.details).not.toHaveProperty("backend");
    }
  });

  it("keeps the semantic server allowlist when falling back to lexical search", async () => {
    const state = stateWithTools();
    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo", "other"] };
    state.config.mcpServers.excluded = { command: "excluded" };
    state.toolMetadata.get("demo")![0]!.description = "Weather forecast";
    state.toolMetadata.set("excluded", [{ name: "excluded_weather", originalName: "weather", description: "Weather forecast" }]);
    const evaluator: SemanticSearchEvaluator = vi.fn(async (_state, input) => {
      expect(input.sources).toEqual(["demo", "other"]);
      return { ok: false, error: { code: "timeout", message: "down" } };
    });

    const gateway = await gatewaySemantic(state, "weather", evaluator);
    expect(gateway.details.backend).toMatchObject({ used: "lexical", degraded: true });
    expect(gateway.details.matches.map((match: { server: string }) => match.server).sort()).toEqual(["demo", "other"]);
  });

  it("preserves pagination, schemas, and approval markers without executing", async () => {
    const state = stateWithTools();
    state.config.settings!.approveTools = true;
    const evaluator = choiceEvaluator("demo_tool_1");
    const result = await executeSearch(state, "query", false, undefined, true, 1, 0, "semantic", undefined, evaluator);
    expect(result.details).toMatchObject({ count: 4, hasMore: true, nextOffset: 1 });
    expect(result.content[0]!.text).toContain("requires approval");
    expect(result.content[0]!.text).toContain("Shape:");
  });
});
