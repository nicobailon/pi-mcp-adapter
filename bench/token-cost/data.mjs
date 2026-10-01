// Deterministic fixture data and ground truth for bench/token-cost/run.mjs.
let seed = 42;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
const API = "https://api.github.com/repos/acme/widget";

const logins = ["mkowalski", "priya-r", "dchen", "sofia-m", "tbaker", "ahmed-k", "lena-v", "jbrooks", "yuki-t", "omar-f", "grace-h", "ravi-p"];
const user = (login) => ({
  login, id: 10000 + logins.indexOf(login) * 7919, node_id: `MDQ6VXNlcj${logins.indexOf(login)}`,
  avatar_url: `https://avatars.githubusercontent.com/u/${10000 + logins.indexOf(login) * 7919}?v=4`, gravatar_id: "",
  url: `https://api.github.com/users/${login}`, html_url: `https://github.com/${login}`,
  followers_url: `https://api.github.com/users/${login}/followers`, following_url: `https://api.github.com/users/${login}/following{/other_user}`,
  gists_url: `https://api.github.com/users/${login}/gists{/gist_id}`, starred_url: `https://api.github.com/users/${login}/starred{/owner}{/repo}`,
  subscriptions_url: `https://api.github.com/users/${login}/subscriptions`, organizations_url: `https://api.github.com/users/${login}/orgs`,
  repos_url: `https://api.github.com/users/${login}/repos`, events_url: `https://api.github.com/users/${login}/events{/privacy}`,
  received_events_url: `https://api.github.com/users/${login}/received_events`, type: "User", site_admin: false,
});

const labelDefs = [
  ["bug", "d73a4a", "Something isn't working"], ["enhancement", "a2eeef", "New feature or request"],
  ["docs", "0075ca", "Improvements or additions to documentation"], ["stale", "ededed", "No activity for a long time"],
  ["question", "d876e3", "Further information is requested"], ["p1", "b60205", "High priority"], ["good first issue", "7057ff", "Good for newcomers"],
];
const labels = labelDefs.map(([name, color, description], i) => ({ id: 5000000 + i, node_id: `LA_kwDOB${i}`, url: `${API}/labels/${encodeURIComponent(name)}`, name, color, default: i < 3, description }));
const label = (name) => labels.find((l) => l.name === name);

const areas = ["the sync worker", "the CLI", "webhook delivery", "the settings page", "OAuth refresh", "CSV export", "the search index", "rate limiting", "the billing job", "dark mode"];
const verbs = ["crashes", "hangs", "returns 500", "drops events", "leaks memory", "shows stale data", "times out", "double-counts rows"];
const conds = ["after upgrading to 4.2", "on Windows", "with large workspaces", "when the token expires", "under load", "behind a proxy", "on first launch", "with unicode filenames"];
const sentences = [
  "Steps to reproduce are in the attached log; it happens roughly one in five runs.",
  "I bisected this to the change that moved retries into the shared client.",
  "Expected the operation to finish in under two seconds, but it takes over a minute.",
  "This blocks our nightly import, so we are pinned to the previous release for now.",
  "The stack trace points at the connection pool, but the pool metrics look normal.",
  "Happy to test a patch if someone can point me at the right module.",
  "Workaround: restarting the worker clears it until the next deploy.",
  "Seen on both staging and production; the staging repro is more reliable.",
  "Related discussion is in the forum thread from last month, no resolution there.",
  "Logs are attached below with tokens redacted.",
];
const body = () => Array.from({ length: int(3, 6) }, () => pick(sentences)).join(" ") + "\n\n```\n" + `Error: ${pick(verbs)} in ${pick(areas)} (code E${int(100, 999)})\n    at run (worker.js:${int(10, 400)}:${int(2, 60)})` + "\n```";

const day = (from, to) => { const a = Date.parse(from), b = Date.parse(to); return new Date(a + Math.floor(rand() * (b - a))).toISOString().replace(/\.\d+Z$/, "Z"); };

const issues = [];
for (let n = 1; n <= 150; n++) {
  const state = rand() < 0.28 ? "closed" : "open";
  const names = new Set();
  if (rand() < 0.38) names.add("bug");
  if (rand() < 0.25) names.add("enhancement");
  if (rand() < 0.12) names.add("docs");
  if (rand() < 0.1) names.add("question");
  if (rand() < 0.1) names.add("p1");
  if (rand() < 0.2) names.add("stale");
  if (names.size === 0) names.add(pick(["enhancement", "question", "good first issue"]));
  const created = day("2025-11-01T00:00:00Z", "2026-05-01T00:00:00Z");
  const updated = day("2026-05-02T00:00:00Z", "2026-09-25T00:00:00Z");
  const author = pick(logins);
  const assignee = rand() < 0.4 ? user(pick(logins)) : null;
  issues.push({
    url: `${API}/issues/${n}`, repository_url: API, labels_url: `${API}/issues/${n}/labels{/name}`, comments_url: `${API}/issues/${n}/comments`,
    events_url: `${API}/issues/${n}/events`, html_url: `https://github.com/acme/widget/issues/${n}`, id: 2100000000 + n * 37, node_id: `I_kwDOBx${(n * 7919).toString(36)}`,
    number: n, title: `${pick(areas)} ${pick(verbs)} ${pick(conds)}`.replace(/^(.)/, (c) => c.toUpperCase()),
    user: user(author), labels: [...names].map(label), state, locked: false, assignee, assignees: assignee ? [assignee] : [], milestone: null,
    comments: int(0, 14), created_at: created, updated_at: updated, closed_at: state === "closed" ? updated : null, author_association: pick(["CONTRIBUTOR", "MEMBER", "NONE"]),
    active_lock_reason: null, body: body(),
    reactions: { url: `${API}/issues/${n}/reactions`, total_count: 0, "+1": int(0, 6), "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: int(0, 2) },
    timeline_url: `${API}/issues/${n}/timeline`, performed_via_github_app: null, state_reason: state === "closed" ? "completed" : null,
  });
}
const openBugs = issues.filter((i) => i.state === "open" && i.labels.some((l) => l.name === "bug"));
const pulls = [];
for (let n = 151; n <= 220; n++) {
  const r = rand();
  const state = r < 0.35 ? "open" : "closed";
  const merged = state === "closed" && rand() < 0.7;
  const target = rand() < 0.6 ? pick(openBugs).number : int(1, 150);
  const refStyle = pick(["Fixes", "Closes", "fixes", "Related to", "Follow-up to", "See"]);
  const refLine = rand() < 0.85 ? `${refStyle} #${target}` : "No linked issue.";
  const author = pick(logins);
  const created = day("2026-03-01T00:00:00Z", "2026-09-20T00:00:00Z");
  const sha = (n * 2654435761 >>> 0).toString(16).padStart(8, "0").repeat(5);
  pulls.push({
    url: `${API}/pulls/${n}`, id: 3200000000 + n * 41, node_id: `PR_kwDOBx${(n * 104729).toString(36)}`, html_url: `https://github.com/acme/widget/pull/${n}`,
    diff_url: `https://github.com/acme/widget/pull/${n}.diff`, patch_url: `https://github.com/acme/widget/pull/${n}.patch`, issue_url: `${API}/issues/${n}`,
    number: n, state, locked: false, title: `${pick(["Fix", "Handle", "Guard against", "Refactor", "Improve"])} ${pick(areas)} ${pick(["timeouts", "retries", "error paths", "logging", "edge cases"])}`,
    user: user(author), body: `## Summary\n${pick(sentences)} ${pick(sentences)}\n\n${refLine}\n\n## Testing\n- [x] unit tests\n- [${rand() < 0.5 ? "x" : " "}] manual check on staging`,
    created_at: created, updated_at: created, closed_at: state === "closed" ? created : null, merged_at: merged ? created : null, merge_commit_sha: sha.slice(0, 40),
    assignee: null, assignees: [], requested_reviewers: [user(pick(logins))], labels: [], milestone: null, draft: rand() < 0.1,
    head: { label: `${author}:fix-${n}`, ref: `fix-${n}`, sha: sha.slice(0, 40) }, base: { label: "acme:main", ref: "main", sha: sha.slice(0, 40).split("").reverse().join("") },
    author_association: "CONTRIBUTOR", auto_merge: null, active_lock_reason: null, merged,
  });
}

const linked = new Set();
for (const p of pulls) {
  if (p.state === "closed" && !p.merged) continue;
  for (const m of p.body.matchAll(/\b(?:fixes|closes)\s+#(\d+)\b/gi)) linked.add(Number(m[1]));
}
const orphanBugs = openBugs.filter((i) => i.updated_at < "2026-08-01" && !linked.has(i.number)).map((i) => i.number).sort((a, b) => a - b);
const staleOpen = issues.filter((i) => i.state === "open" && i.labels.some((l) => l.name === "stale")).map((i) => i.number).sort((a, b) => a - b);

const docSections = [
  ["Webhooks: delivery and retries", "Each webhook delivery is attempted immediately after the event is committed. If your endpoint returns a non-2xx status or does not respond within 10 seconds, the delivery is marked failed and retried with exponential backoff (30s, 2m, 10m, 1h, 6h).\n\nBy default a failed delivery is retried up to **5** times before it is moved to the dead-letter view. You can change this limit with the `webhooks.retry.maxAttempts` setting in `acme.config.yaml` (allowed range 0–20). Setting it to 0 disables retries.\n\n> Note: the legacy `webhook_retry_count` environment variable was removed in v4 and is ignored."],
  ["Webhooks: signing secrets", "Every delivery includes an `X-Acme-Signature` header, an HMAC-SHA256 of the raw body using your endpoint secret. Rotate secrets from the dashboard; both old and new secrets are valid for 24 hours after rotation."],
  ["API client: retries", "The official SDKs retry idempotent requests up to **3** times on 429 and 5xx responses. Configure this with `client.retries`. Non-idempotent requests are never retried automatically."],
  ["Background jobs", "Jobs that throw are retried up to **10** times (`jobs.maxAttempts`). After the final attempt the job is archived and an alert is raised if `jobs.alertOnFailure` is true."],
  ["Rate limits", "Each workspace may send 600 requests per minute. Bursts above that return 429 with a `Retry-After` header. Webhook deliveries do not count against this limit."],
  ["Configuration file", "Settings are read from `acme.config.yaml` at startup. Environment variables prefixed with `ACME_` override file values, using `__` as the path separator (for example `ACME_WEBHOOKS__RETRY__MAXATTEMPTS`)."],
  ["Audit log", "Administrative actions are recorded for 400 days. Export the log as CSV or stream it to your SIEM via the audit webhook, which uses the same retry policy as other webhooks."],
  ["SSO", "SAML and OIDC are supported on the Business plan. Just-in-time provisioning creates users on first login; SCIM keeps groups in sync."],
];
const docs = (query) => {
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);
  const scored = docSections.map(([title, text]) => ({ title, text, score: words.filter((w) => (title + " " + text).toLowerCase().includes(w)).length }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => `## ${s.title}\n\n${s.text}\n`).join("\n") + "\n---\nSource: docs.acme.dev (retrieved 2026-09-29)";
};

const speakers = ["Priya", "Dan", "Sofia", "Tom", "Ahmed", "Lena"];
const lines = [
  "Quick update on the sync worker — the retry change is merged and deployed to staging.",
  "I’m still seeing the “stale data” report from two customers; I think it’s the cache TTL.",
  "Can we get the CSV export fix into Thursday’s release? It’s blocking the finance team.",
  "OAuth refresh is fine now, but we should add an alert for refresh failures > 1%.",
  "I paired with Dan on the search index; reindexing takes ~40 min on the big workspace.",
  "Nothing blocking from me. I’ll pick up the dark-mode contrast issues next.",
  "Heads-up: the billing job double-counted rows for three accounts on 9/26; refunds are queued.",
  "Let’s timebox the proxy investigation to Wednesday, then decide whether to ship the workaround.",
  "The on-call rotation doc is updated; please check your shifts for October.",
  "I’ll write up the incident review by Friday and share it in #eng-reviews.",
];
const transcripts = [
  { id: "standup-2026-09-28", title: "Eng standup", date: "2026-09-28" },
  { id: "standup-2026-09-27", title: "Eng standup", date: "2026-09-27" },
  { id: "planning-2026-09-25", title: "Sprint planning", date: "2026-09-25" },
].map((t, k) => {
  const out = [`Transcript: ${t.title} — ${t.date}`, `Attendees: ${speakers.join(", ")}`, ""];
  let sec = 12 + k;
  for (let i = 0; i < 150; i++) {
    sec += int(8, 40);
    const ts = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
    out.push(`[${ts}] ${pick(speakers)}: ${pick(lines)}`);
  }
  out.push("", "— end of transcript —");
  return { ...t, text: out.join("\n") };
});

export const data = { issues, pulls, labels, docs, transcripts };
export const truth = { orphanBugs, staleOpen, issue42Title: issues[41].title, transcript: transcripts[0].text };
