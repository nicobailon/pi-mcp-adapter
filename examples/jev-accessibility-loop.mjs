const SAFE_OPERATIONS = new Set(["focus", "scroll"]);

export async function runAccessibilityLoop(tools, jev, options) {
  const { observePath, actionPath, goal, allowedOperations, sources, maxSteps, maxMs, maxEvaluations } = options;
  if (typeof observePath !== "string" || !observePath || typeof actionPath !== "string" || !actionPath || typeof goal !== "string" || !goal
    || !Array.isArray(allowedOperations) || allowedOperations.length === 0 || allowedOperations.some(operation => !SAFE_OPERATIONS.has(operation))) {
    throw new Error("Exact tool paths, a goal, and non-destructive focus/scroll operations are required");
  }
  if (![maxSteps, maxMs, maxEvaluations].every(value => Number.isInteger(value) && value > 0)) {
    throw new Error("Positive step, time, and evaluation budgets are required");
  }
  if (!Array.isArray(sources) || sources.length === 0 || sources.some(source => typeof source !== "string" || !source)) {
    throw new Error("Explicit MCP sources are required for accessibility data");
  }
  const startedAt = Date.now();
  let evaluations = 0;
  let previousFingerprint;

  const observe = async () => {
    const result = await tools.call(observePath, {});
    if (!result.ok) return { error: "observation-failed" };
    const tree = result.data?.structuredContent;
    if (!tree || typeof tree.observationId !== "string" || !tree.observationId || !Array.isArray(tree.nodes)) {
      return { error: "needs-information" };
    }
    return { tree };
  };

  for (let step = 0; step < maxSteps; step += 1) {
    if (Date.now() - startedAt >= maxMs) return { status: "stop", reason: "time-budget" };
    const snapshot = await observe();
    if (snapshot.error) return { status: snapshot.error === "needs-information" ? "needs-information" : "stop", reason: snapshot.error };
    const fingerprint = JSON.stringify(snapshot.tree.nodes);
    if (fingerprint === previousFingerprint) return { status: "stop", reason: "no-progress" };
    previousFingerprint = fingerprint;

    const actions = snapshot.tree.nodes.flatMap(node =>
      (node && typeof node.id === "string" && node.id && Array.isArray(node.actions) ? node.actions : [])
        .filter(operation => typeof operation === "string" && allowedOperations.includes(operation))
        .map(operation => ({ target: node.id, operation })),
    ).slice(0, 120).map((action, index) => ({ ...action, label: `a${index}` }));
    if (actions.length === 0) return { status: "no-match" };
    if (evaluations >= maxEvaluations) return { status: "stop", reason: "evaluation-budget" };
    evaluations += 1;
    const evaluation = await jev.evaluate({
      state: { goal, observationId: snapshot.tree.observationId, nodes: snapshot.tree.nodes },
      sources,
      questions: {
        next: {
          type: "choice",
          instructions: "Choose complete only when the observation proves the goal. Otherwise choose one safe action, none, or needsInformation.",
          criteria: Object.fromEntries([
            ...actions.map(action => [action.label, { target: action.target, operation: action.operation }]),
            ["complete", "Goal is observably complete"],
            ["none", "No matching safe action"],
            ["needsInformation", "User information is required"],
          ]),
        },
      },
    });
    if (!evaluation.ok) return { status: "stop", reason: evaluation.error.code };
    const answer = evaluation.data.answers.next;
    if (answer.type !== "choice" || answer.confidence < 0.85) return { status: "stop", reason: "uncertain" };
    if (answer.choice === "complete") return { status: "complete", observationId: snapshot.tree.observationId };
    if (answer.choice === "none") return { status: "no-match" };
    if (answer.choice === "needsInformation") return { status: "needs-information" };
    const selected = actions.find(action => action.label === answer.choice);
    if (!selected) return { status: "stop", reason: "invalid-action" };

    if (Date.now() - startedAt >= maxMs) return { status: "stop", reason: "time-budget" };
    const fresh = await observe();
    if (fresh.error || fresh.tree.observationId === snapshot.tree.observationId) return { status: "stop", reason: "stale-candidate" };
    const target = fresh.tree.nodes.find(node => node.id === selected.target);
    if (!target || !Array.isArray(target.actions) || !target.actions.includes(selected.operation)) {
      return { status: "stop", reason: "stale-candidate" };
    }
    const acted = await tools.call(actionPath, {
      operation: selected.operation,
      target: selected.target,
      observationId: fresh.tree.observationId,
    });
    if (!acted.ok) return { status: "stop", reason: "action-failed-or-uncertain" };
  }
  return { status: "stop", reason: "step-budget" };
}
