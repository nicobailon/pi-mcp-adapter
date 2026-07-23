/**
 * MCP Auth Storage Module
 * 
 * Handles secure storage of OAuth credentials, tokens, client information,
 * and PKCE state for MCP servers.
 * 
 * Token storage location: $MCP_OAUTH_DIR/sha256-<server-hash>/tokens.json when set,
 * otherwise <Pi agent dir>/mcp-oauth/sha256-<server-hash>/tokens.json
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { getAgentPath } from './agent-dir.ts';
import { resolveConfiguredOAuthDir } from './config.ts';

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
  redirectUris?: string[];
}

/** Complete auth entry for a server */
export interface AuthEntry {
  tokens?: StoredTokens;
  clientInfo?: StoredClientInfo;
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string; // Track the URL these credentials are for
}

export interface AuthStorageOptions {
  baseDir?: string;
}

export function getAuthStorageOptions(oauthDir: unknown, cwd = process.cwd()): AuthStorageOptions {
  const baseDir = resolveConfiguredOAuthDir(oauthDir, cwd);
  return baseDir ? { baseDir } : {};
}

export function getAuthBaseDir(options: AuthStorageOptions = {}): string {
  const override = process.env.MCP_OAUTH_DIR?.trim();
  if (override) return override;
  return options.baseDir ?? getAgentPath('mcp-oauth');
}

/**
 * Get the server-specific directory path.
 */
function getServerDir(serverName: string, options?: AuthStorageOptions): string {
  if (typeof serverName !== 'string') {
    throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
  }
  const storageKey = createHash('sha256').update(serverName, 'utf8').digest('hex');
  return join(getAuthBaseDir(options), `sha256-${storageKey}`);
}

/**
 * Get the tokens file path for a server.
 */
export function getAuthEntryFilePath(serverName: string, options?: AuthStorageOptions): string {
  return join(getServerDir(serverName, options), 'tokens.json');
}

/**
 * Ensure the server directory exists with secure permissions.
 */
function ensureServerDir(serverName: string, options?: AuthStorageOptions): void {
  const dir = getServerDir(serverName, options);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Read the auth entry for a server from disk.
 * Returns undefined if file doesn't exist.
 */
function readAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
  const filePath = getAuthEntryFilePath(serverName, options);
  try {
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
function writeAuthEntry(serverName: string, entry: AuthEntry, options?: AuthStorageOptions): void {
  ensureServerDir(serverName, options);
  const filePath = getAuthEntryFilePath(serverName, options);
  writeFileSync(filePath, JSON.stringify(entry, null, 2), { mode: 0o600 });
}

/**
 * Get auth entry for a server.
 */
export function getAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
  return readAuthEntry(serverName, options);
}

/**
 * Get auth entry and validate it's for the correct URL.
 * Returns undefined if URL has changed (credentials are invalid).
 */
export function getAuthForUrl(serverName: string, serverUrl: string, options?: AuthStorageOptions): AuthEntry | undefined {
  const entry = getAuthEntry(serverName, options);
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
export function saveAuthEntry(serverName: string, entry: AuthEntry, serverUrl?: string, options?: AuthStorageOptions): void {
  // Always update serverUrl if provided
  if (serverUrl) {
    entry.serverUrl = serverUrl;
  }
  writeAuthEntry(serverName, entry, options);
}

/**
 * Remove auth entry for a server.
 * Also removes the server directory if empty.
 */
export function removeAuthEntry(serverName: string, options?: AuthStorageOptions): void {
  try {
    const filePath = getAuthEntryFilePath(serverName, options);
    if (existsSync(filePath)) {
      writeFileSync(filePath, '{}', { mode: 0o600 });
    }
    // Try to remove the directory
    const dir = getServerDir(serverName, options);
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
  serverUrl?: string,
  options?: AuthStorageOptions
): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.clientInfo;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.tokens = tokens;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Update client info for a server.
 */
export function updateClientInfo(
  serverName: string, 
  clientInfo: StoredClientInfo, 
  serverUrl?: string,
  options?: AuthStorageOptions
): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.codeVerifier;
    delete entry.oauthState;
  }
  entry.clientInfo = clientInfo;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Update code verifier for a server.
 */
export function updateCodeVerifier(serverName: string, codeVerifier: string, serverUrl?: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.oauthState;
  }
  entry.codeVerifier = codeVerifier;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Clear code verifier for a server.
 */
export function clearCodeVerifier(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.codeVerifier;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}

/**
 * Update OAuth state for a server.
 */
export function updateOAuthState(serverName: string, state: string, serverUrl?: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options) ?? {};
  if (serverUrl && entry.serverUrl !== serverUrl) {
    delete entry.tokens;
    delete entry.clientInfo;
    delete entry.codeVerifier;
  }
  entry.oauthState = state;
  saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Get OAuth state for a server.
 */
export function getOAuthState(serverName: string, options?: AuthStorageOptions): string | undefined {
  const entry = getAuthEntry(serverName, options);
  return entry?.oauthState;
}

/**
 * Clear OAuth state for a server.
 */
export function clearOAuthState(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.oauthState;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}

/**
 * Check if stored tokens are expired.
 * Returns null if no tokens exist, false if no expiry or not expired, true if expired.
 */
export function isTokenExpired(serverName: string, options?: AuthStorageOptions): boolean | null {
  const entry = getAuthEntry(serverName, options);
  if (!entry?.tokens) return null;
  if (!entry.tokens.expiresAt) return false;
  return entry.tokens.expiresAt < Date.now() / 1000;
}

/**
 * Check if a server has stored tokens.
 */
export function hasStoredTokens(serverName: string, options?: AuthStorageOptions): boolean {
  const entry = getAuthEntry(serverName, options);
  return !!entry?.tokens;
}

/**
 * Clear all credentials for a server.
 */
export function clearAllCredentials(serverName: string, options?: AuthStorageOptions): void {
  removeAuthEntry(serverName, options);
}

/**
 * Clear only client info for a server.
 */
export function clearClientInfo(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.clientInfo;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}

/**
 * Clear only tokens for a server.
 */
export function clearTokens(serverName: string, options?: AuthStorageOptions): void {
  const entry = getAuthEntry(serverName, options);
  if (entry) {
    delete entry.tokens;
    saveAuthEntry(serverName, entry, undefined, options);
  }
}
