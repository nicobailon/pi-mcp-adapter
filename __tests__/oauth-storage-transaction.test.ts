import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAuthForUrl, resetTestAuthSecretStore, saveAuthEntry } from "../mcp-auth.ts";
import { getAuthStatus, removeAuth } from "../mcp-auth-flow.ts";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";

beforeEach(() => { vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory"); resetTestAuthSecretStore(); });
afterEach(() => vi.unstubAllEnvs());

it("keeps status read-only and nonblocking while logout waits for an in-flight refresh to persist", async () => {
  const name = `storage-${randomUUID()}`;
  const url = "https://fake.test/mcp";
  saveAuthEntry(name, { tokens: { accessToken: "fake-old", refreshToken: "fake-refresh", expiresAt: 1 }, serverUrl: url }, url);
  const provider = new McpOAuthProvider(name, url, {}, { onRedirect: async () => {} });
  let finish!: () => void;
  let start!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const begun = new Promise<void>(resolve => { start = resolve; });
  const refresh = provider.withAuthTransaction(async () => {
    start();
    await gate;
    await provider.saveTokens({ access_token: "fake-new", refresh_token: "fake-rotated", token_type: "Bearer" });
    return "AUTHORIZED";
  });
  await begun;
  expect(await getAuthStatus(name)).toBe("expired");
  let removed = false;
  const logout = removeAuth(name).then(() => { removed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(removed).toBe(false);
  } finally {
    finish();
    await refresh;
    await logout;
  }
  expect(getAuthForUrl(name, url)).toBeUndefined();
});
