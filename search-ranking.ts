import type { McpExtensionState } from "./state.ts";
import type { ServerEntry, ToolMetadata, ToolPrefix } from "./types.ts";
import { getServerPrefix, getToolNameCandidates, isServerDisabled, matchesToolPattern, resolveToolPrefix } from "./types.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";

/**
 * Shortest field token allowed to stem-match a longer query token.
 * Real descriptions tokenize possessives into single letters ("project's" -> ["project", "s"]),
 * which would otherwise make every query starting with that letter a match.
 */
const MIN_STEM_LENGTH = 4;

const FIELD_WEIGHTS = {
  name: 12,
  originalName: 10,
  server: 8,
  description: 5,
  keywords: 5,
} as const;

export interface RankedToolMatch {
  server: string;
  tool: ToolMetadata;
  score: number;
}

type SearchField = Exclude<keyof typeof FIELD_WEIGHTS, "keywords">;

interface PreparedToolSearch {
  tool: ToolMetadata;
  fields: Array<[SearchField, string, string[]]>;
  nameTokens: string[];
  keywordPhrases: string[];
  keywordTokens: string[];
}

interface CachedServerSearch {
  metadata: ToolMetadata[];
  searchKeywords: ServerEntry["searchKeywords"];
  toolPrefix: ReturnType<typeof resolveToolPrefix>;
  withKeywords?: PreparedToolSearch[];
  withoutKeywords?: PreparedToolSearch[];
}

const searchCache = new WeakMap<McpExtensionState, Map<string, CachedServerSearch>>();

/**
 * Resolve the configured searchKeywords entries that apply to a tool.
 * Keys match by original name, prefixed name, or glob — the same candidate
 * set includeTools/excludeTools use — and all matching entries are unioned.
 */
export function resolveSearchKeywords(
  definition: ServerEntry | undefined,
  toolOriginalName: string,
  serverName: string,
  globalPrefix: ToolPrefix,
): string[] {
  const map = definition?.searchKeywords;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const candidates = getToolNameCandidates(toolOriginalName, serverName, resolveToolPrefix(definition, globalPrefix));
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const [pattern, values] of Object.entries(map)) {
    if (!Array.isArray(values)) continue;
    if (!matchesToolPattern(candidates, [pattern])) continue;
    for (const value of values) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      keywords.push(trimmed);
    }
  }
  return keywords;
}

export function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase();
}

export function tokenize(value: string): string[] {
  return normalizeSearchText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function prepareToolSearch(tool: ToolMetadata, server: string, keywords?: string[]): PreparedToolSearch {
  const fields = {
    name: normalizeSearchText(tool.name),
    originalName: normalizeSearchText(tool.originalName),
    server: normalizeSearchText(server),
    description: normalizeSearchText(tool.description),
  };
  const preparedFields = (Object.entries(fields) as Array<[SearchField, string]>)
    .map(([field, value]): [SearchField, string, string[]] => [field, value, tokenize(value)]);
  const keywordPhrases = keywords?.map(keyword => normalizeSearchText(keyword).trim()).filter(Boolean) ?? [];
  return {
    tool,
    fields: preparedFields,
    nameTokens: preparedFields[0]![2],
    keywordPhrases,
    keywordTokens: keywordPhrases.flatMap(tokenize),
  };
}

function scorePreparedToolMatch(
  prepared: PreparedToolSearch,
  normalizedQuery: string,
  queryTokens: string[],
): number | null {
  let score = 0;
  let phraseMatched = false;
  let wholeFieldExact = false;
  const matchedTokens = new Set<string>();

  for (const [field, value, fieldTokens] of prepared.fields) {
    const weight = FIELD_WEIGHTS[field];
    if (value === normalizedQuery) {
      score += weight * 14;
      phraseMatched = true;
      wholeFieldExact = true;
    } else if (value.startsWith(normalizedQuery)) {
      score += weight * 9;
      phraseMatched = true;
    } else if (value.includes(normalizedQuery)) {
      score += weight * 6;
      phraseMatched = true;
    }

    for (const token of queryTokens) {
      if (fieldTokens.includes(token)) {
        score += weight * 4;
        matchedTokens.add(token);
      } else if (fieldTokens.some(fieldToken => fieldToken.startsWith(token) || (fieldToken.length >= MIN_STEM_LENGTH && token.startsWith(fieldToken)))) {
        score += weight * 2;
        matchedTokens.add(token);
      } else if (value.includes(token)) {
        score += weight;
        matchedTokens.add(token);
      }
    }
  }

  // Configured keywords are discrete phrases, so the phrase-level bonus is
  // computed per phrase (best match wins) rather than on a joined string,
  // which would phrase-match queries spanning two unrelated keywords.
  if (prepared.keywordPhrases.length > 0) {
    const weight = FIELD_WEIGHTS.keywords;
    let phraseScore = 0;
    for (const phrase of prepared.keywordPhrases) {
      if (phrase === normalizedQuery) {
        phraseScore = Math.max(phraseScore, weight * 14);
        phraseMatched = true;
        wholeFieldExact = true;
      } else if (phrase.startsWith(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 9);
        phraseMatched = true;
      } else if (phrase.includes(normalizedQuery)) {
        phraseScore = Math.max(phraseScore, weight * 6);
        phraseMatched = true;
      }
    }
    score += phraseScore;

    for (const token of queryTokens) {
      if (prepared.keywordTokens.includes(token)) {
        score += weight * 4;
        matchedTokens.add(token);
      } else if (prepared.keywordTokens.some(keywordToken => keywordToken.startsWith(token) || (keywordToken.length >= MIN_STEM_LENGTH && token.startsWith(keywordToken)))) {
        score += weight * 2;
        matchedTokens.add(token);
      } else if (prepared.keywordPhrases.some(phrase => phrase.includes(token))) {
        score += weight;
        matchedTokens.add(token);
      }
    }
  }

  const coverage = matchedTokens.size / queryTokens.length;
  if (!phraseMatched && (queryTokens.length <= 2 ? coverage !== 1 : coverage < 0.6)) return null;

  score += coverage === 1 ? 25 : Math.round(coverage * 10);
  const firstQueryToken = queryTokens[0];
  if (firstQueryToken !== undefined && prepared.nameTokens.includes(firstQueryToken)) score += 8;
  if (wholeFieldExact) score += 20;
  return score;
}

export function scoreToolMatch(tool: ToolMetadata, server: string, query: string, keywords?: string[]): number | null {
  const normalizedQuery = normalizeSearchText(query).trim();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return null;
  return scorePreparedToolMatch(prepareToolSearch(tool, server, keywords), normalizedQuery, queryTokens);
}

function getPreparedTools(
  state: McpExtensionState,
  serverName: string,
  metadata: ToolMetadata[],
  definition: ServerEntry | undefined,
  globalPrefix: ToolPrefix,
  includeKeywords: boolean,
): PreparedToolSearch[] {
  let stateCache = searchCache.get(state);
  if (!stateCache) {
    stateCache = new Map();
    searchCache.set(state, stateCache);
  }
  const toolPrefix = resolveToolPrefix(definition, globalPrefix);
  let cached = stateCache.get(serverName);
  if (cached?.metadata !== metadata || cached.searchKeywords !== definition?.searchKeywords || cached.toolPrefix !== toolPrefix) {
    cached = { metadata, searchKeywords: definition?.searchKeywords, toolPrefix };
    stateCache.set(serverName, cached);
  }
  const cacheKey = includeKeywords ? "withKeywords" : "withoutKeywords";
  let prepared = cached[cacheKey];
  if (!prepared) {
    prepared = metadata.map(tool => prepareToolSearch(
      tool,
      serverName,
      includeKeywords && definition?.searchKeywords !== undefined
        ? resolveSearchKeywords(definition, tool.originalName, serverName, globalPrefix)
        : undefined,
    ));
    cached[cacheKey] = prepared;
  }
  return prepared;
}

export function rankToolMatches(
  state: McpExtensionState,
  query: string,
  server?: string,
  includeKeywords = true,
): RankedToolMatch[] {
  const matches: RankedToolMatch[] = [];
  const normalizedQuery = normalizeSearchText(query).trim();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return matches;
  const globalPrefix = state.config.settings?.toolPrefix ?? "server";
  for (const [serverName, metadata] of state.toolMetadata.entries()) {
    if (server && serverName !== server) continue;
    const definition = state.config.mcpServers[serverName];
    if (isServerDisabled(definition)) continue;
    if (isServerInActiveFailureBackoff(state, serverName)) continue;
    for (const prepared of getPreparedTools(state, serverName, metadata, definition, globalPrefix, includeKeywords)) {
      const score = scorePreparedToolMatch(prepared, normalizedQuery, queryTokens);
      if (score !== null) matches.push({ server: serverName, tool: prepared.tool, score });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
}

export function paginate<T>(items: T[], offset: number, limit: number): { items: T[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  const total = items.length;
  const page = items.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + page.length;
  return {
    items: page,
    total,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
}

export function rankSuggestions(state: McpExtensionState, name: string, limit: number): string[] {
  const stripped = Object.keys(state.config.mcpServers)
    .flatMap(server => (["server", "short", "mcp"] as const)
      .map(prefix => getServerPrefix(server, prefix)))
    .filter((candidate): candidate is string => Boolean(candidate) && name.startsWith(`${candidate}_`))
    .sort((a, b) => b.length - a.length)
    .map(candidate => name.slice(candidate.length + 1));
  const query = stripped[0] ?? name;
  return rankToolMatches(state, query, undefined, false).slice(0, limit).map(match => match.tool.name);
}
