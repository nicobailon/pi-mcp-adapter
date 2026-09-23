import { createSecureKeyringStore, type SecureKeyringStore } from "./secure-keyring.ts";

/** The Jev decisions endpoint used when `SYSTEMONE_ENDPOINT` is not set. */
export const JEV_DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const SYSTEMONE_ENDPOINT_ENV = "SYSTEMONE_ENDPOINT";
const SYSTEMONE_API_KEY_ENV = "SYSTEMONE_API_KEY";
/** TypeSafe-issued key: honored only for the default endpoint and never sent anywhere else. */
const LEGACY_TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
/** Origin recorded in version 1 credential records. */
export const TYPESAFE_API_ORIGIN = "https://api.typesafe.ai";
/** Version 1 credential account, still read for the default endpoint. */
export const JEV_KEYRING_ACCOUNT = "typesafe@sha256(https://api.typesafe.ai)";
export const JEV_KEYRING_SERVICE = "pi-mcp-adapter.service-key";

const MAX_ENDPOINT_LENGTH = 512;
/** The path `@typesafe-ai/sdk` appends to whatever base URL it is given. */
export const JEV_SDK_PATH = "/v1/systemone";

export interface ResolvedJevEndpoint {
  /** Canonical absolute URL sent to the provider, for example `https://opencode.ai/zen/v1/systemone`. */
  readonly href: string;
  /** URL origin, used as the SDK base URL. */
  readonly origin: string;
  /** URL path, rewritten onto the SDK's fixed path by the pinned fetch. */
  readonly path: string;
}

export type JevEndpointResolution =
  | { status: "resolved"; source: "environment" | "default"; endpoint: ResolvedJevEndpoint }
  | { status: "unavailable"; message: string };

interface StoredJevKey {
  version: 2;
  endpoint: string;
  apiKey: string;
}

export class JevCredentialStoreError extends Error {
  readonly code = "JEV_CREDENTIAL_STORE_UNAVAILABLE";
  constructor(readonly operation: "read" | "write" | "remove", cause: unknown) {
    super(`Jev API key secure credential store unavailable during ${operation}. Configure or unlock the OS credential store and retry.`, { cause });
    this.name = "JevCredentialStoreError";
  }
}

export type JevCredentialResolution =
  | { status: "present"; source: "environment" | "keyring"; apiKey: string }
  | { status: "missing" }
  | { status: "unavailable"; message: string };

function validateApiKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Jev API key must be a non-empty string without control characters");
  }
  return value;
}

/**
 * Constrains the operator-supplied endpoint to an absolute HTTPS URL without credentials, query, or fragment, so
 * the pinned fetch can match it exactly and a stray value cannot redirect requests or smuggle a query string.
 */
function parseEndpoint(raw: string, label: string): ResolvedJevEndpoint {
  if (typeof raw !== "string" || raw.trim().length === 0) throw new Error(`${label} must be a non-empty URL`);
  if (raw.length > MAX_ENDPOINT_LENGTH) throw new Error(`${label} must be at most ${MAX_ENDPOINT_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) throw new Error(`${label} must not contain whitespace or control characters`);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`${label} must be an absolute URL`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use https`);
  if (url.username !== "" || url.password !== "") throw new Error(`${label} must not embed credentials`);
  if (url.search !== "") throw new Error(`${label} must not include a query string`);
  if (url.hash !== "") throw new Error(`${label} must not include a fragment`);
  if (url.pathname === "" || url.pathname === "/") throw new Error(`${label} must include a path such as ${JEV_SDK_PATH}`);
  return { href: `${url.origin}${url.pathname}`, origin: url.origin, path: url.pathname };
}

/**
 * Resolves the Jev endpoint. An invalid `SYSTEMONE_ENDPOINT` resolves to `unavailable` instead of silently falling
 * back to the default: sending an operator's judgment payload to a provider they did not ask for would be a data leak.
 */
export function resolveJevEndpoint(env: NodeJS.ProcessEnv = process.env): JevEndpointResolution {
  if (Object.hasOwn(env, SYSTEMONE_ENDPOINT_ENV)) {
    try { return { status: "resolved", source: "environment", endpoint: parseEndpoint(env[SYSTEMONE_ENDPOINT_ENV] as string, SYSTEMONE_ENDPOINT_ENV) }; }
    catch (error) { return { status: "unavailable", message: error instanceof Error ? error.message : `${SYSTEMONE_ENDPOINT_ENV} is invalid.` }; }
  }
  return { status: "resolved", source: "default", endpoint: parseEndpoint(JEV_DEFAULT_ENDPOINT, "the default Jev endpoint") };
}

/** Keyring account for an endpoint, so keys for different providers coexist instead of overwriting each other. */
export function jevKeyringAccount(endpoint: ResolvedJevEndpoint): string {
  return `systemone@sha256(${endpoint.href})`;
}

function store(): SecureKeyringStore {
  return createSecureKeyringStore(JEV_KEYRING_SERVICE);
}

function requireEndpoint(endpoint: ResolvedJevEndpoint | undefined): ResolvedJevEndpoint {
  if (endpoint) return endpoint;
  const resolution = resolveJevEndpoint();
  if (resolution.status === "unavailable") throw new Error(resolution.message);
  return resolution.endpoint;
}

/**
 * Version 1 records were written before the endpoint was configurable, so they are accepted only for the default
 * endpoint.
 */
function parseStoredKey(payload: string, endpoint: ResolvedJevEndpoint): string {
  let value: unknown;
  try { value = JSON.parse(payload); }
  catch { throw new Error("invalid record"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid record");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.version === 2) {
    if (keys.length !== 3 || !["version", "endpoint", "apiKey"].every(key => Object.hasOwn(record, key))) throw new Error("invalid record fields");
    if (record.endpoint !== endpoint.href) throw new Error("invalid or mismatched record");
    return validateApiKey(record.apiKey);
  }
  if (record.version === 1) {
    if (keys.length !== 4 || !["version", "provider", "origin", "apiKey"].every(key => Object.hasOwn(record, key))) throw new Error("invalid record fields");
    if (record.provider !== "typesafe" || record.origin !== TYPESAFE_API_ORIGIN) throw new Error("invalid or mismatched record");
    if (endpoint.href !== JEV_DEFAULT_ENDPOINT) throw new Error("invalid or mismatched record");
    return validateApiKey(record.apiKey);
  }
  throw new Error("invalid record version");
}

function readStoredKey(secretStore: SecureKeyringStore, endpoint: ResolvedJevEndpoint): string | undefined {
  try {
    let payload = secretStore.read(jevKeyringAccount(endpoint));
    if (payload === undefined && endpoint.href === JEV_DEFAULT_ENDPOINT) payload = secretStore.read(JEV_KEYRING_ACCOUNT);
    return payload === undefined ? undefined : parseStoredKey(payload, endpoint);
  } catch (error) {
    throw new JevCredentialStoreError("read", error);
  }
}

export function resolveJevCredential(
  env: NodeJS.ProcessEnv = process.env,
  endpoint?: ResolvedJevEndpoint,
  secretStore: SecureKeyringStore = store(),
): JevCredentialResolution {
  let target: ResolvedJevEndpoint;
  if (endpoint) target = endpoint;
  else {
    const resolution = resolveJevEndpoint(env);
    if (resolution.status === "unavailable") return resolution;
    target = resolution.endpoint;
  }
  if (Object.hasOwn(env, SYSTEMONE_API_KEY_ENV)) {
    try { return { status: "present", source: "environment", apiKey: validateApiKey(env[SYSTEMONE_API_KEY_ENV]) }; }
    catch { return { status: "unavailable", message: `${SYSTEMONE_API_KEY_ENV} is present but invalid.` }; }
  }
  const legacySet = Object.hasOwn(env, LEGACY_TYPESAFE_API_KEY_ENV);
  if (legacySet && target.href === JEV_DEFAULT_ENDPOINT) {
    try { return { status: "present", source: "environment", apiKey: validateApiKey(env[LEGACY_TYPESAFE_API_KEY_ENV]) }; }
    catch { return { status: "unavailable", message: `${LEGACY_TYPESAFE_API_KEY_ENV} is present but invalid.` }; }
  }
  let stored: string | undefined;
  try { stored = readStoredKey(secretStore, target); }
  catch (error) {
    if (!(error instanceof JevCredentialStoreError)) throw error;
    return { status: "unavailable", message: error.message };
  }
  if (stored !== undefined) return { status: "present", source: "keyring", apiKey: stored };
  // A TypeSafe-issued credential is never sent to another endpoint, but it must not mask a credential stored for
  // this endpoint either, so it is only reported once nothing for this endpoint resolves.
  if (legacySet) {
    return {
      status: "unavailable",
      message: `${LEGACY_TYPESAFE_API_KEY_ENV} is a TypeSafe credential and is not sent to ${target.href}; set ${SYSTEMONE_API_KEY_ENV} for that endpoint.`,
    };
  }
  return { status: "missing" };
}

export function saveJevApiKey(apiKey: string, endpoint?: ResolvedJevEndpoint, secretStore: SecureKeyringStore = store()): void {
  const target = requireEndpoint(endpoint);
  const record: StoredJevKey = { version: 2, endpoint: target.href, apiKey: validateApiKey(apiKey) };
  try { secretStore.write(jevKeyringAccount(target), JSON.stringify(record)); }
  catch (error) { throw new JevCredentialStoreError("write", error); }
}

export function removeJevApiKey(endpoint?: ResolvedJevEndpoint, secretStore: SecureKeyringStore = store()): void {
  const target = requireEndpoint(endpoint);
  try {
    secretStore.remove(jevKeyringAccount(target));
    if (target.href === JEV_DEFAULT_ENDPOINT) secretStore.remove(JEV_KEYRING_ACCOUNT);
  } catch (error) { throw new JevCredentialStoreError("remove", error); }
}
