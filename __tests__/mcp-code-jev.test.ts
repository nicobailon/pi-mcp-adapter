import { describe, expect, it, vi } from "vitest";
import { runMcpScript, type McpScriptJevEvaluator } from "../mcp-code.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import type { McpExtensionState } from "../state.ts";
import type { JevEvaluateInput, JevEvaluationEnvelope } from "../jev-contracts.ts";

function makeState(jev: Record<string, unknown> | false = { scriptEvaluation: true }): McpExtensionState {
  return {
    owner: createMcpRuntimeOwner(),
    config: { settings: { jev }, mcpServers: { allowed: { command: "unused" }, blocked: { command: "unused" } } },
    toolMetadata: new Map(),
    failureTracker: new Map(),
    completedUiSessions: [],
  } as unknown as McpExtensionState;
}

function text(result: Awaited<ReturnType<typeof runMcpScript>>): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).at(-1)!;
}

const input: JevEvaluateInput = {
  state: { issue: "redacted-state" },
  questions: {
    route: { type: "choice", criteria: { fix: "Fix", close: "Close" } },
    severity: { type: "score", criteria: ["low", "high"] },
    relevant: { type: "noul" },
  },
};

const success: JevEvaluationEnvelope = {
  ok: true,
  data: {
    answers: {
      route: { type: "choice", choice: "fix", confidence: 0.9, probabilities: { fix: 0.9, close: 0.1 } },
      severity: { type: "score", score: 1, confidence: 0.8, probabilities: { "0": 0.2, "1": 0.8 } },
      relevant: { type: "noul", noul: 0.75 },
    },
    model: "jev-1.13.0",
    usage: { inputTokens: 12, outputTokens: 7 },
  },
};

function evaluatorReturning(envelope: JevEvaluationEnvelope): McpScriptJevEvaluator {
  return vi.fn(async () => envelope);
}

describe("mcpScript jev.evaluate", () => {
  it("returns typed Choice, Score, and Noul answers through the host evaluator", async () => {
    const evaluator = evaluatorReturning(success);
    const result = await runMcpScript(makeState(), `return await jev.evaluate(${JSON.stringify(input)});`, 2_000, undefined, undefined, evaluator);

    expect(JSON.parse(text(result))).toEqual(success);
    expect(evaluator).toHaveBeenCalledWith(expect.anything(), input, expect.objectContaining({ purpose: "script", signal: expect.any(AbortSignal) }));
    expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: true, model: "jev-1.13.0", inputTokens: 12, outputTokens: 7, durationMs: expect.any(Number) }] });
    expect(JSON.stringify(result.details)).not.toMatch(/redacted-state|route|fix|confidence|probabilities/);
  });

  it("exposes only a frozen host RPC without process, env, SDK, credentials, or fetch", async () => {
    const evaluator = evaluatorReturning(success);
    const result = await runMcpScript(makeState(), `return {
      frozen: Object.isFrozen(jev), keys: Object.keys(jev),
      globals: [typeof process, typeof require, typeof fetch, typeof TypeSafeClient],
      leaks: [jev.apiKey, jev.endpoint, jev.headers, jev.env, jev.client, jev.sdk].map(value => value ?? null)
    };`, 2_000, undefined, undefined, evaluator);

    expect(JSON.parse(text(result))).toEqual({
      frozen: true,
      keys: ["evaluate"],
      globals: ["undefined", "undefined", "undefined", "undefined"],
      leaks: [null, null, null, null, null, null],
    });
    expect(evaluator).not.toHaveBeenCalled();
  });

  it("enforces the attempt budget before dispatch and lets the script continue", async () => {
    const evaluator = evaluatorReturning(success);
    const state = makeState({ scriptEvaluation: true, maxEvaluationsPerScript: 1 });
    const result = await runMcpScript(state, `
      const first = await jev.evaluate(${JSON.stringify(input)});
      const second = await jev.evaluate(${JSON.stringify(input)});
      return { first: first.ok, second, continued: true };
    `, 2_000, undefined, undefined, evaluator);

    expect(JSON.parse(text(result))).toMatchObject({ first: true, continued: true, second: { ok: false, error: { code: "budget_exhausted" } } });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: true }, { operation: "evaluate", ok: false, error: "budget_exhausted" }] });
  });

  it("enforces cumulative UTF-8 input bytes before provider work", async () => {
    let providerCalls = 0;
    const evaluator: McpScriptJevEvaluator = vi.fn(async () => {
      providerCalls += 1;
      return success;
    });
    const one = { state: "😀", questions: { q: { type: "noul" } } };
    const bytes = Buffer.byteLength(JSON.stringify(one), "utf8");
    const state = makeState({ scriptEvaluation: true, maxEvaluationBytesPerScript: bytes * 2 - 1 });
    const result = await runMcpScript(state, `return [await jev.evaluate(${JSON.stringify(one)}), await jev.evaluate(${JSON.stringify(one)})];`, 2_000, undefined, undefined, evaluator);

    expect(JSON.parse(text(result))).toMatchObject([{ ok: true }, { ok: false, error: { code: "budget_exhausted" } }]);
    expect(providerCalls).toBe(1);
  });

  it("enforces cumulative provider-reported tokens at exact and overshoot boundaries", async () => {
    const exactEvaluator = evaluatorReturning(success);
    const exact = await runMcpScript(
      makeState({ scriptEvaluation: true, maxEvaluationTokensPerScript: 19 }),
      `return [await jev.evaluate(${JSON.stringify(input)}), await jev.evaluate(${JSON.stringify(input)})];`,
      2_000, undefined, undefined, exactEvaluator,
    );
    expect(JSON.parse(text(exact))).toMatchObject([{ ok: true }, { ok: false, error: { code: "budget_exhausted" } }]);
    expect(exactEvaluator).toHaveBeenCalledTimes(1);

    const overshootEvaluator = evaluatorReturning(success);
    const overshoot = await runMcpScript(
      makeState({ scriptEvaluation: true, maxEvaluationTokensPerScript: 18 }),
      `return [await jev.evaluate(${JSON.stringify(input)}), await jev.evaluate(${JSON.stringify(input)})];`,
      2_000, undefined, undefined, overshootEvaluator,
    );
    const results = JSON.parse(text(overshoot));
    expect(results).toMatchObject([{ ok: false, error: { code: "budget_exhausted" } }, { ok: false, error: { code: "budget_exhausted" } }]);
    expect(JSON.stringify(results)).not.toContain("answers");
    expect(overshootEvaluator).toHaveBeenCalledTimes(1);
  });

  it("charges evaluation responses to the shared 16 MiB transfer budget", async () => {
    const oversized = { ok: true, data: { ...success.data, padding: "x".repeat(16 * 1024 * 1024) } } as unknown as JevEvaluationEnvelope;
    const result = await runMcpScript(makeState(), `const value = await jev.evaluate(${JSON.stringify(input)}); return value.ok ? "unexpected" : value.error.code;`, 4_000, undefined, undefined, evaluatorReturning(oversized));

    expect(text(result)).toBe("budget_exhausted");
    expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: false, error: "budget_exhausted" }] });
  });

  it("returns source policy denial from the A-owned evaluator without provider access", async () => {
    const state = makeState({ scriptEvaluation: true, allowedServers: ["allowed"] });
    const denied = { ...input, sources: ["blocked"] };
    const result = await runMcpScript(state, `return await jev.evaluate(${JSON.stringify(denied)});`);

    expect(JSON.parse(text(result))).toMatchObject({ ok: false, error: { code: "data_policy_denied" } });
    expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: false, error: "data_policy_denied" }] });
  });

  it.each(["authentication_failed", "timeout", "invalid_response"] as const)(
    "forwards actionable %s failures without secret trace data",
    async code => {
      const evaluator = evaluatorReturning({ ok: false, error: { code, message: `actionable ${code}`, retryable: code === "timeout" } });
      const result = await runMcpScript(makeState(), `return await jev.evaluate(${JSON.stringify(input)});`, 2_000, undefined, undefined, evaluator);

      expect(JSON.parse(text(result))).toMatchObject({ ok: false, error: { code, message: `actionable ${code}` } });
      expect(result.details).toMatchObject({ calls: [{ operation: "evaluate", ok: false, error: code, durationMs: expect.any(Number) }] });
      expect(JSON.stringify(result.details)).not.toContain("redacted-state");
    },
  );

  it("aborts pending evaluation on timeout and records a nonsecret incomplete trace", async () => {
    const evaluator: McpScriptJevEvaluator = vi.fn((_state, _value, options) => new Promise(resolve => {
      options.signal?.addEventListener("abort", () => resolve({ ok: false, error: { code: "aborted", message: "aborted" } }), { once: true });
    }));
    const result = await runMcpScript(makeState(), `await jev.evaluate(${JSON.stringify(input)});`, 150, undefined, undefined, evaluator);

    expect(result.details).toMatchObject({ error: "timeout", calls: [{ operation: "evaluate", ok: false, error: "incomplete" }] });
  });

  it("aborts unawaited evaluation on early return and owner shutdown", async () => {
    const signals: AbortSignal[] = [];
    const evaluator: McpScriptJevEvaluator = vi.fn((_state, _value, options) => {
      signals.push(options.signal!);
      return new Promise(resolve => options.signal?.addEventListener("abort", () => resolve({ ok: false, error: { code: "aborted", message: "aborted" } }), { once: true }));
    });
    const earlyState = makeState();
    const early = await runMcpScript(earlyState, `jev.evaluate(${JSON.stringify(input)}); return "done";`, 2_000, undefined, undefined, evaluator);
    expect(text(early)).toBe("done");
    expect(early.details).toMatchObject({ calls: [{ operation: "evaluate", ok: false, error: "incomplete" }] });
    expect(signals[0]?.aborted).toBe(true);

    const ownerState = makeState();
    const pending = runMcpScript(ownerState, `await jev.evaluate(${JSON.stringify(input)});`, 2_000, undefined, undefined, evaluator);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    await ownerState.owner.stop("shutdown");
    const stopped = await pending;
    expect(stopped.details).toMatchObject({ error: "aborted", calls: [{ operation: "evaluate", ok: false, error: "incomplete" }] });
    expect(text(stopped)).toContain("shutdown");
  });
});
