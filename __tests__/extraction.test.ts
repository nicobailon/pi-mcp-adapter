import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyExtraction, parseExtractFields, type ExtractField } from "../extraction.ts";
import { executeCall } from "../proxy-modes.ts";
import type { McpExtensionState } from "../state.ts";

describe("parseExtractFields", () => {
  it("maps each type the agent writes to the field Clairic receives", () => {
    expect(parseExtractFields({
      a: "text",
      b: "integer",
      c: "duration.minutes",
      d: { type: "duration", unit: "hours", decimals: 1 },
      e: { type: "number", description: "Order total", unit: "USD", decimals: 2 },
      f: "list.number",
      g: { type: "list", description: "Item names" },
      h: "datetime",
    })).toEqual({
      ok: true,
      fields: {
        a: { type: "text", spec: { type: "text", null_threshold: 0.5 } },
        b: { type: "integer", spec: { type: "number", integer: true, null_threshold: 0.5 } },
        c: { type: "duration.minutes", spec: { type: "duration", unit: "minutes", null_threshold: 0.5 } },
        d: { type: "duration", spec: { type: "duration", unit: "hours", decimals: 1, null_threshold: 0.5 } },
        e: { type: "number", spec: { type: "number", instructions: "Order total", unit: "USD", decimals: 2, null_threshold: 0.5 } },
        f: { type: "list.number", spec: { type: "list", items: "number" } },
        g: { type: "list", spec: { type: "list", items: "text", instructions: "Item names" } },
        h: { type: "datetime", spec: { type: "datetime", null_threshold: 0.5 } },
      },
    });
  });

  it.each([
    ["a non-object", [], "extract must be an object of field names to types"],
    ["no fields", {}, "extract needs 1 to 16 fields"],
    ["17 fields", Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, "text"])), "extract needs 1 to 16 fields"],
    ["a bad name", { "1st": "text" }, "field names must start with a letter or underscore and use only letters, digits, _, . or - (64 characters at most)"],
    ["an unknown type", { a: "colour" }, 'field "a" has an unknown type'],
    ["an unknown option", { a: { type: "text", format: "x" } }, 'field "a" has an unsupported option (use type, description, unit or decimals)'],
    ["unit on text", { a: { type: "text", unit: "USD" } }, 'field "a": unit applies only to number and duration fields'],
    ["a second duration unit", { a: { type: "duration.minutes", unit: "hours" } }, 'field "a": unit is already part of its type'],
    ["an unknown duration unit", { a: { type: "duration", unit: "fortnights" } }, 'field "a": a duration unit must be one of seconds, minutes, hours, days, weeks, months, years'],
    ["decimals on a date", { a: { type: "date", decimals: 2 } }, 'field "a": decimals applies only to number, duration and list.number fields'],
    ["decimals out of range", { a: { type: "number", decimals: 7 } }, 'field "a": decimals must be an integer from 0 to 6'],
  ])("refuses %s", (_label, value, message) => {
    expect(parseExtractFields(value)).toEqual({ ok: false, message });
  });
});

const SECRET = "sk-live-0123456789abcdef";
const URL = "https://api.cloudflare.com/client/v4/accounts/acct_1/ai/run/@cf/cloudflare/clairic";
const ORDER = "Order #B-1001 confirmed\nOrder total $42.10\nArrives Nov 2\nCarrier: maybe UPS";
const ANSWERS = {
  total: { type: "number", value: 42.1, confidence: 0.99, p_null: 0.01 },
  due: { type: "date", value: "2026-11-02", confidence: 0.98 },
  coupon: { type: "text", value: null, guess: "B-1001", confidence: 0.85, p_null: 0.99 },
  carrier: { type: "text", value: "UPS", confidence: 0.62 },
};

function fieldsOf(value: unknown): Record<string, ExtractField> {
  const parsed = parseExtractFields(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.fields;
}
const FIELDS = fieldsOf({ total: { type: "number", description: "Order total" }, due: "date", coupon: "text", carrier: "text" });

function createState(content: unknown[], options: { isError?: boolean; allowed?: string[]; owner?: AbortSignal; model?: string; extra?: Record<string, unknown> } = {}) {
  const callTool = vi.fn().mockResolvedValue({ content, ...(options.isError ? { isError: true } : {}), ...options.extra });
  const connection = { status: "connected", client: { callTool }, tools: [{ name: "get", description: "Get" }], resources: [], prompts: [] };
  return {
    config: { mcpServers: { demo: { command: "demo" } }, settings: { extraction: { allowedServers: options.allowed ?? ["demo"], ...(options.model ? { model: options.model } : {}) } } },
    toolMetadata: new Map([["demo", [{ name: "demo_get", originalName: "get", description: "Get" }]]]),
    resourceCounts: new Map(), promptMetadata: new Map(), promptMetadataLive: new Set(), serverInstructions: new Map(),
    approvedToolCalls: new Map(), approvalEvents: { emit: vi.fn() },
    manager: { getConnection: () => connection, getRequestOptions: () => undefined, touch: vi.fn(), incrementInFlight: vi.fn(), decrementInFlight: vi.fn() },
    failureTracker: new Map(), failureMessages: new Map(),
    ...(options.owner ? { owner: { signal: options.owner } } : {}),
  } as unknown as McpExtensionState;
}

const registry = (resolved: unknown = { auth: { apiKey: "cf-key" }, env: { CLOUDFLARE_ACCOUNT_ID: "acct_1" } }) => ({
  getProviderAuth: vi.fn(async () => { if (resolved instanceof Error) throw resolved; return resolved ?? undefined; }),
  getProviderAuthStatus: () => ({ configured: true }),
});

function clairic(respond: () => Response | Promise<Response>) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => respond());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });

async function callWithExtract(state: McpExtensionState, fields = FIELDS, modelRegistry: unknown = registry(), signal?: AbortSignal) {
  return applyExtraction(state, await executeCall(state, "demo_get", {}), fields, modelRegistry, signal);
}
const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(block => block.text ?? `[${block.type}]`).join("|");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("applyExtraction on the Workers AI route", () => {
  it("sends the text result, without images, with the field specs and the local date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 24, 12));
    const fetch = clairic(() => ok({ model: "clairic", answers: ANSWERS, truncated: false }));
    const state = createState([{ type: "text", text: ORDER }, { type: "image", data: "aGk=", mimeType: "image/png" }]);

    await callWithExtract(state);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer cf-key", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "clairic", state: ORDER, reference_date: "2026-10-24",
      fields: {
        total: { type: "number", instructions: "Order total", null_threshold: 0.5 },
        due: { type: "date", null_threshold: 0.5 },
        coupon: { type: "text", null_threshold: 0.5 },
        carrier: { type: "text", null_threshold: 0.5 },
      },
    });
  });

  it("returns only the values, withholding one below 0.80 as uncertain, and saves the full result", async () => {
    clairic(() => ok({ model: "clairic", answers: ANSWERS, truncated: false, usage: { input_tokens: 40, note: SECRET, ratio: Number.NaN } }));
    const result = await callWithExtract(createState([{ type: "text", text: ORDER }]));

    const text = JSON.parse(textOf(result));
    expect(text).toEqual({
      values: { total: 42.1, due: "2026-11-02", coupon: null, carrier: null },
      uncertain: { carrier: { guess: "UPS", confidence: 0.62 } },
      fullResult: expect.any(String),
    });
    expect(Object.keys(text)).toEqual(["values", "uncertain", "fullResult"]);
    expect(readFileSync(text.fullResult, "utf8")).toBe(ORDER);
    expect((result.details as any).extraction.usage).toEqual({ input_tokens: 40 });
    expect(result.details).toMatchObject({
      mode: "call", server: "demo", tool: "get", canonicalTool: "demo_get",
      extraction: {
        model: "cloudflare-workers-ai/clairic", status: "partial", fullResultPath: text.fullResult,
        fields: {
          total: { type: "number", status: "extracted", value: 42.1, confidence: 0.99, pNull: 0.01 },
          coupon: { type: "text", status: "null", value: null },
          carrier: { type: "text", status: "uncertain", value: null, guess: "UPS", confidence: 0.62 },
        },
      },
    });
  });

  it("sends the full text of a cut result, capped at 100 KiB, and points at the guard's file", async () => {
    const big = `${"x".repeat(150 * 1024)}\nOrder total $42.10`;
    const fetch = clairic(() => ok({ model: "clairic", answers: { total: ANSWERS.total }, truncated: false }));
    const result = await callWithExtract(createState([{ type: "text", text: big }]), fieldsOf({ total: "number" }));

    const sent = JSON.parse(fetch.mock.calls[0]![1].body as string).state as string;
    expect(sent).toBe(big.slice(0, 100 * 1024));
    const text = JSON.parse(textOf(result));
    expect(text).toMatchObject({ values: { total: 42.1 }, truncated: true });
    expect(readFileSync(text.fullResult, "utf8")).toBe(big);
    expect(text.fullResult).toBe((result.details as any).outputGuard.fullOutputPath);
  });

  it("never reads a file a server's result points at, even when it imitates the guard's spill summary", async () => {
    const secretFile = join(mkdtempSync(join(tmpdir(), "pi-mcp-forged-")), "secret.txt");
    // Shaped like a raw MCP result, so a reader that follows the path would parse it and send the secret.
    writeFileSync(secretFile, JSON.stringify({ content: [{ type: "text", text: SECRET }] }));
    const fetch = clairic(() => ok({ answers: { total: ANSWERS.total }, truncated: false }));
    const state = createState([{ type: "text", text: ORDER }], { extra: { omitted: true, rawResultBytes: 1, fullResultPath: secretFile } });

    const result = await callWithExtract(state, fieldsOf({ total: "number" }));

    expect(JSON.parse(fetch.mock.calls[0]![1].body as string).state).toBe(ORDER);
    const saved = readFileSync(JSON.parse(textOf(result)).fullResult, "utf8");
    expect(saved).toBe(ORDER);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    ["a server outside the allowlist", createState([{ type: "text", text: ORDER }], { allowed: ["other"] }), 'Extraction skipped: server "demo" is not in settings.extraction.allowedServers.', "server_not_allowed"],
    ["a tool error", createState([{ type: "text", text: "boom" }], { isError: true }), "Extraction skipped: the tool returned an error.", "tool_error"],
    ["an image-only result", createState([{ type: "image", data: "aGk=", mimeType: "image/png" }]), "Extraction skipped: the result has no text.", "no_text"],
    ["an empty result", createState([]), "Extraction skipped: the result has no text.", "no_text"],
  ])("sends nothing for %s and keeps the call's result after one line", async (_label, state, line, code) => {
    const fetch = clairic(() => ok({}));
    const plain = await executeCall(state, "demo_get", {});
    const result = await applyExtraction(state, plain, FIELDS, registry());

    expect(fetch).not.toHaveBeenCalled();
    expect(textOf(result)).toBe(plain.content[0]!.type === "text" ? `${line}\n\n${textOf(plain)}` : `${line}|${textOf(plain)}`);
    expect(result.details).toEqual({ ...plain.details, extraction: { status: "skipped", error: { code, message: expect.any(String) } } });
  });

  it("sends nothing for a background task or a failed call", async () => {
    const fetch = clairic(() => ok({}));
    const state = createState([]);
    const task = { content: [{ type: "text" as const, text: "Running as task demo/t1" }], details: { mode: "call", server: "demo", task: { key: "demo/t1" } } };
    const failed = { content: [{ type: "text" as const, text: "Tool not found" }], details: { mode: "call", error: "tool_not_found" } };

    expect(textOf(await applyExtraction(state, task, FIELDS, registry()))).toBe("Extraction skipped: the call runs as a background task.\n\nRunning as task demo/t1");
    const failedResult = await applyExtraction(state, failed, FIELDS, registry());
    expect(failedResult.content).toEqual(failed.content);
    expect(failedResult.details).toMatchObject({ error: "tool_not_found", extraction: { status: "skipped", error: { code: "call_failed" } } });
    expect(fetch).not.toHaveBeenCalled();
  });

  const withBody = (status: number, body = `{"errors":[{"message":"${SECRET}"}]}`) => () => new Response(body, { status });
  it.each([
    ["HTTP 401", withBody(401), "authentication_failed", "cloudflare-workers-ai rejected the credential."],
    ["HTTP 403", withBody(403), "authentication_failed", "cloudflare-workers-ai rejected the credential."],
    ["HTTP 402", withBody(402), "payment_required", "cloudflare-workers-ai requires payment for this account."],
    ["HTTP 408", withBody(408), "timeout", "cloudflare-workers-ai/clairic timed out."],
    ["HTTP 429", withBody(429), "rate_limited", "cloudflare-workers-ai/clairic is rate limited."],
    ["HTTP 503", withBody(503), "service_unavailable", "cloudflare-workers-ai/clairic is unavailable."],
    ["HTTP 418", withBody(418), "provider_error", "cloudflare-workers-ai/clairic failed (HTTP 418)."],
    ["a network error", () => { throw new TypeError(`connect ECONNREFUSED ${SECRET}`); }, "unavailable", "cloudflare-workers-ai/clairic could not be reached."],
    ["a non-JSON body", withBody(200, `<html>${SECRET}</html>`), "invalid_response", "cloudflare-workers-ai/clairic returned an invalid answer."],
    ["success: false", withBody(200, JSON.stringify({ success: false, errors: [SECRET] })), "invalid_response", "cloudflare-workers-ai/clairic returned an invalid answer."],
    ["a missing field", () => ok({ answers: { total: ANSWERS.total }, note: SECRET }), "invalid_response", "cloudflare-workers-ai/clairic returned an invalid answer."],
    ["a value of the wrong type", () => ok({ answers: { ...ANSWERS, total: { type: "number", value: SECRET, confidence: 0.99 } } }), "invalid_response", "cloudflare-workers-ai/clairic returned an invalid answer."],
  ])("maps %s to its code without the provider's text", async (_label, respond, code, message) => {
    clairic(respond);
    const result = await callWithExtract(createState([{ type: "text", text: ORDER }]));

    expect(textOf(result)).toBe(`Extraction failed (${code}): ${message}\n\n${ORDER}`);
    expect(result.details).toMatchObject({ extraction: { model: "cloudflare-workers-ai/clairic", status: "failed", error: { code, message } } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("times out after 5 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    const pending = callWithExtract(createState([{ type: "text", text: ORDER }]));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(textOf(await pending)).toBe(`Extraction failed (timeout): cloudflare-workers-ai/clairic timed out.\n\n${ORDER}`);
  });

  it.each([
    ["no registry", null, "unavailable", "Extraction needs Pi's model registry (Pi 0.99 or later)."],
    ["no credential", registry(null), "no_credentials", "cloudflare-workers-ai has no complete credential in Pi (key and account id)."],
    ["a credential lookup that throws", registry(new Error(SECRET)), "no_credentials", "cloudflare-workers-ai has no complete credential in Pi (key and account id)."],
    ["an account id that is not an id", registry({ auth: { apiKey: "k" }, env: { CLOUDFLARE_ACCOUNT_ID: "a/../b" } }), "no_credentials", "cloudflare-workers-ai has no complete credential in Pi (key and account id)."],
  ])("sends nothing with %s", async (_label, modelRegistry, code, message) => {
    const fetch = clairic(() => ok({}));
    const result = await callWithExtract(createState([{ type: "text", text: ORDER }]), FIELDS, modelRegistry);

    expect(fetch).not.toHaveBeenCalled();
    expect(textOf(result)).toBe(`Extraction failed (${code}): ${message}\n\n${ORDER}`);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("rejects the call when the runtime stops during the request", async () => {
    const owner = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      owner.abort(new Error("MCP extension session restarted"));
    })));
    const state = createState([{ type: "text", text: ORDER }], { owner: owner.signal });
    const plain = await executeCall(state, "demo_get", {});

    await expect(applyExtraction(state, plain, FIELDS, registry())).rejects.toThrow("MCP extension session restarted");
  });
});

describe("applyExtraction routes", () => {
  const GATEWAY_AUTH = {
    auth: { headers: { "cf-aig-authorization": "Bearer gw-key", Authorization: null, "x-api-key": null } },
    env: { CLOUDFLARE_ACCOUNT_ID: "acct_1", CLOUDFLARE_GATEWAY_ID: "gw_1" },
  };
  const WORKERS_AUTH = { auth: { apiKey: "cf-key" }, env: { CLOUDFLARE_ACCOUNT_ID: "acct_1" } };
  const routedRegistry = (configured: string[]) => ({
    getProviderAuth: vi.fn(async (provider: string) => provider === "cloudflare-ai-gateway" ? GATEWAY_AUTH : WORKERS_AUTH),
    getProviderAuthStatus: (provider: string) => ({ configured: configured.includes(provider) }),
  });
  const GATEWAY_URL = "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/workers-ai/@cf/cloudflare/clairic";
  const answered = () => clairic(() => ok({ answers: { total: ANSWERS.total }, truncated: false }));

  it("sends to the AI Gateway with Pi's cf-aig-authorization and no Authorization header", async () => {
    const fetch = answered();
    const modelRegistry = routedRegistry([]);
    const result = await callWithExtract(createState([{ type: "text", text: ORDER }], { model: "cloudflare-ai-gateway/clairic" }), fieldsOf({ total: "number" }), modelRegistry);

    expect(modelRegistry.getProviderAuth).toHaveBeenCalledWith("cloudflare-ai-gateway");
    expect(fetch.mock.calls[0]![0]).toBe(GATEWAY_URL);
    expect(fetch.mock.calls[0]![1].headers).toEqual({ "cf-aig-authorization": "Bearer gw-key", "Content-Type": "application/json" });
    expect(result.details).toMatchObject({ extraction: { model: "cloudflare-ai-gateway/clairic", status: "extracted" } });
  });

  it.each([
    [["cloudflare-workers-ai", "cloudflare-ai-gateway"], URL],
    [["cloudflare-ai-gateway"], GATEWAY_URL],
  ])("without a model, uses Workers AI, then the gateway, by Pi's credentials (%j)", async (configured, url) => {
    const fetch = answered();
    await callWithExtract(createState([{ type: "text", text: ORDER }]), fieldsOf({ total: "number" }), routedRegistry(configured));
    expect(fetch.mock.calls[0]![0]).toBe(url);
  });

  it.each([
    ["no Cloudflare credential", routedRegistry([]), undefined, "Extraction needs Cloudflare credentials in Pi: CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID, or the cloudflare-workers-ai login."],
    ["a gateway id that is not an id", { getProviderAuth: async () => ({ ...GATEWAY_AUTH, env: { ...GATEWAY_AUTH.env, CLOUDFLARE_GATEWAY_ID: "gw/../x" } }), getProviderAuthStatus: () => ({ configured: true }) },
      "cloudflare-ai-gateway/clairic", "cloudflare-ai-gateway has no complete credential in Pi (key and account id, gateway id)."],
  ])("sends nothing with %s", async (_label, modelRegistry, model, message) => {
    const fetch = answered();
    const result = await callWithExtract(createState([{ type: "text", text: ORDER }], model ? { model } : {}), fieldsOf({ total: "number" }), modelRegistry);

    expect(fetch).not.toHaveBeenCalled();
    expect(textOf(result)).toBe(`Extraction failed (no_credentials): ${message}\n\n${ORDER}`);
  });
});
