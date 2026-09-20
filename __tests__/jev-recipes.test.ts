import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Packaged JavaScript example intentionally has no declaration surface.
import { runAccessibilityLoop } from "../examples/jev-accessibility-loop.mjs";
// @ts-expect-error Packaged JavaScript example intentionally has no declaration surface.
import { filterIssuesForTriage } from "../examples/jev-semantic-filter.mjs";

const tree = (observationId: string, nodes = [{ id: "button", actions: ["focus"] }]) => ({
  ok: true,
  data: { structuredContent: { observationId, nodes } },
});
const answer = (choice: string, confidence = 1) => ({
  ok: true,
  data: { model: "fixture", usage: { inputTokens: 1, outputTokens: 1 }, answers: { next: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } } },
});
const options = { observePath: "browser_observe", actionPath: "browser_action", goal: "focus target", allowedOperations: ["focus"], sources: ["browser"], maxSteps: 3, maxMs: 5_000, maxEvaluations: 3 };

describe("bounded accessibility recipe", () => {
  it("requires positive step, time, and evaluation budgets", async () => {
    await expect(runAccessibilityLoop({}, {}, { ...options, maxSteps: 0 })).rejects.toThrow("Positive");
    await expect(runAccessibilityLoop({}, {}, { ...options, sources: [] })).rejects.toThrow("Explicit MCP sources");
    await expect(runAccessibilityLoop({}, {}, { ...options, allowedOperations: ["click"] })).rejects.toThrow("non-destructive");
  });

  it.each([
    ["complete", "complete"],
    ["none", "no-match"],
    ["needsInformation", "needs-information"],
  ])("returns observable terminal choice %s", async (choice, status) => {
    const tools = { call: vi.fn().mockResolvedValue(tree("o1")) };
    const result = await runAccessibilityLoop(tools, { evaluate: vi.fn().mockResolvedValue(answer(choice)) }, options);
    expect(result.status).toBe(status);
    expect(tools.call).toHaveBeenCalledTimes(1);
  });

  it("returns on uncertainty without acting", async () => {
    const tools = { call: vi.fn().mockResolvedValue(tree("o1")) };
    const result = await runAccessibilityLoop(tools, { evaluate: vi.fn().mockResolvedValue(answer("a0", 0.5)) }, options);
    expect(result).toEqual({ status: "stop", reason: "uncertain" });
    expect(tools.call).toHaveBeenCalledTimes(1);
  });

  it.each([
    [tree("o2", [])],
    [tree("o1")],
  ])("returns before acting when the refreshed observation is stale", async fresh => {
    const tools = { call: vi.fn().mockResolvedValueOnce(tree("o1")).mockResolvedValueOnce(fresh) };
    const result = await runAccessibilityLoop(tools, { evaluate: vi.fn().mockResolvedValue(answer("a0")) }, options);
    expect(result).toEqual({ status: "stop", reason: "stale-candidate" });
    expect(tools.call).toHaveBeenCalledTimes(2);
  });

  it("never retries a possibly side-effectful failure", async () => {
    const calls = vi.fn()
      .mockResolvedValueOnce(tree("o1"))
      .mockResolvedValueOnce(tree("o2"))
      .mockResolvedValueOnce({ ok: false, error: { code: "uncertain" } });
    const result = await runAccessibilityLoop({ call: calls }, { evaluate: vi.fn().mockResolvedValue(answer("a0")) }, options);
    expect(result).toEqual({ status: "stop", reason: "action-failed-or-uncertain" });
    expect(calls).toHaveBeenCalledTimes(3);
  });

  it("returns when a later observation makes no progress", async () => {
    const calls = vi.fn()
      .mockResolvedValueOnce(tree("o1"))
      .mockResolvedValueOnce(tree("o2"))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(tree("o3"));
    const result = await runAccessibilityLoop({ call: calls }, { evaluate: vi.fn().mockResolvedValue(answer("a0")) }, options);
    expect(result).toEqual({ status: "stop", reason: "no-progress" });
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it("stops before acting when the time budget expires", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(6_000);
    const calls = vi.fn().mockResolvedValueOnce(tree("o1"));
    const result = await runAccessibilityLoop({ call: calls }, { evaluate: vi.fn().mockResolvedValue(answer("a0")) }, options);
    expect(result).toEqual({ status: "stop", reason: "time-budget" });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("stops when the evaluation budget is exhausted", async () => {
    const changed = tree("o3", [{ id: "second", actions: ["focus"] }]);
    const calls = vi.fn()
      .mockResolvedValueOnce(tree("o1"))
      .mockResolvedValueOnce(tree("o2"))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(changed);
    const evaluate = vi.fn().mockResolvedValue(answer("a0"));
    const result = await runAccessibilityLoop({ call: calls }, { evaluate }, { ...options, maxEvaluations: 1 });
    expect(result).toEqual({ status: "stop", reason: "evaluation-budget" });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("stops at the step budget after one successful action", async () => {
    const calls = vi.fn().mockResolvedValueOnce(tree("o1")).mockResolvedValueOnce(tree("o2")).mockResolvedValueOnce({ ok: true });
    const result = await runAccessibilityLoop({ call: calls }, { evaluate: vi.fn().mockResolvedValue(answer("a0")) }, { ...options, maxSteps: 1 });
    expect(result).toEqual({ status: "stop", reason: "step-budget" });
    expect(calls).toHaveBeenCalledTimes(3);
  });
});

describe("semantic issue filter", () => {
  const tools = () => ({
    search: vi.fn().mockResolvedValue({ items: [{ path: "github_list" }] }),
    call: vi.fn().mockResolvedValue({ ok: true, data: { structuredContent: { issues: [{ title: "one" }, { title: "two" }] } } }),
  });

  it("evaluates relevance and regression together, then filters in JavaScript", async () => {
    const evaluate = vi.fn(async input => {
      expect(Object.keys(input.questions)).toEqual(["relevant_issue0", "regression_issue0", "relevant_issue1", "regression_issue1"]);
      return { ok: true, data: { answers: {
        relevant_issue0: { type: "noul", noul: 0.9 }, regression_issue0: { type: "noul", noul: 0.8 },
        relevant_issue1: { type: "noul", noul: 0.9 }, regression_issue1: { type: "noul", noul: 0.2 },
      } } };
    });
    const result = await filterIssuesForTriage(tools(), { evaluate });
    expect(result).toMatchObject({ status: "matched", issues: [{ id: "issue0", title: "one" }] });
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("abstains on low signals and forwards evaluation errors", async () => {
    const low = { ok: true, data: { answers: {
      relevant_issue0: { type: "noul", noul: 0.2 }, regression_issue0: { type: "noul", noul: 0.9 },
      relevant_issue1: { type: "noul", noul: 0.1 }, regression_issue1: { type: "noul", noul: 0.1 },
    } } };
    await expect(filterIssuesForTriage(tools(), { evaluate: vi.fn().mockResolvedValue(low) })).resolves.toEqual({ status: "no-match" });
    await expect(filterIssuesForTriage(tools(), { evaluate: vi.fn().mockResolvedValue({ ok: false, error: { code: "timeout" } }) })).resolves.toEqual({ status: "stop", error: { code: "timeout" } });
  });
});
