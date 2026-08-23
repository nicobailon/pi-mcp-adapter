import type { McpExtensionState } from "./state.ts";

export const FAILURE_BACKOFF_MS = 60 * 1000;

export function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
  const failedAt = state.failureTracker.get(serverName);
  if (!failedAt) return null;
  const ageMs = Date.now() - failedAt;
  if (ageMs > FAILURE_BACKOFF_MS) return null;
  return Math.round(ageMs / 1000);
}

export function getFailureMessage(state: McpExtensionState, serverName: string): string | null {
  if (getFailureAgeSeconds(state, serverName) === null) return null;
  return state.failureMessages?.get(serverName) ?? null;
}

export function isServerInActiveFailureBackoff(state: McpExtensionState, serverName: string): boolean {
  const connection = state.manager.getConnection(serverName);
  return connection?.status !== "connected"
    && connection?.status !== "needs-auth"
    && getFailureAgeSeconds(state, serverName) !== null;
}
