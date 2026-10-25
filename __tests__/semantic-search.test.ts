import { describe, expect, it, vi } from "vitest";
import type { ClassifierContext, ClassifierModel, ClassifierResult, ModelsClassifierOptions } from "@earendil-works/pi-ai";
import { executeSearch } from "../proxy-modes.ts";
import { semanticSearch, type SemanticClassifierRegistry } from "../semantic-search.ts";
import type { McpExtensionState } from "../state.ts";

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

type Candidates = Array<{ id: string; path: string; server: string; description: string }>;
type Answer = (context: ClassifierContext) => Partial<ClassifierResult>;

/** A fake of Pi's model registry: the classifier seam semantic search calls. */
function registry(answer: Answer, { models = ["typesafe/jev-latest"], authed = ["typesafe"] } = {}) {
  const calls: Array<{ model: string; context: ClassifierContext; options: ModelsClassifierOptions | undefined }> = [];
  const fake = {
    calls,
    findOfType: vi.fn((_type: "classifier", provider: string, id: string) =>
      models.includes(`${provider}/${id}`) ? { provider, id } as unknown as ClassifierModel<never> : undefined),
    getProviderAuthStatus: vi.fn((provider: string) => ({ configured: authed.includes(provider) })),
    classify: vi.fn(async (model: ClassifierModel<never>, context: ClassifierContext, options?: ModelsClassifierOptions) => {
      calls.push({ model: `${model.provider}/${model.id}`, context, options });
      return { api: "fake", provider: model.provider, model: model.id, answers: {}, stopReason: "stop", timestamp: 0, ...answer(context) } as ClassifierResult;
    }),
  };
  return fake satisfies SemanticClassifierRegistry;
}

const candidatesOf = (context: ClassifierContext) => (context.state as { candidates: Candidates }).candidates;

function choose(selectPath: string | "none", scores?: Record<string, number>): Answer {
  return (context) => {
    const candidates = candidatesOf(context);
    const labels = [...candidates.map(candidate => candidate.id), "none"];
    const selected = selectPath === "none" ? "none" : candidates.find(candidate => candidate.path === selectPath)?.id ?? "none";
    const probabilities = Object.fromEntries(labels.map(label => [label, scores?.[label] ?? (label === selected ? 0.8 : 0.01)]));
    return {
      answers: { match: { type: "choice", choice: selected, confidence: 0.9, probabilities } },
      usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } },
    };
  };
}

const failWith = (errorMessage: string, stopReason: "error" | "aborted" = "error"): Answer => () => ({ stopReason, errorMessage });

function gatewaySemantic(state: McpExtensionState, query: string, classifier: SemanticClassifierRegistry | undefined, regex = false) {
  return executeSearch(state, query, regex, undefined, false, 12, 0, "semantic", undefined, classifier) as Promise<any>;
}

describe("semantic search", () => {
  it("is explicit, keeps lexical search unchanged, and names the provider and model", async () => {
    const state = stateWithTools();
    const classifier = registry(choose("other_weather"));
    const lexical = executeSearch(state, "weather", false, undefined, false);
    expect(lexical).not.toBeInstanceOf(Promise);
    expect((lexical as any).details.backend).toBeUndefined();
    expect(classifier.classify).not.toHaveBeenCalled();

    const semantic = await gatewaySemantic(state, "umbrella planning", classifier);
    expect(semantic.details.backend).toEqual({
      requested: "semantic", used: "semantic", degraded: false, provider: "typesafe", model: "typesafe/jev-latest",
      usage: { input: 12, output: 3, cost: 0.0001 }, abstained: false,
    });
    expect(semantic.details.matches[0]).toEqual({ server: "other", tool: "other_weather", score: 0.8 });
  });

  it("asks one choice question with string criteria and a none option, bounded by a timeout and the call signal", async () => {
    const classifier = registry(choose("none"));
    const call = new AbortController();
    call.abort();
    await semanticSearch(stateWithTools(1), "invoices", undefined, call.signal, classifier);
    const { context, options } = classifier.calls[0]!;
    expect(context.questions).toEqual({
      match: {
        type: "choice",
        instructions: "Rank which tool best matches the query. Choose none when no tool is suitable.",
        criteria: { c0: "The tool at path demo_tool_0", c1: "The tool at path other_weather", none: "No listed tool is suitable" },
      },
    });
    expect(options).toMatchObject({ timeoutMs: 5000, maxRetries: 0 });
    expect(options?.signal?.aborted).toBe(true);
  });

  it("rejects semantic regex, empty queries, and invalid modes without classifying", async () => {
    const state = stateWithTools();
    const classifier = registry(choose("none"));
    expect((await gatewaySemantic(state, "weather", classifier, true)).details).toMatchObject({ error: "invalid_search_mode" });
    expect((await gatewaySemantic(state, "   ", classifier)).details).toMatchObject({ error: "empty_query" });
    const direct = executeSearch(state, "weather", false, undefined, false, 12, 0, "invalid" as any);
    expect((direct as any).details).toMatchObject({ error: "invalid_search_mode" });
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it("does nothing when semantic search is turned off or Pi has no classifier models", async () => {
    const state = stateWithTools();
    const classifier = registry(choose("none"));
    state.config.settings!.jev = { semanticSearch: false, allowedServers: ["demo"] };
    expect((await gatewaySemantic(state, "anything", classifier)).details).toMatchObject({ error: "disabled" });
    state.config.settings!.jev = false;
    expect((await gatewaySemantic(state, "anything", classifier)).details).toMatchObject({ error: "disabled" });
    expect(classifier.findOfType).not.toHaveBeenCalled();

    delete state.config.settings;
    const unavailable = await gatewaySemantic(state, "anything", undefined);
    expect(unavailable.details).toMatchObject({ error: "unavailable" });
    expect(unavailable.content[0].text).toContain("word search still works");
  });

  it("uses the first default model Pi has a credential for, and an explicit model without a credential check", async () => {
    const state = stateWithTools();
    const models = ["typesafe/jev-latest", "openrouter/typesafe/jev-1.13", "cloudflare-workers-ai/typesafe/jev", "llama/qwen3"];
    const defaulted = registry(choose("none"), { models, authed: ["cloudflare-workers-ai", "openrouter"] });
    const result = await semanticSearch(state, "invoices", undefined, undefined, defaulted);
    expect(defaulted.calls.map(call => call.model)).toEqual(["openrouter/typesafe/jev-1.13"]);
    expect(result).toMatchObject({ ok: true, backend: { provider: "openrouter", model: "openrouter/typesafe/jev-1.13" } });

    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo"], model: "llama/qwen3" };
    const explicit = registry(choose("none"), { models, authed: [] });
    await semanticSearch(state, "invoices", undefined, undefined, explicit);
    expect(explicit.calls.map(call => call.model)).toEqual(["llama/qwen3"]);
    expect(explicit.getProviderAuthStatus).not.toHaveBeenCalled();
  });

  it("reports an unknown model or a missing classifier without classifying", async () => {
    const state = stateWithTools();
    const none = registry(choose("none"), { authed: [] });
    expect(await semanticSearch(state, "invoices", undefined, undefined, none)).toMatchObject({ ok: false, error: { code: "no_classifier" } });
    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo"], model: "openrouter/missing" };
    const unknown = await gatewaySemantic(state, "invoices", none);
    expect(unknown.details).toMatchObject({ error: "unknown_model" });
    expect(unknown.content[0].text).toContain('Classifier model "openrouter/missing" is not in Pi\'s model list');
    expect(none.classify).not.toHaveBeenCalled();
  });

  it("uses every enabled server by default and sends only allowed, cached, compact metadata", async () => {
    const state = stateWithTools();
    delete state.config.settings;
    state.config.mcpServers.other!.disabled = true;
    const classifier = registry(choose("demo_tool_0"));
    const result = await semanticSearch(state, "invoices", undefined, undefined, classifier);
    expect(result.ok && result.matches.map(match => match.server)).toEqual(["demo", "demo", "demo"]);

    state.config.mcpServers.other!.disabled = false;
    state.config.settings = { jev: { semanticSearch: true, allowedServers: ["demo"] } };
    await semanticSearch(state, "anything", undefined, undefined, classifier);
    const sent = classifier.calls[1]!.context;
    expect(candidatesOf(sent).map(candidate => candidate.server)).toEqual(["demo", "demo", "demo"]);
    expect(candidatesOf(sent).every(candidate => /^c\d+$/.test(candidate.id))).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("other_weather");
    expect(JSON.stringify(sent)).not.toContain("inputSchema");

    state.failureTracker.set("demo", Date.now());
    const noTools = await semanticSearch(state, "anything", undefined, undefined, classifier);
    expect(noTools).toMatchObject({ ok: false, error: { code: "no_eligible_tools" } });
    expect(classifier.classify).toHaveBeenCalledTimes(2);
  });

  it("explains missing policy before classifying", async () => {
    const state = stateWithTools();
    const classifier = registry(choose("none"));
    state.config.settings!.jev = { semanticSearch: true, allowedServers: [] };
    const noServers = await gatewaySemantic(state, "anything", classifier);
    expect(noServers.content[0].text).toContain("settings.semanticSearch.allowedServers is empty");
    expect(noServers.details).toMatchObject({ error: "data_policy_denied" });

    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo"] };
    const blockedServer = await executeSearch(state, "anything", false, "other", false, 12, 0, "semantic", undefined, classifier);
    expect(blockedServer.details).toMatchObject({ error: "data_policy_denied" });
    expect(blockedServer.content[0]!.text).toContain('Server "other" is not allowed');
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it("caps at 127 and reserves a deterministic nonlexical recovery lane", async () => {
    const state = stateWithTools(140);
    for (let index = 0; index < 70; index++) state.toolMetadata.get("demo")![index]!.description = `needle match ${index}`;
    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo"], semanticCandidateLimit: 127 };
    const classifier = registry(choose("none"));
    await semanticSearch(state, "needle", undefined, undefined, classifier);
    await semanticSearch(state, "needle", undefined, undefined, classifier);
    const [first, second] = classifier.calls.map(call => candidatesOf(call.context));
    expect(first).toHaveLength(127);
    expect(first!.map(candidate => candidate.path)).toEqual(second!.map(candidate => candidate.path));
    expect(first!.slice(63).some(candidate => !candidate.description.includes("needle"))).toBe(true);
  });

  it("ranks by probabilities and abstains for none or threshold", async () => {
    const state = stateWithTools();
    const ranked = await semanticSearch(state, "query", undefined, undefined, registry(choose("demo_tool_0", { c0: 0.3, c1: 0.7, c2: 0.2, c3: 0.1, none: 0.05 })));
    expect(ranked.ok && ranked.matches.map(match => match.tool.name).slice(0, 2)).toEqual(["demo_tool_1", "demo_tool_0"]);
    const none = await semanticSearch(state, "query", undefined, undefined, registry(choose("none")));
    expect(none).toMatchObject({ ok: true, matches: [], backend: { abstained: true } });
    const renderedNone = await gatewaySemantic(state, "query", registry(choose("none")));
    expect(renderedNone.content[0].text).toBe('typesafe/jev-latest found no suitable tool for "query"');
    const inconsistentNone = await semanticSearch(state, "query", undefined, undefined, registry(choose("none", { c0: 0.9, none: 0.1 })));
    expect(inconsistentNone).toMatchObject({ ok: true, matches: [], backend: { abstained: true } });
    state.config.settings!.jev = { semanticSearch: true, allowedServers: ["demo", "other"], semanticMinProbability: 0.9 };
    const below = await semanticSearch(state, "query", undefined, undefined, registry(choose("demo_tool_0")));
    expect(below).toMatchObject({ ok: true, matches: [], backend: { abstained: true } });
  });

  it("falls back to word search only when the classifier is unavailable, and never repeats provider text", async () => {
    const state = stateWithTools();
    const secret = "sk-live-ABC123secret";
    for (const [errorMessage, reason] of [
      ["Request timed out after 5000ms", "timeout"],
      [`System One API error (408): ${secret}`, "timeout"],
      [`System One API error (429): {"error":"${secret}"}`, "rate_limited"],
      [`Workers AI error (503): ${secret}`, "service_unavailable"],
    ] as const) {
      const result = await gatewaySemantic(state, "invoices", registry(failWith(errorMessage)));
      expect(result.details.backend).toEqual({ requested: "semantic", used: "lexical", degraded: true, provider: "typesafe", model: "typesafe/jev-latest", reason });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    for (const [answer, code, message] of [
      [failWith(`interrupted ${secret}`, "aborted"), "aborted", "Semantic search was cancelled."],
      [failWith("No API key for provider: typesafe"), "credential_missing", "typesafe has no credential in Pi. Sign in with /login or set its API key."],
      [failWith(`System One API error (401): ${secret}`), "authentication_failed", "typesafe rejected the credential."],
      [failWith(`System One API error (402): {"error":{"message":"${secret}"}}`), "payment_required", "typesafe requires payment for this account."],
      [failWith(`System One API error (400): ${secret}`), "provider_error", "typesafe/jev-latest could not rank tools (HTTP 400)."],
      [failWith(`typesafe did not return an answer for match ${secret}`), "provider_error", "typesafe/jev-latest could not rank tools."],
      [() => ({ answers: { match: { type: "bool", probability: 1 } } }) as Partial<ClassifierResult>, "invalid_response", "typesafe/jev-latest returned an invalid answer."],
    ] as const) {
      const result = await gatewaySemantic(state, "invoices", registry(answer));
      expect(result.details).toEqual({ mode: "search", error: code, message, query: "invoices" });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it("keeps the semantic server allowlist when falling back to word search", async () => {
    const state = stateWithTools();
    state.config.mcpServers.excluded = { command: "excluded" };
    state.toolMetadata.get("demo")![0]!.description = "Weather forecast";
    state.toolMetadata.set("excluded", [{ name: "excluded_weather", originalName: "weather", description: "Weather forecast" }]);
    const gateway = await gatewaySemantic(state, "weather", registry(failWith("Request timed out after 5000ms")));
    expect(gateway.details.backend).toMatchObject({ used: "lexical", degraded: true });
    expect(gateway.details.matches.map((match: { server: string }) => match.server).sort()).toEqual(["demo", "other"]);
  });

  it("preserves pagination, schemas, and approval markers without executing", async () => {
    const state = stateWithTools();
    state.config.settings!.approveTools = true;
    const result = await executeSearch(state, "query", false, undefined, true, 1, 0, "semantic", undefined, registry(choose("demo_tool_1")));
    expect(result.details).toMatchObject({ count: 4, hasMore: true, nextOffset: 1 });
    expect(result.content[0]!.text).toContain("requires approval");
    expect(result.content[0]!.text).toContain("Shape:");
  });
});
