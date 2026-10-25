import { readFile } from "node:fs/promises";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { throwIfAborted } from "./abort.ts";
import { validateExtractionSettings, type ExtractionModelId } from "./extraction-settings.ts";
import { saveMcpOutputText } from "./mcp-output-guard.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { McpExtensionState } from "./state.ts";

/** A field as Clairic receives it in the request's `fields` map. */
export interface ClairicFieldSpec {
  type: "text" | "number" | "date" | "time" | "datetime" | "duration" | "list";
  instructions?: string;
  unit?: string;
  integer?: true;
  decimals?: number;
  items?: "text" | "number" | "date";
  null_threshold?: number;
}

/** A requested field: the type the agent wrote and the spec sent for it. */
export interface ExtractField {
  type: string;
  spec: ClairicFieldSpec;
}

export type ParsedExtractFields =
  | { ok: true; fields: Record<string, ExtractField> }
  | { ok: false; message: string };

const MAX_FIELDS = 16;
const NULL_THRESHOLD = 0.5;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const DURATION_UNITS = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"];
const FIELD_TYPES: Record<string, ClairicFieldSpec> = {
  text: { type: "text" },
  number: { type: "number" },
  integer: { type: "number", integer: true },
  date: { type: "date" },
  time: { type: "time" },
  datetime: { type: "datetime" },
  duration: { type: "duration" },
  ...Object.fromEntries(DURATION_UNITS.map((unit) => [`duration.${unit}`, { type: "duration" as const, unit }])),
  list: { type: "list", items: "text" },
  "list.number": { type: "list", items: "number" },
  "list.date": { type: "list", items: "date" },
};
const OBJECT_KEYS = new Set(["type", "description", "unit", "decimals"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseField(name: string, value: unknown): ExtractField | string {
  const label = `field "${name}"`;
  const written = typeof value === "string" ? { type: value } : value;
  if (!isPlainObject(written)) return `${label} must be a type name or an object with a type`;
  const extra = Object.keys(written).find((key) => !OBJECT_KEYS.has(key));
  if (extra !== undefined) return `${label} has an unsupported option (use type, description, unit or decimals)`;
  const { type, description, unit, decimals } = written;
  if (typeof type !== "string" || !Object.hasOwn(FIELD_TYPES, type)) return `${label} has an unknown type`;
  const spec: ClairicFieldSpec = { ...FIELD_TYPES[type]! };
  if (description !== undefined) {
    if (typeof description !== "string" || description.trim().length === 0) return `${label}: description must be a nonblank string`;
    spec.instructions = description;
  }
  if (unit !== undefined) {
    if (spec.type === "duration") {
      if (spec.unit !== undefined) return `${label}: unit is already part of its type`;
      if (typeof unit !== "string" || !DURATION_UNITS.includes(unit)) return `${label}: a duration unit must be one of ${DURATION_UNITS.join(", ")}`;
    } else if (spec.type !== "number") {
      return `${label}: unit applies only to number and duration fields`;
    } else if (typeof unit !== "string" || unit.trim().length === 0) {
      return `${label}: unit must be a nonblank string`;
    }
    spec.unit = unit;
  }
  if (decimals !== undefined) {
    const allowed = type === "number" || spec.type === "duration" || type === "list.number";
    if (!allowed) return `${label}: decimals applies only to number, duration and list.number fields`;
    if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 6) return `${label}: decimals must be an integer from 0 to 6`;
    spec.decimals = decimals as number;
  }
  if (spec.type !== "list") spec.null_threshold = NULL_THRESHOLD;
  return { type, spec };
}

/** Checks what the agent wrote for `extract` and maps it to Clairic field specs. Reasons are adapter-written. */
export function parseExtractFields(value: unknown): ParsedExtractFields {
  if (!isPlainObject(value)) return { ok: false, message: "extract must be an object of field names to types" };
  const names = Object.keys(value);
  if (names.length === 0 || names.length > MAX_FIELDS) return { ok: false, message: `extract needs 1 to ${MAX_FIELDS} fields` };
  const fields: Record<string, ExtractField> = {};
  for (const name of names) {
    if (!FIELD_NAME.test(name) || name === "__proto__") {
      return { ok: false, message: "field names must start with a letter or underscore and use only letters, digits, _, . or - (64 characters at most)" };
    }
    const field = parseField(name, value[name]);
    if (typeof field === "string") return { ok: false, message: field };
    fields[name] = field;
  }
  return { ok: true, fields };
}

type ToolResult = AgentToolResult<Record<string, unknown>>;
type ContentBlock = ToolResult["content"][number];

/** The part of Pi's ModelRegistry extraction uses. `ctx.modelRegistry` satisfies it on Pi >= 0.99. */
export interface ExtractionRegistry {
  getProviderAuth(provider: string): Promise<unknown>;
  getProviderAuthStatus(provider: string): { configured: boolean };
}

export function extractionRegistryOf(value: unknown): ExtractionRegistry | undefined {
  const registry = value as Partial<ExtractionRegistry> | undefined;
  return typeof registry?.getProviderAuth === "function" && typeof registry.getProviderAuthStatus === "function"
    ? registry as ExtractionRegistry
    : undefined;
}

interface ExtractionError { code: string; message: string }
class ExtractionFailure extends Error {
  constructor(readonly failure: ExtractionError) { super(failure.message); }
}
const fail = (code: string, message: string): never => { throw new ExtractionFailure({ code, message }); };

const EXTRACT_MAX_BYTES = 100 * 1024;
const EXTRACT_THRESHOLD = 0.8;
const REQUEST_TIMEOUT_MS = 5_000;
const CLOUDFLARE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WORKERS_AI = "cloudflare-workers-ai";
const VALUE_PATTERNS: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}(:\d{2})?$/,
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
};

interface Route { model: ExtractionModelId; provider: string; url: string; headers: Record<string, string> }

async function resolveRoute(registry: ExtractionRegistry, configured: ExtractionModelId | undefined): Promise<Route> {
  const model = configured ?? "cloudflare-workers-ai/clairic";
  if (model !== "cloudflare-workers-ai/clairic") fail("unavailable", `${model} is not supported yet.`);
  let resolved: unknown;
  try {
    resolved = await registry.getProviderAuth(WORKERS_AI);
  } catch {
    resolved = undefined;
  }
  const { auth, env } = (resolved ?? {}) as { auth?: { apiKey?: unknown }; env?: Record<string, unknown> };
  const apiKey = typeof auth?.apiKey === "string" ? auth.apiKey.trim() : "";
  const account = env?.CLOUDFLARE_ACCOUNT_ID;
  if (!apiKey || typeof account !== "string" || !CLOUDFLARE_ID.test(account)) {
    fail("no_credentials", `${WORKERS_AI} has no complete credential in Pi (key and account id).`);
  }
  return {
    model, provider: WORKERS_AI,
    url: `https://api.cloudflare.com/client/v4/accounts/${account as string}/ai/run/@cf/cloudflare/clairic`,
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validValue(spec: ClairicFieldSpec, value: unknown): boolean {
  if (spec.type === "list") return Array.isArray(value) && value.every(item => validValue({ type: spec.items ?? "text" }, item));
  if (spec.type === "text") return typeof value === "string";
  if (spec.type === "number" || spec.type === "duration") {
    return typeof value === "number" && Number.isFinite(value) && (!spec.integer || Number.isInteger(value));
  }
  return typeof value === "string" && VALUE_PATTERNS[spec.type]!.test(value);
}

interface FieldResult { type: string; status: "extracted" | "null" | "uncertain"; value: unknown; guess?: unknown; confidence?: number; pNull?: number }

function readAnswers(fields: Record<string, ExtractField>, body: unknown, model: string): { fields: Record<string, FieldResult>; truncated: boolean; usage?: unknown } {
  const invalid = () => fail("invalid_response", `${model} returned an invalid answer.`);
  const envelope = body as { success?: unknown; result?: unknown } | null;
  const result = envelope?.success === true ? envelope.result as { answers?: unknown; truncated?: unknown; usage?: unknown } : undefined;
  if (!result || typeof result !== "object" || Array.isArray(result)) return invalid();
  const answers = result.answers as Record<string, unknown> | undefined;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return invalid();
  const names = Object.keys(fields);
  if (Object.keys(answers).length !== names.length || names.some(name => !Object.hasOwn(answers, name))) return invalid();
  if (result.truncated !== undefined && typeof result.truncated !== "boolean") return invalid();
  const out: Record<string, FieldResult> = {};
  for (const name of names) {
    const { type, spec } = fields[name]!;
    const answer = answers[name] as { type?: unknown; value?: unknown; confidence?: unknown; p_null?: unknown } | null;
    if (!answer || typeof answer !== "object" || answer.type !== spec.type) return invalid();
    const { value, confidence, p_null: pNull } = answer;
    if ((value !== null && !validValue(spec, value)) || (confidence !== undefined && !isProbability(confidence)) || (pNull !== undefined && !isProbability(pNull))) {
      return invalid();
    }
    const scores = { ...(confidence !== undefined ? { confidence } : {}), ...(pNull !== undefined ? { pNull } : {}) };
    if (value === null || (Array.isArray(value) && value.length === 0)) out[name] = { type, status: "null", value: null, ...scores };
    else if (typeof confidence === "number" && confidence >= EXTRACT_THRESHOLD) out[name] = { type, status: "extracted", value, ...scores };
    else out[name] = { type, status: "uncertain", value: null, guess: value, ...scores };
  }
  return { fields: out, truncated: result.truncated === true, ...(result.usage !== undefined ? { usage: result.usage } : {}) };
}

async function sendToClairic(route: Route, text: string, fields: Record<string, ExtractField>, referenceDate: string, ownedSignal: AbortSignal | undefined) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    let response: Response;
    let body: string;
    try {
      response = await fetch(route.url, {
        method: "POST",
        headers: { ...route.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "clairic", state: text, fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.spec])), reference_date: referenceDate }),
        signal: combineAbortSignals(ownedSignal, timeout.signal) ?? timeout.signal,
      });
      body = await response.text();
    } catch {
      throwIfAborted(ownedSignal);
      return fail(timeout.signal.aborted ? "timeout" : "unavailable", timeout.signal.aborted ? `${route.model} timed out.` : `${route.model} could not be reached.`);
    }
    const status = response.status;
    if (status === 401 || status === 403) fail("authentication_failed", `${route.provider} rejected the credential.`);
    if (status === 402) fail("payment_required", `${route.provider} requires payment for this account.`);
    if (status === 408) fail("timeout", `${route.model} timed out.`);
    if (status === 429) fail("rate_limited", `${route.model} is rate limited.`);
    if (status >= 500) fail("service_unavailable", `${route.model} is unavailable.`);
    if (!response.ok) fail("provider_error", `${route.model} failed (HTTP ${status}).`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fail("invalid_response", `${route.model} returned an invalid answer.`);
    }
    return { ...readAnswers(fields, parsed, route.model), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function cutUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), cut: true };
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The call's own result with one line first: skipped or failed extraction never loses the tool result. */
function withLine(result: ToolResult, line: string | undefined, extraction: Record<string, unknown>): ToolResult {
  const details = { ...(result.details ?? {}), extraction };
  if (line === undefined) return { ...result, details };
  const [first, ...rest] = result.content;
  const content: ContentBlock[] = first?.type === "text"
    ? [{ ...first, text: `${line}\n\n${first.text}` }, ...rest]
    : [{ type: "text", text: line }, ...result.content];
  return { ...result, content, details };
}

/**
 * Runs after a proxy call with `extract`: sends the call's text result to the extraction model and
 * returns only the requested values, or the call's own result with a reason when nothing can be sent.
 */
export async function applyExtraction(
  state: McpExtensionState,
  result: ToolResult,
  fields: Record<string, ExtractField>,
  modelRegistry: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const details = (result.details ?? {}) as { error?: unknown; task?: unknown; server?: unknown; outputGuard?: { fullOutputPath?: string; truncated?: boolean } };
  const skip = (code: string, message: string, line?: string) => withLine(result, line, { status: "skipped", error: { code, message } });
  if (details.error !== undefined && details.error !== "tool_error") return skip("call_failed", "The call failed, so nothing was sent.");
  if (details.error === "tool_error") return skip("tool_error", "The tool returned an error.", "Extraction skipped: the tool returned an error.");
  if (details.task !== undefined) return skip("background_task", "The call runs as a background task.", "Extraction skipped: the call runs as a background task.");
  const settings = validateExtractionSettings(state.config.settings?.extraction);
  const server = typeof details.server === "string" ? details.server : undefined;
  if (!settings.enabled || server === undefined || !settings.allowedServers.includes(server)) {
    const line = `Extraction skipped: server "${server ?? "unknown"}" is not in settings.extraction.allowedServers.`;
    return skip("server_not_allowed", line.slice("Extraction skipped: ".length), line);
  }
  const preview = result.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n");
  const fullPath = details.outputGuard?.fullOutputPath;
  let source = preview;
  let truncated = details.outputGuard?.truncated === true && fullPath === undefined;
  if (fullPath !== undefined) {
    try {
      source = await readFile(fullPath, "utf8");
    } catch {
      truncated = true;
    }
  }
  if (source.trim().length === 0) return skip("no_text", "The result has no text.", "Extraction skipped: the result has no text.");

  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  const referenceDate = localDate(new Date());
  let model: ExtractionModelId | undefined;
  try {
    const registry = extractionRegistryOf(modelRegistry) ?? fail("unavailable", "Extraction needs Pi's model registry (Pi 0.99 or later).");
    const route = await resolveRoute(registry, settings.model);
    model = route.model;
    const sent = cutUtf8(source, EXTRACT_MAX_BYTES);
    const answer = await sendToClairic(route, sent.text, fields, referenceDate, ownedSignal);
    truncated ||= sent.cut || answer.truncated;
    const saved = fullPath !== undefined ? { path: fullPath } : await saveMcpOutputText(source);
    const values = Object.fromEntries(Object.entries(answer.fields).map(([name, field]) => [name, field.value]));
    const uncertainEntries = Object.entries(answer.fields).filter(([, field]) => field.status === "uncertain");
    const uncertain = Object.fromEntries(uncertainEntries.map(([name, field]) => [name, {
      ...(field.guess !== undefined ? { guess: field.guess } : {}),
      ...(field.confidence !== undefined ? { confidence: field.confidence } : {}),
    }]));
    const text = JSON.stringify({
      values,
      ...(uncertainEntries.length > 0 ? { uncertain } : {}),
      ...(truncated ? { truncated: true } : {}),
      fullResult: saved.path ?? null,
    });
    const status = uncertainEntries.length === 0 ? "extracted" : uncertainEntries.length === Object.keys(fields).length ? "uncertain" : "partial";
    return {
      content: [{ type: "text", text }],
      details: {
        ...details,
        extraction: {
          model, status, fields: answer.fields,
          ...(saved.path !== undefined ? { fullResultPath: saved.path } : { fullResultError: saved.error }),
          ...(truncated ? { truncated: true } : {}),
          referenceDate, latencyMs: answer.latencyMs,
          ...(answer.usage !== undefined ? { usage: answer.usage } : {}),
        },
      },
    };
  } catch (error) {
    if (!(error instanceof ExtractionFailure)) throw error;
    const { code, message } = error.failure;
    return withLine(result, `Extraction failed (${code}): ${message}`, { ...(model ? { model } : {}), status: "failed", error: { code, message } });
  }
}
