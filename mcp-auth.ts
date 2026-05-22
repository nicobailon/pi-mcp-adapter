/**
 * MCP Auth Storage Module
 * 
 * Handles secure storage of OAuth credentials, tokens, client information,
 * and PKCE state for MCP servers. Maintains backward compatibility with
 * per-server directory structure.
 * 
 * Token storage location: $MCP_OAUTH_DIR/<server>/tokens.json when set,
 * otherwise <Pi agent dir>/mcp-oauth/<server>/tokens.json
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, relative, resolve, isAbsolute } from 'path';
import { getAgentPath } from './agent-dir.ts';

/** OAuth token storage format */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // Unix timestamp in seconds
  scope?: string;
}

/** OAuth client information from dynamic or static registration */
export interface StoredClientInfo {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
}

/** Complete auth entry for a server */
export interface AuthEntry {
  tokens?: StoredTokens;
  clientInfo?: StoredClientInfo;
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string; // Track the URL these credentials are for
}

// Base directory for auth storage - can be overridden via env var for testing
function getAuthBaseDir(): string {
  const override = process.env.MCP_OAUTH_DIR?.trim();
  return override ? override : getAgentPath('mcp-oauth');
}

// MCP server names are filesystem directory components. The allow-list keeps
// us inside the auth base directory, sidesteps Unicode normalisation pitfalls
// (NFC/NFD collisions create distinct dirs on most Linux/macOS filesystems),
// and rejects whitespace, control characters, and leading hyphens that look
// like CLI flags. The names come from the user's mcp.json so the threat model
// is low likelihood, but the allow-list keeps a stray `..` or absolute path
// from clobbering files outside the configured MCP_OAUTH_DIR.
//
// Two shapes are accepted so users can key their mcp.json entries by either a
// plain identifier (`github`, `scoped:tool`) or an npm-package style scoped
// name (`@modelcontextprotocol/server-github` is the canonical example from
// the README). The scoped form is the only path under which `/` is allowed,
// and only as a single separator between scope and name; everything else is
// rejected up front.
const SAFE_SERVER_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function assertSafeServerName(serverName: unknown): asserts serverName is string {
  if (typeof serverName !== 'string' || !SAFE_SERVER_NAME.test(serverName)) {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
}

function getServerDir(serverName: string): string {
  assertSafeServerName(serverName);
  const base = resolve(getAuthBaseDir());
  const candidate = resolve(base, serverName);
  // Defence-in-depth: even if a future allow-list change lets something
  // exotic through, `path.relative` surfaces whether the candidate sits
  // inside `base`. We reject anything that escapes (absolute path or `..`),
  // and we tolerate base being a filesystem root because `relative` handles
  // the trailing-separator case correctly.
  const rel = relative(base, candidate);
  if (rel.length === 0 || (!isAbsolute(rel) && !rel.startsWith('..'))) {
    return candidate;
  }
  throw new Error(`MCP server name resolved outside base: ${JSON.stringify(serverName)}`);
}

function getTokensFilePath(serverName: string): string {
  return join(getServerDir(serverName), 'tokens.json');
}

/**
 * Ensure the server directory exists with secure permissions.
 */
function ensureServerDir(serverName: string): void {
  const dir = getServerDir(serverName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Read the auth entry for a server from disk.
 * Returns undefined if file doesn't exist.
 */
function readAuthEntry(serverName: string): AuthEntry | undefined {
  try {
    const filePath = getTokensFilePath(serverName);
    if (!existsSync(filePath)) {
      return undefined;
    }
    const data = readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as AuthEntry;
  } catch (error) {
    console.error(`Failed to read auth entry for ${serverName}:`, error);
    return undefined;
  }
}

/**
 * Write the auth entry for a server to disk with secure permissions.
 */
function writeAuthEntry(serverName: string, entry: AuthEntry): void {
  ensureServerDir(serverName);
  const filePath = getTokensFilePath(serverName);
  writeFileSync(filePath, JSON.stringify(entry, null, 2), { mode: 0o600 });
}

/**
 * Get auth entry for a server.
 */
export function getAuthEntry(serverName: string): AuthEntry | undefined {
  return readAuthEntry(serverName);
}

/**
 * Get auth entry and validate it's for the correct URL.
 * Returns undefined if URL has changed (credentials are invalid).
 */
export function getAuthForUrl(serverName: string, serverUrl: string): AuthEntry | undefined {
  const entry = getAuthEntry(serverName);
  if (!entry) return undefined;

  // If no serverUrl is stored, this is from an old version - consider it invalid
  if (!entry.serverUrl) return undefined;

  // If URL has changed, credentials are invalid
  if (entry.serverUrl !== serverUrl) return undefined;

  return entry;
}

/**
 * Save auth entry for a server.
 */
export function saveAuthEntry(serverName: string, entry: AuthEntry, serverUrl?: string): void {
  // Always update serverUrl if provided
  if (serverUrl) {
    entry.serverUrl = serverUrl;
  }
  writeAuthEntry(serverName, entry);
}

/**
 * Remove auth entry for a server.
 * Also removes the server directory if empty.
 */
export function removeAuthEntry(serverName: string): void {
  try {
    const filePath = getTokensFilePath(serverName);
    if (existsSync(filePath)) {
      writeFileSync(filePath, '{}', { mode: 0o600 });
    }
    // Try to remove the directory
    const dir = getServerDir(serverName);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true });
      } catch {
        // Directory may not be empty, ignore
      }
    }
  } catch (error) {
    console.error(`Failed to remove auth entry for ${serverName}:`, error);
  }
}

/**
 * Update tokens for a server.
 */
export function updateTokens(
  serverName: string, 
  tokens: StoredTokens, 
  serverUrl?: string
): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.clientInfo;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.tokens = tokens;
  saveAuthEntry(serverName, entry, serverUrl);
}

/**
 * Update client info for a server.
 */
export function updateClientInfo(
  serverName: string, 
  clientInfo: StoredClientInfo, 
  serverUrl?: string
): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.clientInfo = clientInfo;
  saveAuthEntry(serverName, entry, serverUrl);
}

/**
 * Update code verifier for a server.
 */
export function updateCodeVerifier(serverName: string, codeVerifier: string, serverUrl?: string): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.oauthState;
  }
  entry.codeVerifier = codeVerifier;
  saveAuthEntry(serverName, entry, serverUrl);
}

/**
 * Clear code verifier for a server.
 */
export function clearCodeVerifier(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.codeVerifier;
    saveAuthEntry(serverName, entry);
  }
}

/**
 * Update OAuth state for a server.
 */
export function updateOAuthState(serverName: string, state: string, serverUrl?: string): void {
  const entry = getAuthEntry(serverName) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.codeVerifier;
  }
  entry.oauthState = state;
  saveAuthEntry(serverName, entry, serverUrl);
}

/**
 * Get OAuth state for a server.
 */
export function getOAuthState(serverName: string): string | undefined {
  const entry = getAuthEntry(serverName);
  return entry?.oauthState;
}

/**
 * Clear OAuth state for a server.
 */
export function clearOAuthState(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.oauthState;
    saveAuthEntry(serverName, entry);
  }
}

/**
 * Check if stored tokens are expired.
 * Returns null if no tokens exist, false if no expiry or not expired, true if expired.
 */
export function isTokenExpired(serverName: string): boolean | null {
  const entry = getAuthEntry(serverName);
  if (!entry?.tokens) return null;
  if (!entry.tokens.expiresAt) return false;
  return entry.tokens.expiresAt < Date.now() / 1000;
}

/**
 * Check if a server has stored tokens.
 */
export function hasStoredTokens(serverName: string): boolean {
  const entry = getAuthEntry(serverName);
  return !!entry?.tokens;
}

/**
 * Clear all credentials for a server.
 */
export function clearAllCredentials(serverName: string): void {
  removeAuthEntry(serverName);
}

/**
 * Clear only client info for a server.
 */
export function clearClientInfo(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.clientInfo;
    saveAuthEntry(serverName, entry);
  }
}

/**
 * Clear only tokens for a server.
 */
export function clearTokens(serverName: string): void {
  const entry = getAuthEntry(serverName);
  if (entry) {
    delete entry.tokens;
    saveAuthEntry(serverName, entry);
  }
}
