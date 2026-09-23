import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled } from "./types.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { JEV_SDK_PATH, resolveJevCredential, resolveJevEndpoint, type JevCredentialResolution, type ResolvedJevEndpoint } from "./jev-key-store.ts";
import type { JevAnswer, JevBudget, JevEvaluateInput, JevEvaluationData, JevEvaluationEnvelope, JevJson, JevQuestion, ResolvedJevSettings } from "./jev-contracts.ts";

export type { ResolvedJevSettings } from "./jev-contracts.ts";

const DEFAULTS: ResolvedJevSettings = {
  semanticSearch: false, scriptEvaluation: false, allowedServers: [], model: "jev-1.13.0",
  requestTimeoutMs: 5_000, maxRetries: 0, maxStateBytes: 262_144,
  maxQuestionsPerRequest: 64, maxEvaluationsPerScript: 8,
  maxEvaluationBytesPerScript: 524_288, maxEvaluationTokensPerScript: 32_768, semanticCandidateLimit: 127,
  semanticMinProbability: 0.2,
};
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type JevSettingsInput = Partial<ResolvedJevSettings>;
type Host = { endpoint: ResolvedJevEndpoint; client: TypeSafeClient };
type CredentialCacheEntry = { endpoint: string; credential: Extract<JevCredentialResolution, { status: "present" }> };
const hosts = new WeakMap<McpExtensionState, Host>();
const credentials = new WeakMap<McpExtensionState, CredentialCacheEntry>();

/**
 * Cached per endpoint so a changed `SYSTEMONE_ENDPOINT` cannot reuse another provider's credential. Callers
 * re-resolve the endpoint on every operation so a switched or newly invalid endpoint takes effect immediately.
 */
function resolveCredential(state: McpExtensionState, endpoint: ResolvedJevEndpoint): JevCredentialResolution {
  const existing = credentials.get(state);
  if (existing && existing.endpoint === endpoint.href) return existing.credential;
  const credential = resolveJevCredential(process.env, endpoint);
  if (credential.status === "present") credentials.set(state, { endpoint: endpoint.href, credential });
  return credential;
}

function credentialForState(state: McpExtensionState): JevCredentialResolution {
  const resolution = resolveJevEndpoint();
  return resolution.status === "unavailable" ? resolution : resolveCredential(state, resolution.endpoint);
}

export function areJevSourcesAllowed(state: McpExtensionState, settings: ResolvedJevSettings, sources: Iterable<string>): boolean {
  for (const source of sources) {
    const server = state.config.mcpServers[source];
    if (!settings.allowedServers.includes(source) || !server || isServerDisabled(server)) return false;
  }
  return true;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}
function boolean(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}
function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value as number;
}

export function validateJevSettings(value: unknown): ResolvedJevSettings {
  if (value === undefined || value === false) return { ...DEFAULTS, allowedServers: [...DEFAULTS.allowedServers] };
  const input = record(value, "settings.jev") as JevSettingsInput;
  const allowed = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`settings.jev.${key} is not supported`);
  if (input.allowedServers !== undefined && (!Array.isArray(input.allowedServers) || input.allowedServers.some(name => typeof name !== "string" || name.length === 0 || DANGEROUS_KEYS.has(name) || /[\u0000-\u001f\u007f]/.test(name)))) {
    throw new Error("settings.jev.allowedServers must contain non-empty safe server names");
  }
  const model = input.model ?? DEFAULTS.model;
  if (typeof model !== "string" || model.length === 0 || model.length > 128 || /(?:latest|preview)/i.test(model)) throw new Error("settings.jev.model must be a pinned model name");
  const probability = input.semanticMinProbability ?? DEFAULTS.semanticMinProbability;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("settings.jev.semanticMinProbability must be from 0 to 1");
  return {
    semanticSearch: boolean(input.semanticSearch, DEFAULTS.semanticSearch, "settings.jev.semanticSearch"),
    scriptEvaluation: boolean(input.scriptEvaluation, DEFAULTS.scriptEvaluation, "settings.jev.scriptEvaluation"),
    allowedServers: [...new Set(input.allowedServers ?? DEFAULTS.allowedServers)], model,
    requestTimeoutMs: integer(input.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 100, 30_000, "settings.jev.requestTimeoutMs"),
    maxRetries: integer(input.maxRetries, DEFAULTS.maxRetries, 0, 2, "settings.jev.maxRetries"),
    maxStateBytes: integer(input.maxStateBytes, DEFAULTS.maxStateBytes, 1, 1_048_576, "settings.jev.maxStateBytes"),
    maxQuestionsPerRequest: integer(input.maxQuestionsPerRequest, DEFAULTS.maxQuestionsPerRequest, 1, 128, "settings.jev.maxQuestionsPerRequest"),
    maxEvaluationsPerScript: integer(input.maxEvaluationsPerScript, DEFAULTS.maxEvaluationsPerScript, 1, 32, "settings.jev.maxEvaluationsPerScript"),
    maxEvaluationBytesPerScript: integer(input.maxEvaluationBytesPerScript, DEFAULTS.maxEvaluationBytesPerScript, 1, 4_194_304, "settings.jev.maxEvaluationBytesPerScript"),
    maxEvaluationTokensPerScript: integer(input.maxEvaluationTokensPerScript, DEFAULTS.maxEvaluationTokensPerScript, 1, 1_000_000, "settings.jev.maxEvaluationTokensPerScript"),
    semanticCandidateLimit: integer(input.semanticCandidateLimit, DEFAULTS.semanticCandidateLimit, 2, 127, "settings.jev.semanticCandidateLimit"),
    semanticMinProbability: probability,
  };
}

export function resolveSemanticJevSettings(
  state: McpExtensionState,
  credentialResolver?: () => JevCredentialResolution,
): ResolvedJevSettings {
  const configured = state.config.settings?.jev;
  const settings = validateJevSettings(configured);
  if (configured === false || configured?.semanticSearch === false) return settings;
  const semanticSearch = settings.semanticSearch || (credentialResolver ? credentialResolver() : credentialForState(state)).status === "present";
  const hasExplicitAllowlist = configured !== undefined && Object.hasOwn(configured, "allowedServers");
  const allowedServers = hasExplicitAllowlist
    ? settings.allowedServers
    : Object.keys(state.config.mcpServers).filter((name) => !isServerDisabled(state.config.mcpServers[name]));
  return { ...settings, semanticSearch, allowedServers };
}

function validateJson(value: unknown, path: string, seen = new Set<object>()): asserts value is JevJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (Number.isFinite(value)) return; throw new Error(`${path} contains a non-finite number`); }
  if (typeof value !== "object") throw new Error(`${path} is not JSON-compatible`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => validateJson(item, `${path}[${index}]`, seen));
  else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} contains a non-plain object`);
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`${path} contains an unsafe key`);
      validateJson(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}
function validateId(id: string, label: string): void {
  if (id.length === 0 || id.length > 128 || DANGEROUS_KEYS.has(id) || /[\u0000-\u001f\u007f]/.test(id)) throw new Error(`${label} contains an invalid identifier`);
}
function validateSource(source: string): void {
  if (source.length === 0 || DANGEROUS_KEYS.has(source) || /[\u0000-\u001f\u007f]/.test(source)) throw new Error("sources contains an invalid server name");
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
}

export function validateJevEvaluateInput(value: unknown, limits: ResolvedJevSettings): JevEvaluateInput {
  const input = record(value, "Jev evaluation input");
  exactKeys(input, ["state", "questions", "sources"], "Jev evaluation input");
  if (!("state" in input)) throw new Error("Jev evaluation input requires state");
  validateJson(input.state, "state");
  const stateBytes = Buffer.byteLength(JSON.stringify(input.state));
  if (stateBytes > limits.maxStateBytes) throw new Error("Jev state exceeds maxStateBytes");
  const questions = record(input.questions, "questions");
  const entries = Object.entries(questions);
  if (entries.length < 1 || entries.length > limits.maxQuestionsPerRequest) throw new Error("Jev question count is outside the configured limit");
  for (const [id, raw] of entries) {
    validateId(id, "questions");
    const question = record(raw, `question ${id}`);
    if (question.type === "choice") {
      exactKeys(question, ["type", "instructions", "criteria"], `question ${id}`);
      const criteria = record(question.criteria, `question ${id} criteria`);
      const labels = Object.keys(criteria);
      if (labels.length < 2 || labels.length > 128) throw new Error(`question ${id} choice criteria must have 2 to 128 labels`);
      for (const label of labels) { validateId(label, `question ${id} criteria`); validateJson(criteria[label], `question ${id} criteria.${label}`); }
    } else if (question.type === "score") {
      exactKeys(question, ["type", "instructions", "criteria"], `question ${id}`);
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 16) throw new Error(`question ${id} score criteria must have 2 to 16 entries`);
      validateJson(question.criteria, `question ${id} criteria`);
    } else if (question.type === "noul") {
      exactKeys(question, ["type", "instructions", "criteria"], `question ${id}`);
      if (question.criteria !== undefined) {
        const criteria = record(question.criteria, `question ${id} criteria`);
        exactKeys(criteria, ["true", "false"], `question ${id} criteria`);
        validateJson(criteria, `question ${id} criteria`);
      }
    } else throw new Error(`question ${id} has an invalid type`);
    if (question.instructions !== undefined) validateJson(question.instructions, `question ${id} instructions`);
  }
  let sources: string[] | undefined;
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources)) throw new Error("sources must be an array");
    sources = input.sources.map((source, index) => { if (typeof source !== "string") throw new Error(`sources[${index}] must be a string`); validateSource(source); return source; });
    if (new Set(sources).size !== sources.length) throw new Error("sources must not contain duplicates");
  }
  const normalized = { state: input.state, questions: questions as Record<string, JevQuestion>, ...(sources ? { sources } : {}) } as JevEvaluateInput;
  if (Buffer.byteLength(JSON.stringify(normalized)) > limits.maxEvaluationBytesPerScript) throw new Error("Jev request exceeds the configured byte limit");
  return normalized;
}

function safeNumber(value: unknown, label: string, integerOnly = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integerOnly && !Number.isInteger(value))) throw new Error(`Invalid ${label}`);
  return value;
}
function probability(value: unknown, label: string): number {
  const number = safeNumber(value, label);
  if (number > 1) throw new Error(`Invalid ${label}`);
  return number;
}
function sameKeys(actual: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(actual);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(actual, key));
}
function validateResponse(value: unknown, input: JevEvaluateInput): JevEvaluationData {
  const response = record(value, "response");
  exactKeys(response, ["model", "answers", "usage"], "response");
  const answers = record(response.answers, "response answers");
  const questionNames = Object.keys(input.questions);
  if (!sameKeys(answers, questionNames)) throw new Error("Response answer keys do not match questions");
  const validated: Record<string, JevAnswer> = {};
  for (const name of questionNames) {
    const question = input.questions[name]!;
    const answer = record(answers[name], `answer ${name}`);
    if (answer.type !== question.type) throw new Error(`Answer ${name} type does not match`);
    if (question.type === "choice") {
      exactKeys(answer, ["type", "choice", "confidence", "probabilities"], `answer ${name}`);
      const labels = Object.keys(question.criteria);
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) throw new Error(`Answer ${name} choice is invalid`);
      const probabilities = record(answer.probabilities, `answer ${name} probabilities`);
      if (!sameKeys(probabilities, labels)) throw new Error(`Answer ${name} probability keys are invalid`);
      validated[name] = { type: "choice", choice: answer.choice, confidence: probability(answer.confidence, "confidence"), probabilities: Object.fromEntries(labels.map(label => [label, probability(probabilities[label], "probability")])) };
    } else if (question.type === "score") {
      exactKeys(answer, ["type", "score", "confidence", "probabilities", "legend"], `answer ${name}`);
      const labels = question.criteria.map((_, index) => String(index));
      const probabilities = record(answer.probabilities, `answer ${name} probabilities`);
      if (!sameKeys(probabilities, labels)) throw new Error(`Answer ${name} probability keys are invalid`);
      const score = safeNumber(answer.score, "score");
      if (score > question.criteria.length - 1) throw new Error(`Answer ${name} score is invalid`);
      validated[name] = { type: "score", score, confidence: probability(answer.confidence, "confidence"), probabilities: Object.fromEntries(labels.map(label => [label, probability(probabilities[label], "probability")])) };
    } else {
      exactKeys(answer, ["type", "noul"], `answer ${name}`);
      validated[name] = { type: "noul", noul: probability(answer.noul, "noul") };
    }
  }
  if (typeof response.model !== "string" || response.model.length === 0 || response.model.length > 128) throw new Error("Invalid response model");
  const usage = record(response.usage, "response usage");
  if (!sameKeys(usage, ["input_tokens", "output_tokens"])) throw new Error("Invalid response usage");
  return { answers: validated, model: response.model, usage: { inputTokens: safeNumber(usage.input_tokens, "input tokens", true), outputTokens: safeNumber(usage.output_tokens, "output tokens", true) } };
}

/**
 * Pins every request to the configured endpoint: the SDK appends its own fixed path to the base URL, so this
 * rewrites that path onto the configured one and then rejects anything that does not match the endpoint exactly.
 * Redirects stay refused, so a provider cannot bounce a request carrying the API key somewhere else.
 */
function createPinnedEndpointFetch(endpoint: ResolvedJevEndpoint): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    // A replacer function keeps `$&`, `$$`, and friends in the configured path literal.
    const target = input.replace(JEV_SDK_PATH, () => endpoint.path);
    const url = new URL(target);
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.path || url.search !== "" || url.hash !== "") {
      throw new Error("Jev request endpoint rejected");
    }
    return fetch(target, { ...init, redirect: "error" });
  };
}
function getHost(state: McpExtensionState, settings: ResolvedJevSettings): Host | JevEvaluationEnvelope {
  const resolution = resolveJevEndpoint();
  if (resolution.status === "unavailable") return { ok: false, error: { code: "endpoint_unavailable", message: resolution.message } };
  const { endpoint } = resolution;
  const existing = hosts.get(state);
  if (existing && existing.endpoint.href === endpoint.href) return existing;
  const credential = resolveCredential(state, endpoint);
  if (credential.status === "missing") return { ok: false, error: { code: "credential_missing", message: "Jev API key is not configured." } };
  if (credential.status === "unavailable") return { ok: false, error: { code: "credential_unavailable", message: credential.message } };
  const host: Host = { endpoint, client: new TypeSafeClient({ apiKey: credential.apiKey, baseURL: endpoint.origin, defaultModel: settings.model, logLevel: "off", retry: { maxRetries: settings.maxRetries }, timeout: settings.requestTimeoutMs, defaultHeaders: {}, fetch: createPinnedEndpointFetch(endpoint) }) };
  hosts.set(state, host);
  return host;
}
function failure(error: unknown, signal: AbortSignal | undefined, timedOut: boolean): JevEvaluationEnvelope {
  if (timedOut) return { ok: false, error: { code: "timeout", message: "Jev evaluation timed out.", retryable: true } };
  if (signal?.aborted || (error instanceof Error && error.name === "APIUserAbortError")) return { ok: false, error: { code: "aborted", message: "Jev evaluation was aborted." } };
  // Provider and gateway bodies are never echoed; only the status is used to classify the failure.
  const status = typeof error === "object" && error !== null && "status" in error ? (error as { status?: unknown }).status : undefined;
  if (status === 401 || status === 403) return { ok: false, error: { code: "authentication_failed", message: "Jev authentication failed." } };
  if (status === 402) return { ok: false, error: { code: "payment_required", message: "Jev provider requires payment for this account." } };
  // A configurable endpoint makes a wrong path a configuration error, not a malformed response.
  if (status === 404 || status === 405 || status === 410) return { ok: false, error: { code: "endpoint_unavailable", message: "Jev endpoint was not found; check SYSTEMONE_ENDPOINT." } };
  if (status === 408) return { ok: false, error: { code: "timeout", message: "Jev evaluation timed out.", retryable: true } };
  if (status === 429) return { ok: false, error: { code: "rate_limited", message: "Jev rate limit exceeded.", retryable: true } };
  if (typeof status === "number" && status >= 500) return { ok: false, error: { code: "service_unavailable", message: "Jev service is unavailable.", retryable: true } };
  if (typeof status === "number" && status >= 400) return { ok: false, error: { code: "invalid_request", message: `Jev rejected the evaluation request (HTTP ${status}).` } };
  if (error instanceof Error && (error.name === "APIConnectionError" || error.name === "APITimeoutError")) return { ok: false, error: { code: "service_unavailable", message: "Jev service is unavailable.", retryable: true } };
  return { ok: false, error: { code: "invalid_response", message: "Jev returned an invalid response." } };
}

export async function evaluateJev(state: McpExtensionState, value: JevEvaluateInput, options: { purpose: "script" | "semantic-search"; signal?: AbortSignal; budget?: JevBudget; observedSources?: readonly string[] }): Promise<JevEvaluationEnvelope> {
  let settings: ResolvedJevSettings;
  let input: JevEvaluateInput;
  try { settings = options.purpose === "semantic-search" ? resolveSemanticJevSettings(state) : validateJevSettings(state.config.settings?.jev); input = validateJevEvaluateInput(value, settings); }
  catch { return { ok: false, error: { code: "invalid_request", message: "Invalid Jev evaluation request or settings." } }; }
  if ((options.purpose === "script" && !settings.scriptEvaluation) || (options.purpose === "semantic-search" && !settings.semanticSearch)) return { ok: false, error: { code: "disabled", message: "Jev evaluation is disabled." } };
  const sources = new Set([...(input.sources ?? []), ...(options.observedSources ?? [])]);
  if (!areJevSourcesAllowed(state, settings, sources)) return { ok: false, error: { code: "data_policy_denied", message: "Evaluation sources are not allowed by policy." } };
  const bytes = Buffer.byteLength(JSON.stringify(input));
  if (options.budget && !options.budget.consume(bytes)) return { ok: false, error: { code: "budget_exhausted", message: "Jev evaluation budget exhausted." } };
  const resolved = getHost(state, settings);
  if (!("client" in resolved)) return resolved;
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; deadline.abort(new Error("Jev evaluation deadline exceeded")); }, settings.requestTimeoutMs);
  const signal = combineAbortSignals(options.signal, state.owner.signal, deadline.signal);
  try {
    const request = { state: input.state, questions: input.questions, model: settings.model };
    const raw = await resolved.client.systemOne(request as Parameters<TypeSafeClient["systemOne"]>[0], { ...(signal ? { signal } : {}), timeout: settings.requestTimeoutMs, retry: { maxRetries: settings.maxRetries } });
    try { return { ok: true, data: validateResponse(raw, input) }; }
    catch { return { ok: false, error: { code: "invalid_response", message: "Jev returned an invalid response." } }; }
  } catch (error) { return failure(error, signal, timedOut); }
  finally { clearTimeout(timer); }
}
