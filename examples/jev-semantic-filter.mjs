export async function selectIssueForTriage(tools, jev) {
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
  const evaluation = await jev.evaluate({
    state: { candidates },
    sources: ["github"],
    questions: {
      triage: {
        type: "choice",
        instructions: "Choose one clearly actionable urgent issue, or none when evidence is insufficient.",
        criteria: Object.fromEntries([...candidates.map(issue => [issue.id, issue.title]), ["none", "No clear match"]]),
      },
    },
  });
  if (!evaluation.ok) return { status: "stop", error: evaluation.error };
  const answer = evaluation.data.answers.triage;
  if (answer.type !== "choice" || answer.choice === "none" || answer.confidence < 0.8) {
    return { status: "needs-information" };
  }
  return { status: "matched", issue: candidates.find(issue => issue.id === answer.choice) ?? null };
}
