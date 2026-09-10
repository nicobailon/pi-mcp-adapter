import { getValidToken } from "./mcp-auth-flow.ts";
import {
  inspectAuthForUrl,
  updateTokens,
  withAuthEntryTransaction,
  type AuthStorageOptions,
  type StoredTokens,
} from "./mcp-auth.ts";

import type { ServerEntry } from "./types.ts";

export type McpOAuthTokens = StoredTokens;
export type McpOAuthStorageOptions = AuthStorageOptions;
export interface McpOAuthTokenOptions {
  authStorageOptions?: McpOAuthStorageOptions;
  signal?: AbortSignal;
  skipIssuerMetadataValidation?: boolean;
  /** Explicit refresh configuration; never loaded from ambient config or stored with tokens. */
  definition?: Pick<ServerEntry, "headers" | "oauth">;
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

export async function updateMcpOAuthTokensForUrl(
  serverName: string,
  serverUrl: string,
  tokens: McpOAuthTokens,
  options?: McpOAuthStorageOptions,
): Promise<void> {
  await withAuthEntryTransaction(serverName, async () => {
    updateTokens(serverName, tokens, serverUrl, options);
  });
}
