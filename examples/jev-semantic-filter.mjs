export async function filterIssuesForTriage(tools, jev) {
  const found = await tools.search({
    query: "list open customer issue reports",
    server: "github",
    searchMode: "semantic",
    limit: 5,
  });
  const tool = found.items?.[0];
  if (!tool) return { status: "no-match" };

  const listed = await tools.call(tool.path, { state: "open", limit: 20 });
  if (!listed.ok) return { status: "stop", error: listed.error };
  const issues = listed.data?.structuredContent?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return { status: "no-match" };

  const candidates = issues.slice(0, 20).map((issue, index) => ({
    id: `issue${index}`,
    title: String(issue.title ?? ""),
    body: String(issue.body ?? "").slice(0, 2000),
  }));
  const questions = Object.fromEntries(candidates.flatMap(issue => [
    [`relevant_${issue.id}`, { type: "noul", instructions: "Is this issue actionable and relevant?", criteria: { true: "Relevant", false: "Not relevant" } }],
    [`regression_${issue.id}`, { type: "noul", instructions: "Does this issue contain evidence of a regression?", criteria: { true: "Regression", false: "No regression evidence" } }],
  ]));
  const evaluation = await jev.evaluate({ state: { candidates }, questions, sources: ["github"] });
  if (!evaluation.ok) return { status: "stop", error: evaluation.error };

  const useful = candidates.filter(issue => {
    const relevant = evaluation.data.answers[`relevant_${issue.id}`];
    const regression = evaluation.data.answers[`regression_${issue.id}`];
    return relevant?.type === "noul" && regression?.type === "noul" && relevant.noul >= 0.8 && regression.noul >= 0.7;
  });
  return useful.length > 0 ? { status: "matched", issues: useful } : { status: "no-match" };
}
