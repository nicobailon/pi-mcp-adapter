import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import type { McpConfig, ServerEntry, McpPanelCallbacks, McpPanelResult } from "./types.js";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { getServerProvenance, writeDirectToolsConfig } from "./config.js";
import { lazyConnect, updateMetadataCache, updateStatusBar, getFailureAgeSeconds } from "./init.js";
import { loadMetadataCache } from "./metadata-cache.js";
import { ensureStoredTokens, persistOAuthTokens, readStoredTokens } from "./oauth-handler.js";
import { buildToolMetadata } from "./tool-metadata.js";

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const lines: string[] = ["MCP Server Status:", ""];

  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    let statusIcon = "○";
    let failed = false;

    if (connection?.status === "connected") {
      status = "connected";
      statusIcon = "✓";
    } else if (failedAgo !== null) {
      status = `failed ${failedAgo}s ago`;
      statusIcon = "✗";
      failed = true;
    } else if (metadata !== undefined) {
      status = "cached";
    }

    const toolSuffix = failed ? "" : ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`;
    lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`);
  }

  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const allTools = [...state.toolMetadata.values()].flat().map(m => m.name);

  if (allTools.length === 0) {
    ctx.ui.notify("No MCP tools available", "info");
    return;
  }

  const lines = [
    "MCP Tools:",
    "",
    ...allTools.map(t => `  ${t}`),
    "",
    `Total: ${allTools.length} tools`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function reconnectServers(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer?: string
): Promise<void> {
  if (targetServer && !state.config.mcpServers[targetServer]) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    }
    return;
  }

  const entries = targetServer
    ? [[targetServer, state.config.mcpServers[targetServer]] as [string, ServerEntry]]
    : Object.entries(state.config.mcpServers);

  for (const [name, definition] of entries) {
    try {
      await state.manager.close(name);

      const connection = await state.manager.connect(name, definition);
      const prefix = state.config.settings?.toolPrefix ?? "server";

      const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
      state.toolMetadata.set(name, metadata);
      updateMetadataCache(state, name);
      state.failureTracker.delete(name);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
          "info"
        );
        if (failedTools.length > 0) {
          ctx.ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.failureTracker.set(name, Date.now());
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error");
      }
    }
  }

  updateStatusBar(state);
}

type OAuthServerMetadata = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
};

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function fetchOAuthMetadata(serverUrl: string): Promise<Required<OAuthServerMetadata>> {
  const origin = new URL(serverUrl).origin;
  const metadataUrl = new URL("/.well-known/oauth-authorization-server", origin);
  const response = await fetch(metadataUrl, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`OAuth discovery failed (${response.status} ${response.statusText})`);
  }

  const metadata = (await response.json()) as OAuthServerMetadata;
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.registration_endpoint) {
    throw new Error("OAuth discovery response is missing required endpoints");
  }

  return {
    issuer: metadata.issuer ?? origin,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    registration_endpoint: metadata.registration_endpoint,
  };
}

async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ client_id: string; client_secret?: string; token_endpoint_auth_method?: string }> {
  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: "pi-mcp-adapter",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth client registration failed (${response.status}): ${body}`);
  }

  const json = JSON.parse(body) as { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string };
  if (!json.client_id) {
    throw new Error("OAuth client registration did not return a client_id");
  }

  return {
    client_id: json.client_id,
    client_secret: json.client_secret,
    token_endpoint_auth_method: json.token_endpoint_auth_method,
  };
}

async function startOAuthCallbackServer(
  expectedState: string,
): Promise<{ redirectUri: string; waitForResult: Promise<{ callbackUrl: string; code: string }> }> {
  const host = "127.0.0.1";

  return new Promise((resolve, reject) => {
    const timeoutMs = 5 * 60 * 1000;
    let settled = false;

    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `http://${host}`);
      if (requestUrl.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const state = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");
      const errorDescription = requestUrl.searchParams.get("error_description");

      res.setHeader("content-type", "text/html; charset=utf-8");

      const closeServer = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        server.close();
      };

      if (error) {
        res.end(`<html><body><h1>Authentication failed</h1><p>${error}: ${errorDescription ?? "Unknown error"}</p><p>You can close this window.</p></body></html>`);
        closeServer();
        waiterReject(new Error(`OAuth authorization failed: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`));
        return;
      }

      if (!code) {
        res.end("<html><body><h1>Authentication failed</h1><p>Missing authorization code.</p><p>You can close this window.</p></body></html>");
        closeServer();
        waiterReject(new Error("OAuth authorization failed: missing code in callback"));
        return;
      }

      if (state !== expectedState) {
        res.end("<html><body><h1>Authentication failed</h1><p>State mismatch.</p><p>You can close this window.</p></body></html>");
        closeServer();
        waiterReject(new Error("OAuth authorization failed: state mismatch"));
        return;
      }

      res.end("<html><body><h1>Authentication complete</h1><p>You can close this window and return to pi.</p></body></html>");
      closeServer();
      waiterResolve({ callbackUrl: requestUrl.toString(), code });
    });

    let waiterResolve!: (value: { callbackUrl: string; code: string }) => void;
    let waiterReject!: (reason?: unknown) => void;
    const waitForResult = new Promise<{ callbackUrl: string; code: string }>((resolveWait, rejectWait) => {
      waiterResolve = resolveWait;
      waiterReject = rejectWait;
    });

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      waiterReject(new Error("Timed out waiting for OAuth callback"));
    }, timeoutMs);

    server.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      waiterReject(error);
      reject(error);
    });

    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          waiterReject(new Error("Failed to bind local OAuth callback server"));
          reject(new Error("Failed to bind local OAuth callback server"));
        }
        return;
      }

      resolve({
        redirectUri: `http://${host}:${address.port}/callback`,
        waitForResult,
      });
    });
  });
}

async function exchangeAuthorizationCode(
  metadata: Required<OAuthServerMetadata>,
  client: { client_id: string; client_secret?: string; token_endpoint_auth_method?: string },
  redirectUri: string,
  code: string,
  codeVerifier: string,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };

  if (client.client_secret) {
    if (client.token_endpoint_auth_method === "client_secret_basic") {
      headers.authorization = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`;
      params.delete("client_id");
    } else if (client.token_endpoint_auth_method === "client_secret_post") {
      params.set("client_secret", client.client_secret);
    }
  }

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers,
    body: params.toString(),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth token exchange failed (${response.status}): ${body}`);
  }

  return JSON.parse(body) as Record<string, unknown>;
}

function extractCodeFromCallbackUrl(callbackUrl: string, expectedState: string): string {
  const parsed = new URL(callbackUrl);
  const state = parsed.searchParams.get("state");
  const code = parsed.searchParams.get("code");
  const error = parsed.searchParams.get("error");
  const errorDescription = parsed.searchParams.get("error_description");

  if (error) {
    throw new Error(`OAuth authorization failed: ${error}${errorDescription ? ` - ${errorDescription}` : ""}`);
  }
  if (!code) {
    throw new Error("OAuth authorization failed: missing code in callback URL");
  }
  if (state !== expectedState) {
    throw new Error("OAuth authorization failed: state mismatch");
  }

  return code;
}

type AuthenticateServerOptions = {
  reconnect?: boolean;
  reason?: string;
};

function isAutoOauthBrowserAuthEnabled(state: McpExtensionState): boolean {
  return state.config.settings?.autoOauthBrowserAuth !== false;
}

export async function authenticateServer(
  serverName: string,
  state: McpExtensionState,
  ui = state.ui,
  options: AuthenticateServerOptions = {},
): Promise<boolean> {
  if (!ui) return false;

  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    ui.notify(`Server "${serverName}" not found in config`, "error");
    return false;
  }

  if (definition.auth !== "oauth") {
    ui.notify(
      `Server "${serverName}" does not use OAuth authentication.\n` +
      `Current auth mode: ${definition.auth ?? "none"}`,
      "error"
    );
    return false;
  }

  if (!definition.url) {
    ui.notify(
      `Server "${serverName}" has no URL configured (OAuth requires HTTP transport)`,
      "error"
    );
    return false;
  }

  try {
    const reason = options.reason ? ` (${options.reason})` : "";
    ui.notify(`MCP: Starting OAuth flow for ${serverName}${reason}...`, "info");

    const metadata = await fetchOAuthMetadata(definition.url);
    const stateToken = toBase64Url(randomBytes(24));
    const { verifier, challenge } = createPkcePair();
    const { redirectUri, waitForResult } = await startOAuthCallbackServer(stateToken);
    const client = await registerOAuthClient(metadata.registration_endpoint, redirectUri);

    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", stateToken);

    await state.openBrowser(authUrl.toString());
    ui.notify(
      `Complete Atlassian login in your browser.\n\nIf automatic callback fails, copy the full redirected URL and keep it handy — pi will ask for it.`,
      "info"
    );

    let code: string;
    try {
      const result = await waitForResult;
      code = result.code;
    } catch (error) {
      const pasted = await ui.input(
        "Paste redirected callback URL",
        `${redirectUri}?code=...&state=...`,
      );
      if (!pasted) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      code = extractCodeFromCallbackUrl(pasted.trim(), stateToken);
    }

    const tokenPayload = await exchangeAuthorizationCode(metadata, client, redirectUri, code, verifier);
    const tokenPath = persistOAuthTokens(serverName, tokenPayload, {
      client_id: client.client_id,
      client_secret: client.client_secret,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      token_endpoint: metadata.token_endpoint,
      issuer: metadata.issuer,
      server_url: definition.url,
    });

    ui.notify(`OAuth complete for ${serverName}. Saved token to ${tokenPath}`, "info");

    if (options.reconnect !== false) {
      await reconnectServers(state, { hasUI: true, ui } as ExtensionContext, serverName);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.notify(`OAuth failed for ${serverName}: ${message}`, "error");
    return false;
  }
}

export async function autoAuthenticateOAuthServers(state: McpExtensionState): Promise<void> {
  const ui = state.ui;
  if (!ui) return;
  if (!isAutoOauthBrowserAuthEnabled(state)) return;

  for (const [serverName, definition] of Object.entries(state.config.mcpServers)) {
    if (definition.auth !== "oauth") continue;

    const tokens = await ensureStoredTokens(serverName);
    if (tokens) continue;

    const ok = await authenticateServer(serverName, state, ui, {
      reason: "session start",
      reconnect: true,
    });
    if (!ok) break;
  }
}

export async function openMcpPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<void> {
  const config = state.config;
  const cache = loadMetadataCache();
  const provenanceMap = getServerProvenance(pi.getFlag("mcp-config") as string | undefined ?? configOverridePath);

  const callbacks: McpPanelCallbacks = {
    reconnect: async (serverName: string) => {
      return lazyConnect(state, serverName);
    },
    getConnectionStatus: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      if (definition?.auth === "oauth" && readStoredTokens(serverName) === undefined) {
        return "needs-auth";
      }
      const connection = state.manager.getConnection(serverName);
      if (connection?.status === "connected") return "connected";
      if (getFailureAgeSeconds(state, serverName) !== null) return "failed";
      return "idle";
    },
    refreshCacheAfterReconnect: (serverName: string) => {
      const freshCache = loadMetadataCache();
      return freshCache?.servers?.[serverName] ?? null;
    },
  };

  const { createMcpPanel } = await import("./mcp-panel.js");

  return new Promise<void>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, _keybindings, done) => {
        return createMcpPanel(config, cache, provenanceMap, callbacks, tui, (result: McpPanelResult) => {
          if (!result.cancelled && result.changes.size > 0) {
            writeDirectToolsConfig(result.changes, provenanceMap, config);
            ctx.ui.notify("Direct tools updated. Restart pi to apply.", "info");
          }
          done();
          resolve();
        });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: 82 } },
    );
  });
}
