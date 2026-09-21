import { createHash } from "node:crypto";
import { areJevSourcesAllowed, evaluateJev, resolveSemanticJevSettings } from "./jev-client.ts";
import type { JevEvaluateInput, JevEvaluationEnvelope } from "./jev-contracts.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";
import { rankToolMatches, type RankedToolMatch } from "./search-ranking.ts";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { isServerDisabled } from "./types.ts";

export type SemanticSearchEvaluator = (
  state: McpExtensionState,
  input: JevEvaluateInput,
  options: { purpose: "semantic-search"; signal?: AbortSignal; observedSources?: readonly string[] },
) => Promise<JevEvaluationEnvelope>;

export type SemanticSearchBackend =
  | { requested: "semantic"; used: "semantic"; degraded: false; model: string; usage: { inputTokens: number; outputTokens: number }; abstained: boolean }
  | { requested: "semantic"; used: "lexical"; degraded: true; reason: "timeout" | "rate_limited" | "service_unavailable" };

export type SemanticSearchResult =
  | { ok: true; matches: RankedToolMatch[]; backend: SemanticSearchBackend }
  | { ok: false; error: { code: string; message: string } };

interface Candidate {
  id: string;
  server: string;
  description: string;
  tool: ToolMetadata;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eligibleMatches(state: McpExtensionState, server: string | undefined, allowed: Set<string>): RankedToolMatch[] {
  const matches: RankedToolMatch[] = [];
  for (const [serverName, metadata] of state.toolMetadata) {
    if ((server && serverName !== server) || !allowed.has(serverName)
      || isServerDisabled(state.config.mcpServers[serverName]) || isServerInActiveFailureBackoff(state, serverName)) continue;
    for (const tool of metadata) matches.push({ server: serverName, tool, score: 0 });
  }
  return matches;
}

function roundRobinNonLexical(query: string, matches: RankedToolMatch[]): RankedToolMatch[] {
  const buckets = new Map<string, RankedToolMatch[]>();
  for (const match of matches) {
    const bucket = buckets.get(match.server) ?? [];
    bucket.push(match);
    buckets.set(match.server, bucket);
  }
  const servers = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => stableHash(query + a.tool.name).localeCompare(stableHash(query + b.tool.name)) || a.tool.name.localeCompare(b.tool.name));
  }
  if (servers.length > 1) {
    const start = Number.parseInt(stableHash(query).slice(0, 8), 16) % servers.length;
    servers.push(...servers.splice(0, start));
  }
  const result: RankedToolMatch[] = [];
  let index = 0;
  while (result.length < matches.length) {
    let added = false;
    for (const server of servers) {
      const match = buckets.get(server)?.[index];
      if (match) { result.push(match); added = true; }
    }
    if (!added) break;
    index += 1;
  }
  return result;
}

function selectSemanticCandidates(
  state: McpExtensionState,
  query: string,
  server: string | undefined,
  allowedServers: string[],
  limit: number,
): Candidate[] {
  const eligible = eligibleMatches(state, server, new Set(allowedServers));
  let selected = eligible;
  if (eligible.length > limit) {
    const eligiblePaths = new Set(eligible.map(match => `${match.server}\0${match.tool.name}`));
    const lexical = rankToolMatches(state, query, server)
      .filter(match => eligiblePaths.has(`${match.server}\0${match.tool.name}`));
    const lexicalCount = Math.floor(limit / 2);
    const first = lexical.slice(0, lexicalCount);
    const lexicalPaths = new Set(lexical.map(match => `${match.server}\0${match.tool.name}`));
    const broad = roundRobinNonLexical(query, eligible.filter(match => !lexicalPaths.has(`${match.server}\0${match.tool.name}`)));
    selected = [...first, ...broad.slice(0, limit - first.length)];
  }
  return selected.map((match, index) => ({ id: `c${index}`, server: match.server,
    description: truncateUtf8(match.tool.description ?? "", 512), tool: match.tool }));
}

export async function semanticSearch(
  state: McpExtensionState,
  query: string,
  server?: string,
  signal?: AbortSignal,
  evaluator: SemanticSearchEvaluator = evaluateJev,
  observedSources: readonly string[] = [],
): Promise<SemanticSearchResult> {
  let settings;
  try {
    settings = resolveSemanticJevSettings(state);
  } catch {
    return { ok: false, error: { code: "invalid_request", message: "Invalid TypeSafe semantic search settings." } };
  }
  if (!settings.semanticSearch) {
    return { ok: false, error: { code: "disabled", message: "TypeSafe semantic search is disabled." } };
  }
  if (settings.allowedServers.length === 0) {
    return { ok: false, error: { code: "data_policy_denied", message: "Semantic search is enabled, but settings.jev.allowedServers is empty. Run /mcp jev setup or allow specific MCP servers." } };
  }
  if (server && !settings.allowedServers.includes(server)) {
    return { ok: false, error: { code: "data_policy_denied", message: `Server "${server}" is not allowed by settings.jev.allowedServers.` } };
  }
  if (!areJevSourcesAllowed(state, settings, observedSources)) {
    return { ok: false, error: { code: "data_policy_denied", message: "Evaluation sources are not allowed by policy." } };
  }
  if (query.trim().length === 0) {
    return { ok: false, error: { code: "empty_query", message: "Semantic search query cannot be empty." } };
  }
  const candidates = selectSemanticCandidates(state, query, server, settings.allowedServers, settings.semanticCandidateLimit);
  if (candidates.length === 0) {
    return { ok: false, error: { code: "no_eligible_tools", message: "Semantic search has no eligible cached tools from the allowed servers. Connect an allowed server or update settings.jev.allowedServers." } };
  }
  const input: JevEvaluateInput = {
    state: {
      query,
      candidates: candidates.map(candidate => ({ id: candidate.id, path: candidate.tool.name,
        name: candidate.tool.originalName, server: candidate.server, description: candidate.description })),
    },
    questions: {
      match: {
        type: "choice",
        instructions: "Rank which tool best matches the query. Choose none when no tool is suitable.",
        criteria: Object.fromEntries([
          ...candidates.map(candidate => [candidate.id, { path: candidate.tool.name }]),
          ["none", { noSuitableTool: true }],
        ]),
      },
    },
    sources: [...new Set(candidates.map(candidate => candidate.server))],
  };
  const envelope = await evaluator(state, input, { purpose: "semantic-search", ...(signal ? { signal } : {}), ...(observedSources.length > 0 ? { observedSources } : {}) });
  if (!envelope.ok) {
    if (envelope.error.code === "timeout" || envelope.error.code === "rate_limited" || envelope.error.code === "service_unavailable") {
      return {
        ok: true,
        matches: rankToolMatches(state, query, server),
        backend: { requested: "semantic", used: "lexical", degraded: true, reason: envelope.error.code },
      };
    }
    return { ok: false, error: { code: envelope.error.code, message: envelope.error.message } };
  }
  const answer = envelope.data.answers.match;
  if (!answer || answer.type !== "choice") {
    return { ok: false, error: { code: "invalid_response", message: "TypeSafe returned an invalid semantic search response." } };
  }
  const ranked = candidates
    .map(candidate => ({ candidate, probability: answer.probabilities[candidate.id] ?? 0 }))
    .sort((a, b) => b.probability - a.probability || a.candidate.id.localeCompare(b.candidate.id));
  const top = ranked[0];
  const noneProbability = answer.probabilities.none ?? 0;
  const abstained = answer.choice === "none" || !top || noneProbability >= top.probability || top.probability < settings.semanticMinProbability;
  const matches = abstained ? [] : ranked.map(({ candidate, probability }) => ({ server: candidate.server, tool: candidate.tool, score: probability }));
  return {
    ok: true,
    matches,
    backend: {
      requested: "semantic", used: "semantic", degraded: false, model: envelope.data.model,
      usage: envelope.data.usage, abstained,
    },
  };
}
