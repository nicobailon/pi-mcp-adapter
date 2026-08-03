import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { getServerPrefix, isServerDisabled } from "./types.ts";

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
} as const;

export interface RankedToolMatch {
  server: string;
  tool: ToolMetadata;
  score: number;
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

export function scoreToolMatch(tool: ToolMetadata, server: string, query: string): number | null {
  const normalizedQuery = normalizeSearchText(query).trim();
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return null;

  const fields = {
    name: normalizeSearchText(tool.name),
    originalName: normalizeSearchText(tool.originalName),
    server: normalizeSearchText(server),
    description: normalizeSearchText(tool.description),
  };
  let score = 0;
  let phraseMatched = false;
  let wholeFieldExact = false;
  const matchedTokens = new Set<string>();

  for (const [field, value] of Object.entries(fields) as Array<[keyof typeof FIELD_WEIGHTS, string]>) {
    const weight = FIELD_WEIGHTS[field];
    const fieldTokens = tokenize(value);
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

  const coverage = matchedTokens.size / queryTokens.length;
  if (!phraseMatched && (queryTokens.length <= 2 ? coverage !== 1 : coverage < 0.6)) return null;

  score += coverage === 1 ? 25 : Math.round(coverage * 10);
  const firstQueryToken = queryTokens[0];
  if (firstQueryToken !== undefined && tokenize(fields.name).includes(firstQueryToken)) score += 8;
  if (wholeFieldExact) score += 20;
  return score;
}

export function rankToolMatches(state: McpExtensionState, query: string, server?: string): RankedToolMatch[] {
  const matches: RankedToolMatch[] = [];
  for (const [serverName, metadata] of state.toolMetadata.entries()) {
    if (server && serverName !== server) continue;
    if (isServerDisabled(state.config.mcpServers[serverName])) continue;
    for (const tool of metadata) {
      const score = scoreToolMatch(tool, serverName, query);
      if (score !== null) matches.push({ server: serverName, tool, score });
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
  return rankToolMatches(state, query).slice(0, limit).map(match => match.tool.name);
}
