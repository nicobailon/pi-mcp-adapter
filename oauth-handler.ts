// oauth-handler.ts - OAuth token management for MCP servers
import { existsSync, readFileSync } from "node:fs";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getTokensFilePath } from "./mcp-auth.js";

/**
 * Get stored OAuth tokens for a server (if any).
 * Returns undefined if no tokens or tokens are expired.
 * 
 * Token file location: <agent-dir>/mcp-oauth/<server>/tokens.json,
 * or <MCP_OAUTH_DIR>/<server>/tokens.json when MCP_OAUTH_DIR is set.
 * 
 * Expected format:
 * {
 *   "access_token": "...",
 *   "token_type": "bearer",
 *   "refresh_token": "...",  // optional
 *   "expires_in": 3600,      // optional, seconds
 *   "expiresAt": 1234567890  // optional, absolute timestamp ms
 * }
 */
export function getStoredTokens(serverName: string): OAuthTokens | undefined {
  const tokensPath = getTokensFilePath(serverName);
  
  if (!existsSync(tokensPath)) return undefined;
  
  try {
    const stored = JSON.parse(readFileSync(tokensPath, "utf-8"));
    
    // Validate required field
    if (!stored.access_token || typeof stored.access_token !== "string") {
      return undefined;
    }
    
    // Check expiration if expiresAt is set
    if (stored.expiresAt && typeof stored.expiresAt === "number") {
      if (Date.now() > stored.expiresAt) {
        // Token expired
        return undefined;
      }
    }
    
    return {
      access_token: stored.access_token,
      token_type: stored.token_type ?? "bearer",
      refresh_token: stored.refresh_token,
      expires_in: stored.expires_in,
    };
  } catch {
    return undefined;
  }
}
