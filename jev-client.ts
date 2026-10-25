import type { McpExtensionState } from "./state.ts";
import { isServerDisabled } from "./types.ts";

export interface ResolvedJevSettings {
  semanticSearch: boolean;
  allowedServers: string[];
  /** Pi classifier model as "provider/id". Unset: the first default model Pi has a credential for. */
  model?: string;
  semanticCandidateLimit: number;
  semanticMinProbability: number;
}

const DEFAULTS = {
  semanticSearch: true, semanticCandidateLimit: 127, semanticMinProbability: 0.2,
} as const;
const ACCEPTED_KEYS = new Set(["semanticSearch", "allowedServers", "model", "semanticCandidateLimit", "semanticMinProbability"]);
/** Settings for the removed `jev.evaluate()`. A config that still sets them loads, and they do nothing. */
export const REMOVED_JEV_KEYS: ReadonlySet<string> = new Set([
  "scriptEvaluation", "maxEvaluationsPerScript", "maxEvaluationBytesPerScript", "maxEvaluationTokensPerScript",
]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

export function validateJevSettings(value: unknown): ResolvedJevSettings {
  if (value === undefined) return { ...DEFAULTS, allowedServers: [] };
  if (value === false) return { ...DEFAULTS, semanticSearch: false, allowedServers: [] };
  const input = record(value, "settings.jev");
  for (const key of Object.keys(input)) if (!ACCEPTED_KEYS.has(key) && !REMOVED_JEV_KEYS.has(key)) throw new Error(`settings.jev.${key} is not supported`);
  const { semanticSearch = DEFAULTS.semanticSearch, allowedServers = [], model, semanticCandidateLimit = DEFAULTS.semanticCandidateLimit, semanticMinProbability = DEFAULTS.semanticMinProbability } = input;
  if (typeof semanticSearch !== "boolean") throw new Error("settings.jev.semanticSearch must be a boolean");
  if (!Array.isArray(allowedServers) || allowedServers.some(name => typeof name !== "string" || name.length === 0 || DANGEROUS_KEYS.has(name) || CONTROL_CHARACTERS.test(name))) {
    throw new Error("settings.jev.allowedServers must contain non-empty safe server names");
  }
  if (model !== undefined) {
    const slash = typeof model === "string" ? model.indexOf("/") : -1;
    if (typeof model !== "string" || slash <= 0 || slash === model.length - 1 || model.length > 256 || CONTROL_CHARACTERS.test(model)) {
      throw new Error('settings.jev.model must be a Pi classifier model as "provider/id"');
    }
  }
  if (!Number.isInteger(semanticCandidateLimit) || (semanticCandidateLimit as number) < 2 || (semanticCandidateLimit as number) > 127) {
    throw new Error("settings.jev.semanticCandidateLimit must be an integer from 2 to 127");
  }
  if (typeof semanticMinProbability !== "number" || !Number.isFinite(semanticMinProbability) || semanticMinProbability < 0 || semanticMinProbability > 1) {
    throw new Error("settings.jev.semanticMinProbability must be from 0 to 1");
  }
  return {
    semanticSearch, allowedServers: [...new Set(allowedServers as string[])],
    ...(model !== undefined ? { model: model as string } : {}),
    semanticCandidateLimit: semanticCandidateLimit as number, semanticMinProbability,
  };
}

/** Without an explicit `allowedServers`, every enabled server may share its tool metadata. */
export function resolveSemanticJevSettings(state: McpExtensionState): ResolvedJevSettings {
  const configured = state.config.settings?.jev;
  const settings = validateJevSettings(configured);
  if (configured !== undefined && configured !== false && Object.hasOwn(configured, "allowedServers")) return settings;
  const allowedServers = Object.keys(state.config.mcpServers).filter((name) => !isServerDisabled(state.config.mcpServers[name]));
  return { ...settings, allowedServers };
}
