import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConfig } from "../types.ts";

const IMPORT = "Import sign-in";
const SIGN_IN_AGAIN = "Sign in again";

describe("importing sign-ins from Pi's built-in MCP", () => {
  let root: string;
  let agentDir: string;
  let piAuthPath: string;
  const servers: http.Server[] = [];

  beforeEach(() => {
    vi.resetModules();
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-signin-import-")));
    agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    piAuthPath = join(agentDir, "mcp-auth.json");
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function loadModules() {
    const config = await import("../config.ts");
    config.setPiMcpConfigEnabled(true);
    const auth = await import("../mcp-auth.ts");
    auth.resetTestAuthSecretStore();
    return { ...auth, ...(await import("../pi-signin-import.ts")), ...(await import("../onboarding-state.ts")) };
  }

  function piEntry(serverUrl: string, accessToken = "pi-access") {
    return {
      serverUrl,
      tokens: { access_token: accessToken, token_type: "Bearer", refresh_token: "pi-refresh", scope: "mcp:read" },
      tokensExpireAt: Date.now() + 3_600_000,
      clientInformation: { client_id: "pi-client", redirect_uris: ["http://127.0.0.1:4567/callback"] },
      codeVerifier: "pi-verifier",
      oauthState: "pi-state",
    };
  }

  function writePiAuth(entries: Record<string, unknown>): void {
    writeFileSync(piAuthPath, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
  }

  function createCtx(choice: string | undefined, hasUI = true) {
    return {
      hasUI,
      cwd: root,
      ui: { select: vi.fn(async () => choice), notify: vi.fn() },
    } as any;
  }

  async function startBearerServer(accessToken: string): Promise<{ url: string; authorizations: (string | undefined)[] }> {
    const authorizations: (string | undefined)[] = [];
    const server = http.createServer(async (req, res) => {
      authorizations.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${accessToken}`) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" }).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body) as { id?: number; method?: string };
      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi-signed-in", version: "1.0.0" } }
        : { tools: [] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
    return { url: `http://127.0.0.1:${address.port}/mcp`, authorizations };
  }

  it("imports the sign-in for the exact URL without Pi's PKCE state, and the server connects with it", async () => {
    const { url, authorizations } = await startBearerServer("pi-access");
    writePiAuth({ [String(new URL(url))]: piEntry(url) });
    const { offerPiSignInImports, getAuthForUrl } = await loadModules();
    const definition = { url, auth: "oauth" as const };
    const ctx = createCtx(IMPORT);

    await offerPiSignInImports(ctx, { mcpServers: { docs: definition } });

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    const [prompt, choices] = ctx.ui.select.mock.calls[0];
    expect(choices).toEqual([IMPORT, SIGN_IN_AGAIN]);
    expect(prompt).toContain("rotates refresh tokens");
    expect(prompt).toContain("pi mcp");
    const stored = getAuthForUrl("docs", url);
    expect(stored).toMatchObject({
      serverUrl: url,
      tokens: { accessToken: "pi-access", refreshToken: "pi-refresh", scope: "mcp:read" },
      clientInfo: { clientId: "pi-client", redirectUris: ["http://127.0.0.1:4567/callback"] },
    });
    expect(stored?.codeVerifier).toBeUndefined();
    expect(stored?.oauthState).toBeUndefined();
    const notices = JSON.stringify(ctx.ui.notify.mock.calls) + String(prompt);
    expect(notices).not.toContain("pi-access");
    expect(notices).not.toContain("pi-refresh");

    const { McpServerManager } = await import("../server-manager.ts");
    const connection = await new McpServerManager().connect("docs", definition);
    expect(connection.status).toBe("connected");
    expect(authorizations).toContain("Bearer pi-access");
    await connection.client.close();
  });

  it("never offers a sign-in stored for a different URL", async () => {
    writePiAuth({ "https://docs.example/other": piEntry("https://docs.example/other") });
    const { offerPiSignInImports, findPiSignInImports, getAuthForUrl } = await loadModules();
    const config: McpConfig = { mcpServers: { docs: { url: "https://docs.example/mcp", auth: "oauth" } } };
    const ctx = createCtx(IMPORT);

    await offerPiSignInImports(ctx, config);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(findPiSignInImports(config, {})).toEqual([]);
    expect(getAuthForUrl("docs", "https://docs.example/mcp")).toBeUndefined();
  });

  it("never replaces an existing adapter entry for the URL", async () => {
    writePiAuth({ "https://docs.example/mcp": piEntry("https://docs.example/mcp") });
    const { offerPiSignInImports, findPiSignInImports, getAuthForUrl, saveAuthEntry } = await loadModules();
    saveAuthEntry("docs", { clientInfo: { clientId: "adapter-client" } }, "https://docs.example/mcp");
    const config: McpConfig = { mcpServers: { docs: { url: "https://docs.example/mcp", auth: "oauth" } } };
    const ctx = createCtx(IMPORT);

    await offerPiSignInImports(ctx, config);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(findPiSignInImports(config, {})).toEqual([]);
    expect(getAuthForUrl("docs", "https://docs.example/mcp")).toEqual({ clientInfo: { clientId: "adapter-client" }, serverUrl: "https://docs.example/mcp" });
  });

  it("imports nothing and leaves Pi's file untouched on Sign in again, and does not ask again", async () => {
    writePiAuth({ "https://docs.example/mcp": piEntry("https://docs.example/mcp") });
    const before = readFileSync(piAuthPath);
    const { offerPiSignInImports, getAuthForUrl } = await loadModules();
    const config: McpConfig = { mcpServers: { docs: { url: "https://docs.example/mcp" } } };
    const ctx = createCtx(SIGN_IN_AGAIN);

    await offerPiSignInImports(ctx, config);
    await offerPiSignInImports(ctx, config);

    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(getAuthForUrl("docs", "https://docs.example/mcp")).toBeUndefined();
    expect(readFileSync(piAuthPath).equals(before)).toBe(true);
  });

  it("offers a sign-in again when its import failed", async () => {
    writePiAuth({ "https://docs.example/mcp": piEntry("https://docs.example/mcp") });
    const { offerPiSignInImports } = await loadModules();
    const config: McpConfig = { mcpServers: { docs: { url: "https://docs.example/mcp", auth: "oauth" } } };
    const ctx = createCtx(IMPORT);
    vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "writefailing");

    await offerPiSignInImports(ctx, config);
    await offerPiSignInImports(ctx, config);

    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not import Pi's sign-in for docs"), "error");
  });

  it("does nothing without a UI or with the encrypted-file credential store", async () => {
    writePiAuth({ "https://docs.example/mcp": piEntry("https://docs.example/mcp") });
    const { offerPiSignInImports, findPiSignInImports, getAuthForUrl } = await loadModules();
    const config: McpConfig = { mcpServers: { docs: { url: "https://docs.example/mcp", auth: "oauth" } } };
    const headless = createCtx(IMPORT, false);
    const encrypted = createCtx(IMPORT);

    await offerPiSignInImports(headless, config);
    await offerPiSignInImports(encrypted, { ...config, settings: { oauthCredentialStore: "encrypted-file" } });

    expect(headless.ui.select).not.toHaveBeenCalled();
    expect(encrypted.ui.select).not.toHaveBeenCalled();
    expect(findPiSignInImports(config, { credentialStore: "encrypted-file" })).toEqual([]);
    expect(getAuthForUrl("docs", "https://docs.example/mcp")).toBeUndefined();
  });

  it("skips a malformed Pi file and malformed entries", async () => {
    writeFileSync(piAuthPath, "{ not json", "utf-8");
    const { offerPiSignInImports } = await loadModules();
    const config: McpConfig = {
      mcpServers: {
        broken: { url: "https://broken.example/mcp", auth: "oauth" },
        docs: { url: "https://docs.example/mcp", auth: "oauth" },
      },
    };
    const ctx = createCtx(SIGN_IN_AGAIN);

    await expect(offerPiSignInImports(ctx, config)).resolves.toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();

    writePiAuth({
      "https://broken.example/mcp": { tokens: { token_type: "Bearer" }, codeVerifier: "only-pkce" },
      "https://docs.example/mcp": piEntry("https://docs.example/mcp"),
    });
    await offerPiSignInImports(ctx, config);
    expect(ctx.ui.select).toHaveBeenCalledTimes(1);
    expect(ctx.ui.select.mock.calls[0][0]).toContain('"docs"');
  });

  it("offers the panel action for eligible servers and imports them without asking", async () => {
    writePiAuth({ "https://docs.example/mcp": piEntry("https://docs.example/mcp") });
    const { getAuthForUrl } = await loadModules();
    const createMcpPanel = vi.fn((_config, _cache, _provenance, _callbacks, _tui, done) => {
      done({ cancelled: true, changes: new Map(), disabledChanges: new Map() });
      return { dispose() {} };
    });
    vi.doMock("../mcp-panel.ts", () => ({ createMcpPanel }));
    const { openMcpPanel } = await import("../commands.ts");
    const ui = { notify: vi.fn(), select: vi.fn(), custom: vi.fn((renderer: any) => renderer({ requestRender: vi.fn() }, {}, {}, vi.fn())) };

    await openMcpPanel({
      config: { mcpServers: { docs: { url: "https://docs.example/mcp", auth: "oauth" } } },
      manager: { getConnection: () => null },
      toolMetadata: new Map(),
      failureTracker: new Map(),
    } as any, { getFlag: () => undefined } as any, { hasUI: true, mode: "tui", cwd: root, ui } as any);

    const callbacks = createMcpPanel.mock.calls[0]![3];
    expect(callbacks.importPiSignIns?.()).toEqual({ imported: ["docs"], failed: [] });
    expect(ui.select).not.toHaveBeenCalled();
    expect(getAuthForUrl("docs", "https://docs.example/mcp")?.tokens?.accessToken).toBe("pi-access");
    vi.doUnmock("../mcp-panel.ts");
  });

  it("asks at session start in Pi with the current config, before the first connection", async () => {
    const { url, authorizations } = await startBearerServer("pi-access");
    writePiAuth({ [String(new URL(url))]: piEntry(url) });
    // Lazy with no metadata cache: the session's startup bootstrap is the first connection.
    const writeConfig = (serverUrl: string) => writeFileSync(join(agentDir, "mcp-adapter.json"), JSON.stringify({
      mcpServers: { docs: { url: serverUrl, auth: "oauth" } },
      settings: { sampling: false, elicitation: false },
    }));
    writeConfig("https://moved.example/mcp");
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [join(process.cwd(), "index.ts")] });
    await loader.reload();
    // The URL changes after the extension loaded; session start must use the current config.
    writeConfig(url);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      noTools: "all",
    });
    const select = vi.fn(async () => IMPORT);
    const ui = { notify: vi.fn(), setStatus: vi.fn(), select, theme: { fg: (_color: string, value: string) => value } } as any;
    try {
      await session.bindExtensions({ mode: "tui", uiContext: ui, onError: () => undefined });
      await vi.waitFor(() => expect(authorizations.length).toBeGreaterThan(0), { timeout: 5_000 });

      expect(select).toHaveBeenCalledTimes(1);
      expect(authorizations[0]).toBe("Bearer pi-access");
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  }, 20_000);
});
