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
      settings: { semanticSearch: { allowedServers: ["demo", "other"] } },
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

function gatewaySemantic(state: McpExtensionState, query: string, classifier: unknown, regex = false) {
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

  it("asks one choice question with string criteria and a none option, bounded by a timeout, the call signal and the runtime owner", async () => {
    const classifier = registry(choose("none"));
    const call = new AbortController();
    const owner = new AbortController();
    const state = stateWithTools(1);
    state.owner = { signal: owner.signal } as McpExtensionState["owner"];
    await semanticSearch(state, "invoices", undefined, call.signal, classifier);
    const { context, options } = classifier.calls[0]!;
    expect(context.questions).toEqual({
      match: {
        type: "choice",
        instructions: "Rank which tool best matches the query. Choose none when no tool is suitable.",
        criteria: { c0: "The tool at path demo_tool_0", c1: "The tool at path other_weather", none: "No listed tool is suitable" },
      },
    });
    expect(options).toMatchObject({ timeoutMs: 5000, maxRetries: 0 });
    // Either the tool call or the adapter's runtime shutting down cancels the request.
    owner.abort();
    expect(options?.signal?.aborted).toBe(true);
    await semanticSearch(stateWithTools(1), "invoices", undefined, call.signal, classifier);
    call.abort();
    expect(classifier.calls[1]!.options?.signal?.aborted).toBe(true);
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
    state.config.settings!.semanticSearch = false;
    expect((await gatewaySemantic(state, "anything", classifier)).details).toMatchObject({ error: "disabled" });
    expect(classifier.findOfType).not.toHaveBeenCalled();

    delete state.config.settings;
    // Pi before 0.99 has a model registry without classify(); other hosts have none.
    for (const modelRegistry of [{ findOfType: vi.fn() }, undefined]) {
      const unavailable = await gatewaySemantic(state, "anything", modelRegistry);
      expect(unavailable.details).toMatchObject({ error: "unavailable" });
      expect(unavailable.content[0].text).toContain("word search still works");
    }
  });

  it("uses the first default model Pi has a credential for, and an explicit model without a credential check", async () => {
    const state = stateWithTools();
    const models = ["typesafe/jev-latest", "openrouter/typesafe/jev-1.13", "cloudflare-workers-ai/typesafe/jev", "llama/qwen3"];
    const defaulted = registry(choose("none"), { models, authed: ["cloudflare-workers-ai", "openrouter"] });
    const result = await semanticSearch(state, "invoices", undefined, undefined, defaulted);
    expect(defaulted.calls.map(call => call.model)).toEqual(["openrouter/typesafe/jev-1.13"]);
    expect(result).toMatchObject({ ok: true, backend: { provider: "openrouter", model: "openrouter/typesafe/jev-1.13" } });

    state.config.settings!.semanticSearch = { allowedServers: ["demo"], model: "llama/qwen3" };
    const explicit = registry(choose("none"), { models, authed: [] });
    await semanticSearch(state, "invoices", undefined, undefined, explicit);
    expect(explicit.calls.map(call => call.model)).toEqual(["llama/qwen3"]);
    expect(explicit.getProviderAuthStatus).not.toHaveBeenCalled();
  });

  it("reports an unknown model or a missing classifier without classifying", async () => {
    const state = stateWithTools();
    const none = registry(choose("none"), { authed: [] });
    expect(await semanticSearch(state, "invoices", undefined, undefined, none)).toMatchObject({ ok: false, error: { code: "no_classifier" } });
    state.config.settings!.semanticSearch = { allowedServers: ["demo"], model: "openrouter/missing" };
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
    state.config.settings = { semanticSearch: { allowedServers: ["demo"] } };
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
    state.config.settings!.semanticSearch = { allowedServers: [] };
    const noServers = await gatewaySemantic(state, "anything", classifier);
    expect(noServers.content[0].text).toContain("settings.semanticSearch.allowedServers is empty");
    expect(noServers.details).toMatchObject({ error: "data_policy_denied" });

    state.config.settings!.semanticSearch = { allowedServers: ["demo"] };
    const blockedServer = await executeSearch(state, "anything", false, "other", false, 12, 0, "semantic", undefined, classifier);
    expect(blockedServer.details).toMatchObject({ error: "data_policy_denied" });
    expect(blockedServer.content[0]!.text).toContain('Server "other" is not allowed');
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it("caps at 127 and reserves a deterministic nonlexical recovery lane", async () => {
    const state = stateWithTools(140);
    for (let index = 0; index < 70; index++) state.toolMetadata.get("demo")![index]!.description = `needle match ${index}`;
    state.config.settings!.semanticSearch = { allowedServers: ["demo"], candidateLimit: 127 };
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
    state.config.settings!.semanticSearch = { allowedServers: ["demo", "other"], minProbability: 0.9 };
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

  it("prints schemas only for hits within a quarter of the top score", async () => {
    const search = (answer: Answer, limit = 12, offset = 0) => executeSearch(stateWithTools(), "query", false, undefined, undefined, limit, offset, "semantic", undefined, registry(answer)) as Promise<any>;
    const byPath = (scores: Record<string, number>): Answer => (context) => {
      const ids = Object.fromEntries(candidatesOf(context).map(candidate => [candidate.path, candidate.id]));
      return choose(Object.keys(scores)[0]!, Object.fromEntries(Object.entries(scores).map(([path, score]) => [ids[path]!, score])))(context);
    };
    const one = (await search(byPath({ demo_tool_0: 0.9, demo_tool_1: 0.05 }))).content[0].text;
    expect(one.match(/Shape:/g)).toHaveLength(1);
    expect(one).toContain("- demo_tool_1 - Unrelated capability 1");
    expect(one).toContain("Shapes shown for the strongest matches only");
    // The bar comes from the top of the whole result, so a later page lists names only.
    const pageTwo = (await search(byPath({ demo_tool_0: 0.9, demo_tool_1: 0.05 }), 1, 1)).content[0].text;
    expect(pageTwo).not.toContain("Shape:");
    expect(pageTwo).toContain("- demo_tool_1 - Unrelated capability 1");

    const two = (await search(byPath({ demo_tool_0: 0.6, demo_tool_1: 0.3 }))).content[0].text;
    expect(two.match(/Shape:/g)).toHaveLength(2);
    expect(two).toContain("- demo_tool_2 - Unrelated capability 2");
  });

  it("marks tools whose server allows extract, in either search mode", async () => {
    const state = stateWithTools(1);
    state.config.settings!.extraction = { allowedServers: ["demo"] };
    const lexical = (executeSearch(state, "invoices|forecast", true, undefined, false) as any).content[0].text;
    expect(lexical).toContain("- demo_tool_0 (extract allowed) - Search invoices");
    expect(lexical).toContain("- other_weather - Forecast conditions");
    const semantic = (await gatewaySemantic(state, "query", registry(choose("demo_tool_0")))).content[0].text;
    expect(semantic).toContain("demo_tool_0 (extract allowed)");
  });
});

/** Notes tools share words with "plan my week"; the calendar tool that fits does not, and mail is noise. */
function bigCatalog(): McpExtensionState {
  const tools = (server: string, count: number, description: (index: number) => string) =>
    Array.from({ length: count }, (_, index) => ({ name: `${server}_tool_${index}`, originalName: `tool_${index}`, description: description(index) }));
  const state = stateWithTools();
  state.config.mcpServers = { notes: { command: "n" }, mail: { command: "m" }, calendar: { command: "c" }, off: { command: "o", disabled: true }, private: { command: "p" } };
  state.config.settings = { semanticSearch: { allowedServers: ["notes", "mail", "calendar", "off"], candidateLimit: 4 } };
  state.toolMetadata = new Map([
    ["notes", tools("notes", 10, index => `Plan my week notes ${index}`)],
    ["mail", tools("mail", 10, index => `Send message ${index}`)],
    ["calendar", [
      { name: "calendar_book", originalName: "book", description: "Create an event at a time" },
      { name: "calendar_list", originalName: "list", description: "List events" },
    ]],
    ["off", tools("off", 3, () => "Plan my week")],
    ["private", tools("private", 3, () => "Plan my week")],
  ]);
  return state;
}

const serversOf = (context: ClassifierContext) => (context.state as { servers: Array<{ id: string; name: string; tools: string[] }> }).servers;

/** Stage 1 puts `first` on top; stage 2 picks `tool`. */
function serverFirst(first: string, tool: string): Answer {
  return (context) => {
    if (!context.questions.server) return choose(tool)(context);
    const probabilities = Object.fromEntries([...serversOf(context).map(entry => [entry.id, entry.name === first ? 0.9 : 0.02]), ["none", 0.01]]);
    const choice = serversOf(context).find(entry => entry.name === first)!.id;
    return {
      answers: { server: { type: "choice", choice, confidence: 0.9, probabilities } },
      usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } },
    };
  };
}

describe("semantic search on big catalogs", () => {
  it("asks which servers fit first, so a tool that shares no words with the query is still ranked", async () => {
    const classifier = registry(serverFirst("calendar", "calendar_book"));
    const result = await semanticSearch(bigCatalog(), "plan my week", undefined, undefined, classifier);

    const candidates = candidatesOf(classifier.calls.at(-1)!.context).map(candidate => candidate.path);
    expect(candidates).toContain("calendar_book");
    expect(candidates).toHaveLength(4);
    expect(candidates.slice(0, 2)).toEqual(["calendar_book", "calendar_list"]);
    expect(classifier.calls).toHaveLength(2);
    expect(result.ok && result.matches[0]).toMatchObject({ server: "calendar", tool: { name: "calendar_book" } });
    expect(result).toMatchObject({ backend: { usage: { input: 24, output: 6, cost: 0.0002 } } });
  });

  it("sends only the allowed, enabled servers and their tool names in the first call", async () => {
    const classifier = registry(serverFirst("calendar", "calendar_book"));
    await semanticSearch(bigCatalog(), "plan my week", undefined, undefined, classifier);

    const first = classifier.calls[0]!.context;
    expect(first.state).toEqual({
      query: "plan my week",
      servers: [
        { id: "s0", name: "notes", tools: Array.from({ length: 10 }, (_, index) => `tool_${index}`) },
        { id: "s1", name: "mail", tools: Array.from({ length: 10 }, (_, index) => `tool_${index}`) },
        { id: "s2", name: "calendar", tools: ["book", "list"] },
      ],
    });
    expect(first.questions.server!.criteria).toEqual({ s0: "The notes server", s1: "The mail server", s2: "The calendar server", none: "No listed server fits" });
  });

  it("makes one call when the catalog fits or one server is asked for", async () => {
    const fits = bigCatalog();
    fits.config.settings!.semanticSearch = { allowedServers: ["notes", "mail", "calendar"] };
    const classifier = registry(choose("calendar_book"));
    await semanticSearch(fits, "plan my week", undefined, undefined, classifier);
    await semanticSearch(bigCatalog(), "plan my week", "notes", undefined, classifier);

    expect(classifier.calls).toHaveLength(2);
    expect(classifier.calls.every(call => call.context.questions.match !== undefined)).toBe(true);
  });

  it("treats a failed first call like a failed ranking", async () => {
    const timedOut = await semanticSearch(bigCatalog(), "plan my week", undefined, undefined, registry(failWith("Request timed out after 5000ms")));
    expect(timedOut).toMatchObject({ ok: true, backend: { used: "lexical", degraded: true, reason: "timeout" } });
    expect(timedOut.ok && timedOut.matches.every(match => ["notes", "mail", "calendar"].includes(match.server))).toBe(true);

    const rejected = registry(failWith("System One API error (401): secret"));
    const denied = await semanticSearch(bigCatalog(), "plan my week", undefined, undefined, rejected);
    expect(denied).toEqual({ ok: false, error: { code: "authentication_failed", message: "typesafe rejected the credential." } });
    expect(rejected.classify).toHaveBeenCalledOnce();
  });

  it("still reports the first call's usage when the ranking call falls back", async () => {
    const pickServer = serverFirst("calendar", "calendar_book");
    const timeOut = failWith("Request timed out after 5000ms");
    const result = await semanticSearch(bigCatalog(), "plan my week", undefined, undefined,
      registry(context => context.questions.server ? pickServer(context) : timeOut(context)));

    expect(result).toMatchObject({ ok: true, backend: { used: "lexical", reason: "timeout", usage: { input: 12, output: 3, cost: 0.0001 } } });
  });
});
