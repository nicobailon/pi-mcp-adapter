import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type OAuthDiagnosticEvent = "oauth_transaction_waiting" | "oauth_transaction_acquired" | "oauth_transaction_completed" | "oauth_transaction_failed";

interface OAuthDiagnosticDetails {
  serverName: string;
  transactionId: string;
  durationMs?: number;
  result?: string;
}

export async function logOAuthDiagnostic(event: OAuthDiagnosticEvent, details: OAuthDiagnosticDetails): Promise<void> {
  const path = process.env.PI_MCP_OAUTH_LOG;
  if (!path) return;
  try {
    const record = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      event,
      serverName: details.serverName,
      transactionId: details.transactionId,
      durationMs: details.durationMs,
      result: details.result,
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Optional diagnostics must not affect credential persistence or lock cleanup.
  }
}
