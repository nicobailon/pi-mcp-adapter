import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { isTransientHttpConnectError, McpServerManager } from "../server-manager.ts";
import { initializeMcp } from "../init.ts";

const mocks = vi.hoisted(() => ({
  cache: null as { version: 1; servers: Record<string, unknown> } | null,
  states: [] as Array<{ owner: { stop: (reason: string) => Promise<void> } }>,
  tempDirs: [] as string[],
}));

vi.mock("../metadata-cache.ts", () => ({
  computeServerHash: vi.fn(() => "hash"),
  createCachedToolSelectorCandidateIndex: vi.fn(() => undefined),
  getMissingConfiguredDirectToolServers: vi.fn(() => [] as string[]),
  isServerCacheValid: vi.fn(() => false),
  loadMetadataCache: vi.fn(() => mocks.cache),
  reconstructPromptMetadata: vi.fn(() => []),
  reconstructToolMetadata: vi.fn(() => []),
  saveMetadataCache: vi.fn((cache) => {
    mocks.cache = cache;
  }),
  serializePrompts: vi.fn(() => []),
  serializeResources: vi.fn(() => []),
  serializeTools: vi.fn(() => []),
}));

function http503(): SdkHttpError {
  return new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "HTTP 503", { status: 503 });
}

async function boot(notify: ReturnType<typeof vi.fn>, mcpServers?: Record<string, unknown>) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-transient-init-"));
  mocks.tempDirs.push(cwd);
  const state = await initializeMcp({ getFlag: vi.fn() } as any, {
    cwd,
    hasUI: true,
    mode: "tui",
    ui: { notify, setStatus: vi.fn() },
    signal: new AbortController().signal,
  } as any, undefined, {
    config: { mcpServers: mcpServers ?? {
      firecrawl: { url: "http://127.0.0.1:8787/firecrawl/mcp", lifecycle: "keep-alive" },
    } },
  });
  mocks.states.push(state);
  return state;
}

describe("isTransientHttpConnectError", () => {
  it("matches a direct HTTP 503 SDK error", () => {
    expect(isTransientHttpConnectError(http503())).toBe(true);
  });

  it("matches an HTTP 503 wrapped as cause", () => {
    const wrapped = new Error("Error POSTing to endpoint", { cause: http503() });
    expect(isTransientHttpConnectError(wrapped)).toBe(true);
  });

  it("matches an HTTP 503 after manager error enrichment", () => {
    const wrapped = new Error("Error POSTing to endpoint", { cause: http503() });
    const enriched = new Error("Error POSTing to endpoint — endpoint is temporarily unavailable (HTTP 503)", { cause: wrapped });
    expect(isTransientHttpConnectError(enriched)).toBe(true);
  });

  it("rejects other statuses and plain errors", () => {
    expect(isTransientHttpConnectError(new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "HTTP 401", { status: 401 }))).toBe(false);
    expect(isTransientHttpConnectError(new Error("boom"))).toBe(false);
    expect(isTransientHttpConnectError("nope")).toBe(false);
  });
});

describe("startup transient-503 handling", () => {
  let notify: ReturnType<typeof vi.fn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    notify = vi.fn();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.cache = null;
  });

  afterEach(async () => {
    await Promise.all(mocks.states.splice(0).map(state => state.owner.stop("test cleanup")));
    for (const dir of mocks.tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reports a direct 503 softly and records failure state", async () => {
    vi.spyOn(McpServerManager.prototype, "connect").mockRejectedValue(http503());

    const state = await boot(notify);

    expect(state.failureTracker.has("firecrawl")).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      "MCP: firecrawl temporarily unavailable (HTTP 503); retry later",
      "warning",
    );
    const hard = [...notify.mock.calls].filter(([message]) => String(message).includes("Failed to connect"));
    expect(hard).toEqual([]);
    expect(consoleError.mock.calls.some(args => String(args[0]).includes("Failed to connect"))).toBe(false);
  });

  it("reports a wrapped 503 cause softly", async () => {
    vi.spyOn(McpServerManager.prototype, "connect").mockRejectedValue(
      new Error("Error POSTing to endpoint", { cause: http503() }),
    );

    await boot(notify);

    expect(notify).toHaveBeenCalledWith(
      "MCP: firecrawl temporarily unavailable (HTTP 503); retry later",
      "warning",
    );
    expect([...notify.mock.calls].filter(([message]) => String(message).includes("Failed to connect"))).toEqual([]);
  });

  it("keeps the hard failure path for non-transient errors", async () => {
    vi.spyOn(McpServerManager.prototype, "connect").mockRejectedValue(new Error("connection refused"));

    await boot(notify);

    expect(notify).toHaveBeenCalledWith("MCP: Failed to connect to firecrawl: connection refused", "error");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("temporarily unavailable"), "warning");
  });

  it("self-heals only keep-alive after startup failure", async () => {
    const connect = vi.spyOn(McpServerManager.prototype, "connect").mockRejectedValue(http503());
    const callsFor = (name: string) => connect.mock.calls.filter(([server]) => server === name).length;

    const state = await boot(notify, {
      keepAlive: { url: "http://127.0.0.1:8787/keep-alive/mcp", lifecycle: "keep-alive" },
      eager: { url: "http://127.0.0.1:8787/eager/mcp", lifecycle: "eager" },
      lazyKeepAlive: { command: "lazy-resident", lifecycle: "lazy-keep-alive" },
      lazyOne: { command: "lazy", lifecycle: "lazy" },
    });
    for (const name of ["keepAlive", "eager", "lazyKeepAlive", "lazyOne"]) {
      expect(callsFor(name)).toBe(1); // first-run metadata bootstrap attempts every server once
      expect(state.failureTracker.has(name)).toBe(true);
    }

    connect.mockResolvedValue({ status: "connected", tools: [], resources: [] } as any);
    await state.lifecycle.ensureConverged();

    expect(callsFor("keepAlive")).toBe(2);
    expect(state.failureTracker.has("keepAlive")).toBe(false);
    // Public lifecycle contract: eager never auto-reconnects; lazy modes remain
    // tool-call driven until lazy-keep-alive has connected successfully once.
    expect(callsFor("eager")).toBe(1);
    expect(callsFor("lazyKeepAlive")).toBe(1);
    expect(callsFor("lazyOne")).toBe(1);
  });
});

describe("startup sign-in with autoAuth", () => {
  let notify: ReturnType<typeof vi.fn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    notify = vi.fn();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.cache = null;
  });

  afterEach(async () => {
    await Promise.all(mocks.states.splice(0).map(state => state.owner.stop("test cleanup")));
    for (const dir of mocks.tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function bootWith(settings: Record<string, unknown>, withUi = true, oauth?: Record<string, unknown>) {
    const cwd = mkdtempSync(join(tmpdir(), "pi-mcp-auto-auth-init-"));
    mocks.tempDirs.push(cwd);
    const ctx = withUi
      ? { cwd, hasUI: true, mode: "tui", ui: { notify, setStatus: vi.fn() }, signal: new AbortController().signal }
      : { cwd, hasUI: false, mode: "print", signal: new AbortController().signal };
    const state = await initializeMcp({ getFlag: vi.fn() } as any, ctx as any, undefined, {
      config: { settings, mcpServers: { rovo: { url: "http://127.0.0.1:8787/rovo/mcp", auth: "oauth", ...(oauth ? { oauth } : {}) } } },
    });
    mocks.states.push(state);
    return state;
  }

  it("says an OAuth server signs in on first use instead of reporting a failure", async () => {
    vi.spyOn(McpServerManager.prototype, "connect").mockResolvedValue({ status: "needs-auth" } as any);

    const state = await bootWith({ autoAuth: true });

    expect(notify).toHaveBeenCalledWith("MCP: rovo signs in on first use", "info");
    expect([...notify.mock.calls].filter(([message]) => String(message).includes("Failed to connect"))).toEqual([]);
    expect(consoleError.mock.calls.some(args => String(args[0]).includes("Failed to connect"))).toBe(false);
    expect(state.failureTracker.has("rovo")).toBe(true);
  });

  it("keeps the /mcp-auth error without a UI, where authorization_code cannot sign in on its own", async () => {
    vi.spyOn(McpServerManager.prototype, "connect").mockResolvedValue({ status: "needs-auth" } as any);

    await bootWith({ autoAuth: true }, false);

    expect(consoleError.mock.calls.some(args => String(args[0]).includes("OAuth authentication required. Run /mcp-auth rovo."))).toBe(true);
    expect(consoleError.mock.calls.some(args => String(args[0]).includes("signs in on first use"))).toBe(false);
  });

  it("keeps the /mcp-auth error for a remote redirect URI, whose callback the user must paste", async () => {
    vi.spyOn(McpServerManager.prototype, "connect").mockResolvedValue({ status: "needs-auth" } as any);

    await bootWith({ autoAuth: true }, true, { redirectUri: "https://callback.example.test/callback" });

    expect(notify).toHaveBeenCalledWith(
      "MCP: Failed to connect to rovo: OAuth authentication required. Run /mcp-auth rovo.",
      "error",
    );
    expect(notify).not.toHaveBeenCalledWith("MCP: rovo signs in on first use", "info");
  });

  it("checks a redirect URI after expanding environment variables, as sign-in does", async () => {
    vi.spyOn(McpServerManager.prototype, "connect").mockResolvedValue({ status: "needs-auth" } as any);
    vi.stubEnv("MCP_TEST_CALLBACK_URI", "http://localhost:3118/callback");

    await bootWith({ autoAuth: true }, true, { redirectUri: "${MCP_TEST_CALLBACK_URI}" });

    expect(notify).toHaveBeenCalledWith("MCP: rovo signs in on first use", "info");
  });

  it("keeps the /mcp-auth error without autoAuth", async () => {
    vi.spyOn(McpServerManager.prototype, "connect").mockResolvedValue({ status: "needs-auth" } as any);

    await bootWith({});

    expect(notify).toHaveBeenCalledWith(
      "MCP: Failed to connect to rovo: OAuth authentication required. Run /mcp-auth rovo.",
      "error",
    );
  });
});
