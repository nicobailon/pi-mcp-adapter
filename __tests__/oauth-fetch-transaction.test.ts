import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createOAuthAwareFetch } from "../mcp-auth-flow.ts";
import { withAuthEntryTransaction } from "../mcp-auth.ts";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(["timeout", "deactivate"])("bounds configured discovery on %s and releases ownership", async mode => {
  vi.stubEnv("PI_MCP_OAUTH_REQUEST_TIMEOUT_MS", mode === "timeout" ? "20" : "1000");
  const name = `configured-${randomUUID()}`;
  const provider = new McpOAuthProvider(name, "https://fake.test/mcp", { authServerMetadataUrl: "https://fake.test/.well-known/oauth-authorization-server" }, { onRedirect: async () => {} });
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    started();
  })));
  const request = provider.withAuthTransaction(async () => { await provider.discoveryState(); return "AUTHORIZED"; });
  const failure = expect(request).rejects.toThrow();
  await begun;
  if (mode === "deactivate") provider.deactivate();
  await failure;
  expect(await withAuthEntryTransaction(name, async () => "reacquired")).toBe("reacquired");
});

it("leaves non-OAuth transport fetches untouched", async () => {
  const base = vi.fn().mockResolvedValue(new Response("ok"));
  const init = { method: "GET" };
  await createOAuthAwareFetch(base)("https://fake.test/events", init);
  expect(base).toHaveBeenCalledWith("https://fake.test/events", init);
  expect(init).not.toHaveProperty("signal");
});

it("bounds each fetch only while inside a credential transaction", async () => {
  vi.stubEnv("PI_MCP_OAUTH_REQUEST_TIMEOUT_MS", "20");
  const base = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  await expect(withAuthEntryTransaction(`fetch-${randomUUID()}`, async () => {
    await createOAuthAwareFetch(base)("https://fake.test/token", { method: "POST" });
  })).rejects.toMatchObject({ name: "TimeoutError" });
  expect(base).toHaveBeenCalledOnce();
});

it("aborts an auth fetch on provider deactivation and releases after it settles", async () => {
  const name = `fetch-cancel-${randomUUID()}`;
  const provider = new McpOAuthProvider(name, "https://fake.test/mcp", {}, { onRedirect: async () => {} });
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const base = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    started();
  }));
  const auth = provider.withAuthTransaction(async () => {
    await createOAuthAwareFetch(base)("https://fake.test/token", { method: "POST" });
    return "AUTHORIZED";
  });
  const failure = expect(auth).rejects.toThrow("no longer active");
  await begun;
  provider.deactivate();
  await failure;
  expect(await withAuthEntryTransaction(name, async () => "reacquired")).toBe("reacquired");
});
