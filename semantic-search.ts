import { createHash } from "node:crypto";
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, ModelsClassifierOptions } from "@earendil-works/pi-ai";
import { resolveSemanticSearchSettings } from "./semantic-settings.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { rankToolMatches, type RankedToolMatch } from "./search-ranking.ts";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { isServerDisabled } from "./types.ts";

/** The part of Pi's ModelRegistry semantic search uses. `ctx.modelRegistry` satisfies it on Pi >= 0.99. */
export interface SemanticClassifierRegistry {
  findOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
  getProviderAuthStatus(provider: string): { configured: boolean };
  classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: ModelsClassifierOptions): Promise<ClassifierResult>;
}

export type SemanticSearchBackend =
  | {
    requested: "semantic"; used: "semantic"; degraded: false; provider: string; model: string;
    usage?: { input: number; output: number; cost?: number }; abstained: boolean;
  }
  | {
    requested: "semantic"; used: "lexical"; degraded: true; provider: string; model: string;
    reason: "timeout" | "rate_limited" | "service_unavailable";
  };

export type SemanticSearchResult =
  | { ok: true; matches: RankedToolMatch[]; backend: SemanticSearchBackend }
  | { ok: false; error: { code: string; message: string } };

export type SemanticClassifierChoice =
  | { ok: true; provider: string; model: string; classifier: ClassifierModel<ClassifierApi> }
  | { ok: false; error: { code: "unknown_model" | "no_classifier"; message: string } };

/** Tried in order when no model is configured; the first one Pi knows and has a credential for is used. */
const DEFAULT_MODELS = [
  "typesafe/jev-latest",
  "openrouter/typesafe/jev-1.13",
  "cloudflare-workers-ai/typesafe/jev",
  "opencode/jev-1.13",
  "vercel-ai-gateway/typesafe-ai/jev",
] as const;
const REQUEST_TIMEOUT_MS = 5_000;
const FALLBACK_CODES = new Set(["timeout", "rate_limited", "service_unavailable"]);

export const SEMANTIC_SEARCH_UNAVAILABLE = "Semantic search needs Pi 0.99 or later with classifier models; word search still works.";

/** Pi before 0.99, and hosts without Pi's context, have no classifier models. */
export function classifierRegistryOf(ctx: { modelRegistry?: unknown } | undefined): SemanticClassifierRegistry | undefined {
  const registry = ctx?.modelRegistry as Partial<SemanticClassifierRegistry> | undefined;
  return typeof registry?.classify === "function" && typeof registry.findOfType === "function" && typeof registry.getProviderAuthStatus === "function"
    ? registry as SemanticClassifierRegistry
    : undefined;
}

function splitModel(model: string): { provider: string; id: string } {
  const slash = model.indexOf("/");
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/**
 * An explicit model skips the credential check: local providers such as llama.cpp need none, and a missing
 * credential is reported by the classify call itself.
 */
export function resolveSemanticClassifier(registry: SemanticClassifierRegistry, configuredModel: string | undefined): SemanticClassifierChoice {
  if (configuredModel !== undefined) {
    const { provider, id } = splitModel(configuredModel);
    const classifier = registry.findOfType("classifier", provider, id);
    return classifier
      ? { ok: true, provider, model: configuredModel, classifier }
      : { ok: false, error: { code: "unknown_model", message: `Classifier model "${configuredModel}" is not in Pi's model list. Check settings.semanticSearch.model.` } };
  }
  for (const model of DEFAULT_MODELS) {
    const { provider, id } = splitModel(model);
    const classifier = registry.findOfType("classifier", provider, id);
    if (classifier && registry.getProviderAuthStatus(provider).configured) return { ok: true, provider, model, classifier };
  }
  return {
    ok: false,
    error: {
      code: "no_classifier",
      message: "Semantic search needs a classifier model in Pi. Sign in to OpenRouter with /login, set TYPESAFE_API_KEY or OPENROUTER_API_KEY, or set settings.semanticSearch.model to a classifier you have, such as a llama.cpp model.",
    },
  };
}

/** Maps a failed classify result to a code. `errorMessage` can carry provider text, so it is parsed, never copied. */
function classifierFailure(result: ClassifierResult, provider: string, model: string): { code: string; message: string } {
  if (result.stopReason === "aborted") return { code: "aborted", message: "Semantic search was cancelled." };
  const errorMessage = result.errorMessage ?? "";
  if (errorMessage.startsWith("Request timed out after")) return { code: "timeout", message: `${model} timed out.` };
  if (errorMessage.startsWith("No API key for provider")) {
    return { code: "credential_missing", message: `${provider} has no credential in Pi. Sign in with /login or set its API key.` };
  }
  const statusMatch = /\((\d{3})\):/.exec(errorMessage);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status === 408) return { code: "timeout", message: `${model} timed out.` };
  if (status === 429) return { code: "rate_limited", message: `${model} is rate limited.` };
  if (status !== undefined && status >= 500) return { code: "service_unavailable", message: `${model} is unavailable.` };
  if (status === 401 || status === 403) return { code: "authentication_failed", message: `${provider} rejected the credential.` };
  if (status === 402) return { code: "payment_required", message: `${provider} requires payment for this account.` };
  return { code: "provider_error", message: status === undefined ? `${model} could not rank tools.` : `${model} could not rank tools (HTTP ${status}).` };
}

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

function eligibleMatches(state: McpExtensionState, server: string | undefined, allowed: ReadonlySet<string>): RankedToolMatch[] {
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
  allowedServers: ReadonlySet<string>,
  limit: number,
): Candidate[] {
  const eligible = eligibleMatches(state, server, allowedServers);
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
  registry?: SemanticClassifierRegistry,
): Promise<SemanticSearchResult> {
  let settings;
  try {
    settings = resolveSemanticSearchSettings(state);
  } catch {
    return { ok: false, error: { code: "invalid_request", message: "Invalid semantic search settings." } };
  }
  if (!settings.enabled) {
    return { ok: false, error: { code: "disabled", message: "Semantic search is turned off by settings.semanticSearch." } };
  }
  if (!registry) return { ok: false, error: { code: "unavailable", message: SEMANTIC_SEARCH_UNAVAILABLE } };
  if (settings.allowedServers.length === 0) {
    return { ok: false, error: { code: "data_policy_denied", message: "Semantic search is enabled, but settings.semanticSearch.allowedServers is empty. Run /mcp-adapter semantic setup or allow specific MCP servers." } };
  }
  if (server && !settings.allowedServers.includes(server)) {
    return { ok: false, error: { code: "data_policy_denied", message: `Server "${server}" is not allowed by settings.semanticSearch.allowedServers.` } };
  }
  if (query.trim().length === 0) {
    return { ok: false, error: { code: "empty_query", message: "Semantic search query cannot be empty." } };
  }
  const choice = resolveSemanticClassifier(registry, settings.model);
  if (!choice.ok) return choice;
  const { provider, model } = choice;
  const allowedServers = new Set(settings.allowedServers);
  const candidates = selectSemanticCandidates(state, query, server, allowedServers, settings.candidateLimit);
  if (candidates.length === 0) {
    return { ok: false, error: { code: "no_eligible_tools", message: "Semantic search has no eligible cached tools from the allowed servers. Connect an allowed server or update settings.semanticSearch.allowedServers." } };
  }
  const context: ClassifierContext = {
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
          ...candidates.map(candidate => [candidate.id, `The tool at path ${candidate.tool.name}`]),
          ["none", "No listed tool is suitable"],
        ]),
      },
    },
  };
  const requestSignal = combineAbortSignals(signal, state.owner.signal);
  const result = await registry.classify(choice.classifier, context, {
    ...(requestSignal ? { signal: requestSignal } : {}), timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: 0,
  });
  if (result.stopReason !== "stop") {
    const failure = classifierFailure(result, provider, model);
    if (FALLBACK_CODES.has(failure.code)) {
      return {
        ok: true,
        matches: rankToolMatches(state, query, server).filter(match => allowedServers.has(match.server)),
        backend: { requested: "semantic", used: "lexical", degraded: true, provider, model, reason: failure.code as "timeout" | "rate_limited" | "service_unavailable" },
      };
    }
    return { ok: false, error: failure };
  }
  const answer = result.answers.match;
  if (!answer || answer.type !== "choice") {
    return { ok: false, error: { code: "invalid_response", message: `${model} returned an invalid answer.` } };
  }
  const ranked = candidates
    .map(candidate => ({ candidate, probability: answer.probabilities[candidate.id] ?? 0 }))
    .sort((a, b) => b.probability - a.probability || a.candidate.id.localeCompare(b.candidate.id));
  const top = ranked[0];
  const noneProbability = answer.probabilities.none ?? 0;
  const abstained = answer.choice === "none" || !top || noneProbability >= top.probability || top.probability < settings.minProbability;
  const matches = abstained ? [] : ranked.map(({ candidate, probability }) => ({ server: candidate.server, tool: candidate.tool, score: probability }));
  const usage = result.usage
    ? { input: result.usage.input, output: result.usage.output, ...(result.usage.cost ? { cost: result.usage.cost.total } : {}) }
    : undefined;
  return {
    ok: true,
    matches,
    backend: { requested: "semantic", used: "semantic", degraded: false, provider, model, ...(usage ? { usage } : {}), abstained },
  };
}
