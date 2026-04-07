// oauth-provider.ts - File-backed OAuthClientProvider for MCP servers
//
// Implements the SDK's OAuthClientProvider interface so that pi-mcp-adapter
// can drive a real OAuth 2.1 + dynamic-client-registration flow against
// servers like Supabase, GitHub, Linear, etc.
//
// Storage layout (per server, mode 0600):
//   ~/.pi/agent/mcp-oauth/<server>/tokens.json  - access/refresh tokens
//   ~/.pi/agent/mcp-oauth/<server>/client.json  - dynamic registration result
//   ~/.pi/agent/mcp-oauth/<server>/verifier.txt - PKCE code verifier (transient)
//
// The tokens.json format is backwards-compatible with the previous
// "drop a token file by hand" workflow, so existing setups keep working.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

const STORAGE_BASE = join(homedir(), ".pi", "agent", "mcp-oauth");

export interface OAuthProviderOptions {
  /** Local TCP port that the loopback callback server is listening on. */
  redirectPort: number;
  /** Display name advertised to the authorization server during dynamic registration. */
  clientName?: string;
  /** OAuth scope(s) to request, space-separated. */
  scope?: string;
  /** Callback invoked when the SDK wants the user agent to visit `authorizationUrl`. */
  onRedirect: (authorizationUrl: URL) => void | Promise<void>;
}

/**
 * Resolve the per-server storage directory.
 *
 * Exposed so other modules (panel, status, etc.) can locate or remove
 * stored credentials without depending on the provider class itself.
 */
export function getServerStorageDir(serverName: string): string {
  return join(STORAGE_BASE, serverName);
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort cleanup
  }
}

export class FileBackedOAuthProvider implements OAuthClientProvider {
  private readonly serverDir: string;

  constructor(
    private readonly serverName: string,
    private readonly opts: OAuthProviderOptions,
  ) {
    this.serverDir = getServerStorageDir(serverName);
  }

  // ---- Static metadata ----------------------------------------------------

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.opts.redirectPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.opts.clientName ?? "pi-mcp-adapter",
      client_uri: "https://github.com/nicobailon/pi-mcp-adapter",
    };
    if (this.opts.scope) metadata.scope = this.opts.scope;
    return metadata;
  }

  // ---- Token persistence --------------------------------------------------

  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = readJsonFile<{
      access_token?: string;
      token_type?: string;
      refresh_token?: string;
      expires_in?: number;
      expiresAt?: number;
      scope?: string;
    }>(join(this.serverDir, "tokens.json"));

    if (!stored?.access_token) return undefined;

    // If the token has a known absolute expiry and it has passed, treat as
    // missing so the SDK will refresh (if a refresh_token is available) or
    // re-prompt for authorization.
    if (typeof stored.expiresAt === "number" && Date.now() > stored.expiresAt) {
      if (!stored.refresh_token) return undefined;
    }

    return {
      access_token: stored.access_token,
      token_type: stored.token_type ?? "bearer",
      refresh_token: stored.refresh_token,
      expires_in: stored.expires_in,
      scope: stored.scope,
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const toStore: Record<string, unknown> = {
      access_token: tokens.access_token,
      token_type: tokens.token_type ?? "bearer",
    };
    if (tokens.refresh_token) toStore.refresh_token = tokens.refresh_token;
    if (typeof tokens.expires_in === "number") {
      toStore.expires_in = tokens.expires_in;
      toStore.expiresAt = Date.now() + tokens.expires_in * 1000;
    }
    if (tokens.scope) toStore.scope = tokens.scope;
    writeJsonFile(join(this.serverDir, "tokens.json"), toStore);
  }

  // ---- Dynamic client registration ---------------------------------------

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    return readJsonFile<OAuthClientInformation>(join(this.serverDir, "client.json"));
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    writeJsonFile(join(this.serverDir, "client.json"), info);
  }

  // ---- PKCE ---------------------------------------------------------------

  async codeVerifier(): Promise<string> {
    const path = join(this.serverDir, "verifier.txt");
    if (!existsSync(path)) {
      throw new Error(
        `No PKCE code verifier saved for "${this.serverName}". The OAuth flow was not started or state was lost.`,
      );
    }
    return readFileSync(path, "utf-8");
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    mkdirSync(this.serverDir, { recursive: true });
    writeFileSync(join(this.serverDir, "verifier.txt"), verifier, { mode: 0o600 });
  }

  // ---- Browser handoff ----------------------------------------------------

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.opts.onRedirect(authorizationUrl);
  }

  // ---- Credential invalidation -------------------------------------------

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): Promise<void> {
    if (scope === "all" || scope === "tokens") {
      safeUnlink(join(this.serverDir, "tokens.json"));
    }
    if (scope === "all" || scope === "client") {
      safeUnlink(join(this.serverDir, "client.json"));
    }
    if (scope === "all" || scope === "verifier") {
      safeUnlink(join(this.serverDir, "verifier.txt"));
    }
  }
}
