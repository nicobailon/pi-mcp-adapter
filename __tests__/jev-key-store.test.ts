import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTestSecureKeyringReadCount, resetTestSecureKeyring, setTestSecureKeyringEntry } from "../secure-keyring.ts";
import {
  JEV_KEYRING_ACCOUNT,
  JEV_KEYRING_SERVICE,
  TYPESAFE_API_ORIGIN,
  jevKeyringAccount,
  removeJevApiKey,
  resolveJevCredential,
  resolveJevEndpoint,
  saveJevApiKey,
  type ResolvedJevEndpoint,
} from "../jev-key-store.ts";

const OPENCODE_ENDPOINT = "https://opencode.ai/zen/v1/systemone";

function endpointOf(href: string): ResolvedJevEndpoint {
  const resolution = resolveJevEndpoint({ SYSTEMONE_ENDPOINT: href } as NodeJS.ProcessEnv);
  if (resolution.status !== "resolved") throw new Error(resolution.message);
  return resolution.endpoint;
}

describe("System One endpoint and credential storage", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory";
    delete process.env.SYSTEMONE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.SYSTEMONE_ENDPOINT;
    resetTestSecureKeyring();
  });

  it("round trips only through the OS-keyring abstraction", () => {
    saveJevApiKey("secret-value");
    expect(resolveJevCredential()).toEqual({ status: "present", source: "keyring", apiKey: "secret-value" });
    removeJevApiKey();
    expect(resolveJevCredential()).toEqual({ status: "missing" });
  });

  it("defaults to the TypeSafe endpoint", () => {
    expect(resolveJevEndpoint()).toEqual({
      status: "resolved",
      source: "default",
      endpoint: { href: "https://api.typesafe.ai/v1/systemone", origin: "https://api.typesafe.ai", path: "/v1/systemone" },
    });
  });

  it("uses an explicit environment override without touching keyring", () => {
    setTestSecureKeyringEntry(JEV_KEYRING_SERVICE, JEV_KEYRING_ACCOUNT, JSON.stringify({ version: 1, provider: "typesafe", origin: TYPESAFE_API_ORIGIN, apiKey: "stored-secret" }));
    process.env.SYSTEMONE_API_KEY = "environment-secret";
    expect(resolveJevCredential()).toEqual({ status: "present", source: "environment", apiKey: "environment-secret" });
    expect(getTestSecureKeyringReadCount()).toBe(0);
  });

  it("prefers SYSTEMONE_API_KEY while still accepting the legacy name", () => {
    process.env.TYPESAFE_API_KEY = "legacy-secret";
    expect(resolveJevCredential()).toEqual({ status: "present", source: "environment", apiKey: "legacy-secret" });
    process.env.SYSTEMONE_API_KEY = "current-secret";
    expect(resolveJevCredential()).toEqual({ status: "present", source: "environment", apiKey: "current-secret" });
    process.env.SYSTEMONE_API_KEY = "   ";
    expect(resolveJevCredential()).toEqual({ status: "unavailable", message: "SYSTEMONE_API_KEY is present but invalid." });
  });

  it("never sends the legacy TypeSafe credential to another provider", () => {
    const opencode = endpointOf(OPENCODE_ENDPOINT);
    process.env.TYPESAFE_API_KEY = "legacy-typesafe-secret";
    const resolution = resolveJevCredential(process.env, opencode);
    expect(resolution).toMatchObject({ status: "unavailable" });
    expect(resolution.status === "unavailable" && resolution.message).toContain("is a TypeSafe credential");
    expect(JSON.stringify(resolution)).not.toContain("legacy-typesafe-secret");
    process.env.SYSTEMONE_API_KEY = "opencode-secret";
    expect(resolveJevCredential(process.env, opencode)).toEqual({ status: "present", source: "environment", apiKey: "opencode-secret" });
  });

  it("an inherited legacy credential does not mask a keyring credential for another endpoint", () => {
    const opencode = endpointOf(OPENCODE_ENDPOINT);
    saveJevApiKey("opencode-keyring-key", opencode);
    process.env.TYPESAFE_API_KEY = "legacy-typesafe-secret";
    expect(resolveJevCredential(process.env, opencode)).toEqual({ status: "present", source: "keyring", apiKey: "opencode-keyring-key" });
    removeJevApiKey(opencode);
    const resolution = resolveJevCredential(process.env, opencode);
    expect(resolution).toMatchObject({ status: "unavailable" });
    expect(resolution.status === "unavailable" && resolution.message).toContain("set SYSTEMONE_API_KEY");
  });

  it("rejects endpoints that could redirect, smuggle, or leak a request", () => {
    const rejected = [
      "http://api.typesafe.ai/v1/systemone",
      "https://api.typesafe.ai",
      "https://api.typesafe.ai/",
      "https://user:pass@api.typesafe.ai/v1/systemone",
      "https://api.typesafe.ai/v1/systemone?leak=1",
      "https://api.typesafe.ai/v1/systemone#fragment",
      "api.typesafe.ai/v1/systemone",
      `https://api.typesafe.ai/${"a".repeat(600)}`,
      "https://api.typesafe.ai/v1/system one",
    ];
    for (const value of rejected) {
      expect(resolveJevEndpoint({ SYSTEMONE_ENDPOINT: value } as NodeJS.ProcessEnv)).toMatchObject({ status: "unavailable" });
    }
  });

  it("disables credentials entirely when the configured endpoint is invalid", () => {
    setTestSecureKeyringEntry(JEV_KEYRING_SERVICE, JEV_KEYRING_ACCOUNT, JSON.stringify({ version: 1, provider: "typesafe", origin: TYPESAFE_API_ORIGIN, apiKey: "stored-secret" }));
    expect(resolveJevCredential({ SYSTEMONE_ENDPOINT: "http://evil.test/x" } as NodeJS.ProcessEnv)).toMatchObject({ status: "unavailable" });
    expect(getTestSecureKeyringReadCount()).toBe(0);
  });

  it("fails closed for malformed, mismatched, and unknown-version records", () => {
    const opencode = endpointOf(OPENCODE_ENDPOINT);
    const account = jevKeyringAccount(opencode);
    const records = [
      { version: 2, endpoint: "https://evil.test/x", apiKey: "secret" },
      { version: 2, endpoint: opencode.href, apiKey: "secret", extra: true },
      { version: 2, endpoint: opencode.href },
      { version: 9, endpoint: opencode.href, apiKey: "secret" },
      { version: 1, provider: "typesafe", origin: TYPESAFE_API_ORIGIN, apiKey: "secret" },
    ];
    for (const record of records) {
      setTestSecureKeyringEntry(JEV_KEYRING_SERVICE, account, JSON.stringify(record));
      expect(resolveJevCredential(process.env, opencode)).toMatchObject({ status: "unavailable" });
    }
  });

  it("keeps one credential per endpoint", () => {
    const opencode = endpointOf(OPENCODE_ENDPOINT);
    saveJevApiKey("typesafe-key");
    saveJevApiKey("opencode-key", opencode);
    expect(resolveJevCredential()).toEqual({ status: "present", source: "keyring", apiKey: "typesafe-key" });
    expect(resolveJevCredential(process.env, opencode)).toEqual({ status: "present", source: "keyring", apiKey: "opencode-key" });
    removeJevApiKey(opencode);
    expect(resolveJevCredential(process.env, opencode)).toEqual({ status: "missing" });
    expect(resolveJevCredential()).toEqual({ status: "present", source: "keyring", apiKey: "typesafe-key" });
  });

  it("still reads a version 1 record written before the endpoint was configurable", () => {
    setTestSecureKeyringEntry(JEV_KEYRING_SERVICE, JEV_KEYRING_ACCOUNT, JSON.stringify({ version: 1, provider: "typesafe", origin: TYPESAFE_API_ORIGIN, apiKey: "legacy-stored" }));
    expect(resolveJevCredential()).toEqual({ status: "present", source: "keyring", apiKey: "legacy-stored" });
    // A TypeSafe-era record must never be sent to another provider.
    expect(resolveJevCredential(process.env, endpointOf(OPENCODE_ENDPOINT))).toEqual({ status: "missing" });
  });

  it("fails closed for an origin-mismatched legacy record", () => {
    setTestSecureKeyringEntry(JEV_KEYRING_SERVICE, JEV_KEYRING_ACCOUNT, JSON.stringify({ version: 1, provider: "typesafe", origin: "https://evil.test", apiKey: "secret" }));
    expect(resolveJevCredential()).toMatchObject({ status: "unavailable" });
  });

  it("clears the legacy account when the default endpoint key is removed", () => {
    setTestSecureKeyringEntry(JEV_KEYRING_SERVICE, JEV_KEYRING_ACCOUNT, JSON.stringify({ version: 1, provider: "typesafe", origin: TYPESAFE_API_ORIGIN, apiKey: "legacy" }));
    saveJevApiKey("current");
    removeJevApiKey();
    expect(resolveJevCredential()).toEqual({ status: "missing" });
  });
});
