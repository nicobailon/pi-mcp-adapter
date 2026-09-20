import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { existsSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  failure: undefined as unknown,
  constructorFailure: undefined as unknown,
  entries: new Map<string, string>(),
  spawn: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("node:module", () => ({
  createRequire: () => () => ({
    Entry: class {
      private key: string;
      constructor(service: string, account: string) {
        if (mocks.constructorFailure) throw mocks.constructorFailure;
        this.key = `${service}\0${account}`;
      }
      getPassword() { if (mocks.failure) throw mocks.failure; return mocks.entries.get(this.key) ?? null; }
      setPassword(payload: string) { if (mocks.failure) throw mocks.failure; mocks.entries.set(this.key, payload); }
      deleteCredential() { if (mocks.failure) throw mocks.failure; return mocks.entries.delete(this.key); }
    },
  }),
}));

import { createSecureKeyringStore } from "../secure-keyring.ts";
import { getBearerTokenForUrl, inspectBearerTokenForUrl, removeBearerToken, saveBearerTokenForUrl } from "../mcp-bearer-store.ts";

const token = "synthetic-secret-never-real";
const serverUrl = "https://example.test/mcp";
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("revoked Linux secure keyring recovery", () => {
  beforeEach(() => {
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "");
    vi.stubEnv("PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY", "");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    mocks.failure = new Error("native failure", { cause: new Error("KeyRevoked") });
    mocks.constructorFailure = undefined;
    mocks.entries.clear();
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation((_command, _args, options) => {
      const { service, operation, account, payload } = JSON.parse(options.input);
      const key = `${service}\0${account}`;
      let response: object = { ok: true };
      if (operation === "read") response = mocks.entries.has(key)
        ? { ok: true, found: true, value: mocks.entries.get(key) }
        : { ok: true, found: false };
      if (operation === "write") mocks.entries.set(key, payload);
      if (operation === "remove") mocks.entries.delete(key);
      return { status: 0, stdout: JSON.stringify(response), stderr: "", signal: null };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", originalPlatform);
  });

  it("keeps ordinary native operations first and does not spawn on success", () => {
    mocks.failure = undefined;
    const store = createSecureKeyringStore("native");
    store.write("account", token);
    expect(store.read("account")).toBe(token);
    store.remove("account");
    expect(store.read("account")).toBeUndefined();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("recovers each primitive once, preserving service/account isolation", () => {
    for (const service of ["pi-mcp-adapter.bearer", "other-service"]) {
      const store = createSecureKeyringStore(service);
      store.write("account", token);
      expect(store.read("account")).toBe(token);
      store.remove("account");
      expect(store.read("account")).toBeUndefined();
    }
    expect(mocks.spawn).toHaveBeenCalledTimes(8);
    expect(mocks.entries.size).toBe(0);
    for (const [command, args, options] of mocks.spawn.mock.calls) {
      expect(command).toBe("keyctl");
      expect(args.slice(0, 3)).toEqual(["session", "-", process.execPath]);
      expect(args[3]).toMatch(/mcp-keyring-helper\.cjs$/);
      expect(existsSync(args[3])).toBe(true);
      expect(args.join(" ")).not.toContain(token);
      expect(options).toMatchObject({ shell: false, stdio: "pipe", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
      expect(options.env).toBeUndefined();
    }
  });

  it.each([
    new Error("Key has been revoked"),
    { code: "KeyRevoked" },
    { name: "KeyRevoked" },
  ])("recognizes native revoked error forms: %j", failure => {
    mocks.failure = failure;
    expect(createSecureKeyringStore("test").read("missing")).toBeUndefined();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("recovers wrapped constructor errors", () => {
    mocks.constructorFailure = mocks.failure;
    expect(createSecureKeyringStore("test").read("missing")).toBeUndefined();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("preserves URL binding, chunks, replacement and removal for bearer records", () => {
    const largeToken = token.repeat(200);
    saveBearerTokenForUrl("remote", largeToken, serverUrl);
    expect(getBearerTokenForUrl("remote", serverUrl)).toBe(largeToken);
    expect(mocks.entries.size).toBeGreaterThan(1);
    expect(getBearerTokenForUrl("remote", "https://other.test/mcp")).toBeUndefined();
    expect(inspectBearerTokenForUrl("remote", "https://other.test/mcp")).toEqual({ status: "url-mismatch" });
    saveBearerTokenForUrl("remote", token, serverUrl);
    expect(mocks.entries.size).toBe(1);
    removeBearerToken("remote");
    expect(mocks.entries.size).toBe(0);
  });

  it("does not recover unrelated, cyclic or excessively deep errors", () => {
    const cyclic = new Error("AccessDenied"); cyclic.cause = cyclic;
    let deep: Error = new Error("KeyRevoked");
    for (let i = 0; i < 20; i++) deep = new Error("wrapper", { cause: deep });
    for (const failure of [new Error("AccessDenied"), new Error("KeyRevokedExtra"), cyclic, deep]) {
      mocks.failure = failure;
      expect(() => createSecureKeyringStore("test").read("account")).toThrow();
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32", "freebsd"])("does not recover on %s", platform => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    expect(() => createSecureKeyringStore("test").read("account")).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("honors the recovery opt-out", () => {
    vi.stubEnv("PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY", "1");
    expect(() => createSecureKeyringStore("test").read("account")).toThrow();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { error: new Error(token), status: null, stdout: token, stderr: token },
    { error: Object.assign(new Error(token), { code: "ETIMEDOUT" }), status: null, signal: "SIGKILL" },
    { error: Object.assign(new Error(token), { code: "ENOBUFS" }), status: null },
    { status: 1, stdout: token, stderr: token },
    { status: 0, signal: "SIGKILL", stdout: token },
    ...[token, "null", "[]", "{}", '{"ok":true}', '{"ok":true,"found":true,"value":42}', '{"ok":true,"found":"yes"}', JSON.stringify({ ok: true, found: false, value: token }), JSON.stringify({ ok: false, error: token })].map(stdout => ({ status: 0, stdout })),
  ])("fails closed without exposing helper output/cause: %#", result => {
    mocks.spawn.mockReturnValue(result);
    let error: unknown;
    try { getBearerTokenForUrl("remote", serverUrl); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    expect(inspect(error, { depth: 20 })).not.toContain(token);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(inspectBearerTokenForUrl("remote", serverUrl).status).toBe("unavailable");
  });

  it("sanitizes thrown helper errors for reads, writes and removes", () => {
    mocks.spawn.mockImplementation(() => { throw new Error(token); });
    const store = createSecureKeyringStore("test");
    for (const run of [() => store.read("account"), () => store.write("account", token), () => store.remove("account")]) {
      let error: unknown;
      try { run(); } catch (caught) { error = caught; }
      expect(error).toBeDefined();
      expect(inspect(error, { depth: 20 })).not.toContain(token);
    }
    expect(mocks.spawn).toHaveBeenCalledTimes(3);
  });
});
