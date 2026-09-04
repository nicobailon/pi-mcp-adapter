import { createHash } from "node:crypto";
import type { McpExtensionState } from "./state.ts";
import type { ToolMetadata } from "./types.ts";
import { logger } from "./logger.ts";

export const MCP_APPROVAL_CUSTOM_TYPE = "mcp-approval-v1";

export type SessionApprovalEntry =
  | {
      version: 1;
      kind: "tool";
      decision: "allow_for_session";
      serverName: string;
      originalToolName: string;
      definitionHash: string;
      argsHash: string;
    }
  | {
      version: 1;
      kind: "iframe";
      decision: "allow" | "deny";
      serverName: string;
    };

export type SessionApprovalWriter = (record: SessionApprovalEntry) => void;

const TOOL_APPROVAL_KEYS = [
  "version",
  "kind",
  "decision",
  "serverName",
  "originalToolName",
  "definitionHash",
  "argsHash",
] as const;
const IFRAME_APPROVAL_KEYS = ["version", "kind", "decision", "serverName"] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Deterministic serialization used for approval identity hashes. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "undefined" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

export function computeToolArgumentsHash(args: unknown): string {
  return createHash("sha256").update(stableStringify(args ?? {})).digest("hex");
}

export function computeToolDefinitionHash(
  toolMeta: Pick<ToolMetadata, "originalName" | "inputSchema" | "resourceUri" | "uiResourceUri">,
): string {
  return createHash("sha256").update(stableStringify({
    originalName: toolMeta.originalName,
    inputSchema: toolMeta.inputSchema ?? null,
    resourceUri: toolMeta.resourceUri ?? null,
    uiResourceUri: toolMeta.uiResourceUri ?? null,
  })).digest("hex");
}

export function makeToolApprovalKey(
  serverName: string,
  originalToolName: string,
  definitionHash: string,
  argsHash: string,
): string {
  return `${serverName}\u0000${originalToolName}\u0000${definitionHash}\u0000${argsHash}`;
}

export function getToolApprovalIdentity(
  serverName: string,
  toolMeta: Pick<ToolMetadata, "originalName" | "inputSchema" | "resourceUri" | "uiResourceUri">,
  args: unknown,
): { definitionHash: string; argsHash: string; cacheKey: string } {
  const definitionHash = computeToolDefinitionHash(toolMeta);
  const argsHash = computeToolArgumentsHash(args);
  return {
    definitionHash,
    argsHash,
    cacheKey: makeToolApprovalKey(serverName, toolMeta.originalName, definitionHash, argsHash),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isSessionApprovalEntry(value: unknown): value is SessionApprovalEntry {
  if (!isRecord(value) || value.version !== 1 || !isNonEmptyString(value.serverName)) return false;

  if (value.kind === "tool") {
    return hasExactKeys(value, TOOL_APPROVAL_KEYS)
      && value.decision === "allow_for_session"
      && isNonEmptyString(value.originalToolName)
      && isSha256(value.definitionHash)
      && isSha256(value.argsHash);
  }

  if (value.kind === "iframe") {
    return hasExactKeys(value, IFRAME_APPROVAL_KEYS)
      && (value.decision === "allow" || value.decision === "deny");
  }

  return false;
}

function isApprovalCustomEntry(entry: unknown): entry is { type: "custom"; data?: unknown } {
  return isRecord(entry)
    && entry.type === "custom"
    && entry.customType === MCP_APPROVAL_CUSTOM_TYPE;
}

export function createSessionApprovalWriter(
  appendEntry: (customType: string, data?: unknown) => void,
  canAppend: (() => boolean) | undefined = undefined,
): SessionApprovalWriter {
  return (record) => {
    if (canAppend && !canAppend()) return;
    try {
      appendEntry(MCP_APPROVAL_CUSTOM_TYPE, record);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.debug(`MCP: failed to persist session approval: ${detail}`);
    }
  };
}

export function rememberToolApproval(
  state: McpExtensionState,
  serverName: string,
  toolMeta: Pick<ToolMetadata, "originalName" | "inputSchema" | "resourceUri" | "uiResourceUri">,
  args: unknown,
): void {
  const { definitionHash, argsHash, cacheKey } = getToolApprovalIdentity(serverName, toolMeta, args);
  const approvedToolCalls = state.approvedToolCalls ??= new Map<string, true>();
  if (approvedToolCalls.has(cacheKey)) return;

  approvedToolCalls.set(cacheKey, true);
  const record: SessionApprovalEntry = {
    version: 1,
    kind: "tool",
    decision: "allow_for_session",
    serverName,
    originalToolName: toolMeta.originalName,
    definitionHash,
    argsHash,
  };
  try {
    state.persistSessionApproval?.(record);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.debug(`MCP: session approval persistence callback failed: ${detail}`);
  }
}

export function restoreSessionApprovalState(
  state: McpExtensionState,
  branchEntries: readonly unknown[],
): void {
  const approvedToolCalls = state.approvedToolCalls ??= new Map<string, true>();
  approvedToolCalls.clear();
  state.consentManager.clear();

  for (const entry of branchEntries) {
    if (!isApprovalCustomEntry(entry)) continue;
    if (!isSessionApprovalEntry(entry.data)) continue;

    if (entry.data.kind === "tool") {
      approvedToolCalls.set(makeToolApprovalKey(
        entry.data.serverName,
        entry.data.originalToolName,
        entry.data.definitionHash,
        entry.data.argsHash,
      ), true);
      continue;
    }

    state.consentManager.restoreDecision(entry.data.serverName, entry.data.decision === "allow");
  }
}
