import { getValidToken } from "./mcp-auth-flow.ts";
import {
  inspectAuthForUrl,
  updateTokens,
  type AuthStorageOptions,
  type StoredTokens,
} from "./mcp-auth.ts";

export type McpOAuthTokens = StoredTokens;
export type McpOAuthStorageOptions = AuthStorageOptions;
export interface McpOAuthTokenOptions {
  authStorageOptions?: McpOAuthStorageOptions;
  signal?: AbortSignal;
  skipIssuerMetadataValidation?: boolean;
}
export type McpOAuthTokenStatus =
  | { status: "present"; tokens: McpOAuthTokens }
  | { status: "absent" }
  | { status: "unavailable"; message: string };

export async function getMcpOAuthTokensForUrl(
  serverName: string,
  serverUrl: string,
  options: McpOAuthTokenOptions = {},
): Promise<McpOAuthTokens | undefined> {
  return (await getValidToken(serverName, serverUrl, options)) ?? undefined;
}

export function inspectMcpOAuthTokensForUrl(
  serverName: string,
  serverUrl: string,
  options?: McpOAuthStorageOptions,
): McpOAuthTokenStatus {
  const status = inspectAuthForUrl(serverName, serverUrl, options);
  if (status.status !== "present") return status;
  return status.entry.tokens
    ? { status: "present", tokens: status.entry.tokens }
    : { status: "absent" };
}

export function updateMcpOAuthTokensForUrl(
  serverName: string,
  serverUrl: string,
  tokens: McpOAuthTokens,
  options?: McpOAuthStorageOptions,
): void {
  updateTokens(serverName, tokens, serverUrl, options);
}
