import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import type { McpExtensionState } from "../state.ts";
import { evaluateJev, resolveSemanticJevSettings, validateJevEvaluateInput, validateJevSettings } from "../jev-client.ts";
import { getTestSecureKeyringReadCount, resetTestSecureKeyring } from "../secure-keyring.ts";
import { saveJevApiKey } from "../jev-key-store.ts";

function state(jev: Record<string, unknown>): McpExtensionState {
  return { owner: createMcpRuntimeOwner(), config: { mcpServers: { allowed: { command: "x" } }, settings: { jev } } } as unknown as McpExtensionState;
}
const input = {
  state: { text: "safe fixture" },
  questions: { route: { type: "choice" as const, criteria: { yes: "yes", no: "no" } } },
  sources: ["allowed"],
};

describe("Jev host client", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    process.env.TYPESAFE_API_KEY = "fixture-key";
    delete process.env.TYPESAFE_BASE_URL;
    delete process.env.TYPESAFE_DEFAULT_MODEL;
    delete process.env.TYPESAFE_LOG_LEVEL;
    resetTestSecureKeyring();
    vi.restoreAllMocks();
  });

  it("is inert while disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await evaluateJev(state({ allowedServers: ["allowed"] }), input, { purpose: "script" });
    expect(result).toMatchObject({ ok: false, error: { code: "disabled" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getTestSecureKeyringReadCount()).toBe(0);
  });

  it("enables semantic search for every enabled server when a credential is available", () => {
    const runtime = state({});
    runtime.config.mcpServers.disabled = { command: "x", disabled: true };
    const present = vi.fn(() => ({ status: "present" as const, source: "keyring" as const, apiKey: "fixture-key" }));
    expect(resolveSemanticJevSettings(runtime, present)).toMatchObject({
      semanticSearch: true,
      scriptEvaluation: false,
      allowedServers: ["allowed"],
    });

    runtime.config.settings!.jev = { semanticSearch: false };
    const disabled = resolveSemanticJevSettings(runtime, present);
    expect(disabled.semanticSearch).toBe(false);
    expect(present).toHaveBeenCalledOnce();

    runtime.config.settings!.jev = {};
    expect(resolveSemanticJevSettings(runtime, () => ({ status: "missing" }))).toMatchObject({
      semanticSearch: false,
      allowedServers: ["allowed"],
    });

    delete process.env.TYPESAFE_API_KEY;
    saveJevApiKey("stored-key");
    expect(resolveSemanticJevSettings(runtime).semanticSearch).toBe(true);
  });

  it("reuses a keyring credential throughout semantic evaluation", async () => {
    delete process.env.TYPESAFE_API_KEY;
    saveJevApiKey("stored-key");
    const runtime = state({});
    expect(resolveSemanticJevSettings(runtime).semanticSearch).toBe(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: { route: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    expect(await evaluateJev(runtime, input, { purpose: "semantic-search" })).toMatchObject({ ok: true });
    expect(getTestSecureKeyringReadCount()).toBe(1);
  });

  it("uses the fixed HTTPS origin, rejects redirects, and validates a response", async () => {
    process.env.TYPESAFE_BASE_URL = "https://evil.test";
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-latest";
    process.env.TYPESAFE_LOG_LEVEL = "debug";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      expect(new URL(String(request)).origin).toBe("https://api.typesafe.ai");
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({
        model: "jev-1.13.0",
        answers: { route: { type: "choice", choice: "yes", confidence: 0.8, probabilities: { yes: 0.8, no: 0.2 } } },
        usage: { input_tokens: 10, output_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await evaluateJev(state({ scriptEvaluation: true, allowedServers: ["allowed"] }), input, { purpose: "script" });
    expect(result).toEqual({ ok: true, data: { model: "jev-1.13.0", answers: { route: { type: "choice", choice: "yes", confidence: 0.8, probabilities: { yes: 0.8, no: 0.2 } }, }, usage: { inputTokens: 10, outputTokens: 2 } } });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rejects malformed responses without leaking their body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ model: "x", answers: {}, usage: { input_tokens: 1, output_tokens: 1 }, secret: "provider body" }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await evaluateJev(state({ scriptEvaluation: true, allowedServers: ["allowed"] }), input, { purpose: "script" });
    expect(result).toEqual({ ok: false, error: { code: "invalid_response", message: "TypeSafe returned an invalid response." } });
    expect(JSON.stringify(result)).not.toContain("provider body");
  });

  it("fails closed for malformed answer kinds, model, and usage", async () => {
    const fixtures = [
      { request: input, response: { model: "jev-1.13.0", answers: { route: { type: "choice", choice: "yes", confidence: 2, probabilities: { yes: 0.8, no: 0.2 } } }, usage: { input_tokens: 1, output_tokens: 1 } } },
      { request: { state: null, questions: { route: { type: "score" as const, criteria: ["low", "high"] as [string, string] } }, sources: ["allowed"] }, response: { model: "jev-1.13.0", answers: { route: { type: "score", score: 2, confidence: 1, probabilities: { 0: 0, 1: 1 }, legend: {} } }, usage: { input_tokens: 1, output_tokens: 1 } } },
      { request: { state: null, questions: { route: { type: "noul" as const } }, sources: ["allowed"] }, response: { model: "jev-1.13.0", answers: { route: { type: "noul", noul: 0.5, confidence: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } } },
      { request: input, response: { model: "", answers: { route: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } } }, usage: { input_tokens: 1, output_tokens: 1 } } },
      { request: input, response: { model: "jev-1.13.0", answers: { route: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1, no: 0 } } }, usage: { input_tokens: 1.5, output_tokens: 1 } } },
    ];
    for (const fixture of fixtures) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(fixture.response), { status: 200, headers: { "content-type": "application/json" } }));
      expect(await evaluateJev(state({ scriptEvaluation: true, allowedServers: ["allowed"] }), fixture.request, { purpose: "script" })).toMatchObject({ ok: false, error: { code: "invalid_response" } });
    }
  });

  it("enforces settings, JSON, question, source, and byte limits", async () => {
    expect(() => validateJevSettings({ model: "jev-latest" })).toThrow("pinned");
    expect(validateJevSettings(undefined).semanticCandidateLimit).toBe(127);
    expect(validateJevSettings(undefined).maxEvaluationTokensPerScript).toBe(32_768);
    expect(validateJevSettings({ maxEvaluationTokensPerScript: 1 }).maxEvaluationTokensPerScript).toBe(1);
    expect(() => validateJevSettings({ maxEvaluationTokensPerScript: 0 })).toThrow("1 to 1000000");
    expect(() => validateJevSettings({ maxEvaluationTokensPerScript: 1_000_001 })).toThrow("1 to 1000000");
    expect(validateJevSettings({ semanticCandidateLimit: 127 }).semanticCandidateLimit).toBe(127);
    expect(() => validateJevSettings({ semanticCandidateLimit: 128 })).toThrow("2 to 127");
    expect(validateJevEvaluateInput({ ...input, sources: ["x".repeat(129)] }, validateJevSettings(undefined)).sources).toEqual(["x".repeat(129)]);
    const limits = validateJevSettings({ maxStateBytes: 4 });
    expect(() => validateJevEvaluateInput(input, limits)).toThrow("maxStateBytes");
    const denied = await evaluateJev(state({ scriptEvaluation: true, allowedServers: [] }), input, { purpose: "script" });
    expect(denied).toMatchObject({ ok: false, error: { code: "data_policy_denied" } });
    expect(() => validateJevEvaluateInput({ ...input, state: { nested: new Date() } }, validateJevSettings(undefined))).toThrow("non-plain object");
  });

  it("classifies HTTP request timeouts as retryable timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("timed out", { status: 408 }));
    const result = await evaluateJev(state({ scriptEvaluation: true, allowedServers: ["allowed"] }), input, { purpose: "script" });
    expect(result).toEqual({ ok: false, error: { code: "timeout", message: "TypeSafe evaluation timed out.", retryable: true } });
  });

  it("honors abort and a total deadline", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_request, init) => new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
      else init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const aborted = new AbortController();
    aborted.abort();
    expect(await evaluateJev(state({ scriptEvaluation: true, allowedServers: ["allowed"] }), input, { purpose: "script", signal: aborted.signal })).toMatchObject({ ok: false, error: { code: "aborted" } });
    const timeoutResult = await evaluateJev(state({ scriptEvaluation: true, allowedServers: ["allowed"], requestTimeoutMs: 100, maxRetries: 2 }), input, { purpose: "script" });
    expect(timeoutResult).toMatchObject({ ok: false, error: { code: "timeout" } });
  });
});
