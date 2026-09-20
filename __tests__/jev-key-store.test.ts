import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTestSecureKeyringReadCount, resetTestSecureKeyring, setTestSecureKeyringEntry } from "../secure-keyring.ts";
import { JEV_KEYRING_ACCOUNT, JEV_KEYRING_SERVICE, removeJevApiKey, resolveJevCredential, saveJevApiKey, TYPESAFE_API_ORIGIN } from "../jev-key-store.ts";

describe("TypeSafe secure key storage", () => {
  beforeEach(() => { vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory"); vi.unstubAllEnvs(); process.env.PI_MCP_ADAPTER_TEST_AUTH_STORE = "memory"; delete process.env.TYPESAFE_API_KEY; resetTestSecureKeyring(); });

  it("round trips only through the OS-keyring abstraction", () => {
    saveJevApiKey("secret-value");
    expect(resolveJevCredential()).toEqual({ status: "present", source: "keyring", apiKey: "secret-value" });
    removeJevApiKey();
    expect(resolveJevCredential()).toEqual({ status: "missing" });
  });

  it("uses an explicit environment override without touching keyring", () => {
    setTestSecureKeyringEntry(JEV_KEYRING_SERVICE, JEV_KEYRING_ACCOUNT, JSON.stringify({ version: 1, provider: "typesafe", origin: TYPESAFE_API_ORIGIN, apiKey: "stored-secret" }));
    process.env.TYPESAFE_API_KEY = "environment-secret";
    expect(resolveJevCredential()).toEqual({ status: "present", source: "environment", apiKey: "environment-secret" });
    expect(getTestSecureKeyringReadCount()).toBe(0);
  });

  it("fails closed for malformed, origin-mismatched, and malformed env records", () => {
    setTestSecureKeyringEntry(JEV_KEYRING_SERVICE, JEV_KEYRING_ACCOUNT, JSON.stringify({ version: 1, provider: "typesafe", origin: "https://evil.test", apiKey: "secret" }));
    expect(resolveJevCredential()).toMatchObject({ status: "unavailable" });
    setTestSecureKeyringEntry(JEV_KEYRING_SERVICE, JEV_KEYRING_ACCOUNT, JSON.stringify({ version: 1, provider: "typesafe", origin: TYPESAFE_API_ORIGIN, apiKey: "secret", extra: true }));
    expect(resolveJevCredential()).toMatchObject({ status: "unavailable" });
    process.env.TYPESAFE_API_KEY = "   ";
    expect(resolveJevCredential()).toEqual({ status: "unavailable", message: "TYPESAFE_API_KEY is present but invalid." });
    expect(TYPESAFE_API_ORIGIN).toBe("https://api.typesafe.ai");
  });
});
