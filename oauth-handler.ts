// oauth-handler.ts - OAuth token management for MCP servers
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface StoredOAuthTokens extends OAuthTokens {
  expiresAt?: number;
  client_id?: string;
  client_secret?: string;
  token_endpoint_auth_method?: string;
  token_endpoint?: string;
  issuer?: string;
  server_url?: string;
}

// Token storage path for a server
export function getTokensPath(serverName: string): string {
  return join(homedir(), ".pi", "agent", "mcp-oauth", serverName, "tokens.json");
}

export function readStoredTokens(serverName: string): StoredOAuthTokens | undefined {
  const tokensPath = getTokensPath(serverName);
  if (!existsSync(tokensPath)) return undefined;

  try {
    const stored = JSON.parse(readFileSync(tokensPath, "utf-8"));
    if (!stored.access_token || typeof stored.access_token !== "string") {
      return undefined;
    }

    return {
      access_token: stored.access_token,
      token_type: stored.token_type ?? "bearer",
      refresh_token: typeof stored.refresh_token === "string" ? stored.refresh_token : undefined,
      expires_in: typeof stored.expires_in === "number"
        ? stored.expires_in
        : typeof stored.expires_in === "string"
          ? Number(stored.expires_in)
          : undefined,
      expiresAt: typeof stored.expiresAt === "number" ? stored.expiresAt : undefined,
      client_id: typeof stored.client_id === "string" ? stored.client_id : undefined,
      client_secret: typeof stored.client_secret === "string" ? stored.client_secret : undefined,
      token_endpoint_auth_method: typeof stored.token_endpoint_auth_method === "string"
        ? stored.token_endpoint_auth_method
        : undefined,
      token_endpoint: typeof stored.token_endpoint === "string" ? stored.token_endpoint : undefined,
      issuer: typeof stored.issuer === "string" ? stored.issuer : undefined,
      server_url: typeof stored.server_url === "string" ? stored.server_url : undefined,
    };
  } catch {
    return undefined;
  }
}

export function isTokenExpired(tokens: Pick<StoredOAuthTokens, "expiresAt"> | undefined, skewMs = 30_000): boolean {
  if (!tokens?.expiresAt || typeof tokens.expiresAt !== "number") return false;
  return Date.now() + skewMs >= tokens.expiresAt;
}

function toOAuthTokens(tokens: StoredOAuthTokens | undefined): OAuthTokens | undefined {
  if (!tokens) return undefined;
  return {
    access_token: tokens.access_token,
    token_type: tokens.token_type ?? "bearer",
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
  };
}

/**
 * Get stored OAuth tokens for a server (if any).
 * Returns undefined if no tokens or access token is expired.
 */
export function getStoredTokens(serverName: string): OAuthTokens | undefined {
  const stored = readStoredTokens(serverName);
  if (!stored || isTokenExpired(stored)) return undefined;
  return toOAuthTokens(stored);
}

export function persistOAuthTokens(
  serverName: string,
  tokenPayload: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): string {
  const tokenPath = getTokensPath(serverName);
  mkdirSync(dirname(tokenPath), { recursive: true });

  const expiresIn = typeof tokenPayload.expires_in === "number"
    ? tokenPayload.expires_in
    : typeof tokenPayload.expires_in === "string"
      ? Number(tokenPayload.expires_in)
      : undefined;

  const existing = readStoredTokens(serverName);
  const data = {
    access_token: tokenPayload.access_token,
    token_type: tokenPayload.token_type ?? existing?.token_type ?? "bearer",
    refresh_token: tokenPayload.refresh_token ?? existing?.refresh_token,
    expires_in: expiresIn,
    expiresAt: typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? Date.now() + expiresIn * 1000
      : undefined,
    client_id: extras.client_id ?? existing?.client_id,
    client_secret: extras.client_secret ?? existing?.client_secret,
    token_endpoint_auth_method: extras.token_endpoint_auth_method ?? existing?.token_endpoint_auth_method,
    token_endpoint: extras.token_endpoint ?? existing?.token_endpoint,
    issuer: extras.issuer ?? existing?.issuer,
    server_url: extras.server_url ?? existing?.server_url,
  };

  writeFileSync(tokenPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return tokenPath;
}

export async function refreshStoredTokens(serverName: string): Promise<StoredOAuthTokens | undefined> {
  const stored = readStoredTokens(serverName);
  if (!stored?.refresh_token || !stored.token_endpoint || !stored.client_id) {
    return undefined;
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: stored.client_id,
  });

  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };

  if (stored.client_secret) {
    if (stored.token_endpoint_auth_method === "client_secret_basic") {
      headers.authorization = `Basic ${Buffer.from(`${stored.client_id}:${stored.client_secret}`).toString("base64")}`;
      params.delete("client_id");
    } else if (stored.token_endpoint_auth_method === "client_secret_post") {
      params.set("client_secret", stored.client_secret);
    }
  }

  const response = await fetch(stored.token_endpoint, {
    method: "POST",
    headers,
    body: params.toString(),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OAuth refresh failed (${response.status}): ${body}`);
  }

  const refreshed = JSON.parse(body) as Record<string, unknown>;
  persistOAuthTokens(serverName, refreshed, {
    client_id: stored.client_id,
    client_secret: stored.client_secret,
    token_endpoint_auth_method: stored.token_endpoint_auth_method,
    token_endpoint: stored.token_endpoint,
    issuer: stored.issuer,
    server_url: stored.server_url,
  });

  return readStoredTokens(serverName);
}

export async function ensureStoredTokens(serverName: string): Promise<OAuthTokens | undefined> {
  const stored = readStoredTokens(serverName);
  if (!stored) return undefined;
  if (!isTokenExpired(stored)) return toOAuthTokens(stored);

  try {
    const refreshed = await refreshStoredTokens(serverName);
    return toOAuthTokens(refreshed);
  } catch {
    return undefined;
  }
}
