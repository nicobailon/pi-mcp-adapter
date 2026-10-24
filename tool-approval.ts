import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { abortable } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { McpExtensionState } from "./state.ts";
import { getServerApprovalIdentity, getToolApprovalIdentity, rememberToolApproval } from "./session-approvals.ts";
import {
  getToolNameCandidates,
  matchesToolPattern,
  resolveToolPrefix,
  MCP_TOOL_APPROVAL_REQUEST_EVENT,
  type McpConfig,
  type McpToolApprovalDecision,
  type McpToolApprovalHandler,
  type McpToolApprovalHandlerResult,
  type McpToolApprovalOrigin,
  type McpToolApprovalRequest,
  type ToolMetadata,
} from "./types.ts";
import { sanitizeTerminalText, stripOscSequences } from "./utils.ts";

export type ToolCallApprovalResult =
  | { ok: true }
  | { ok: false; reason: "denied"; denyReason?: string }
  | { ok: false; reason: "approval_required_headless" };

/** Upper bound for an approver's deny reason, in UTF-8 bytes. */
export const MAX_DENY_REASON_BYTES = 8192;
const DENY_REASON_TRUNCATED = "\n[… reason truncated]";

/**
 * Make an approver's reason safe to hand back to the model: escape sequences
 * and control characters go, newlines, tabs and every printable character stay.
 * Over the byte limit it is cut on a character boundary and marked, so a
 * shortened reason never reads as whole.
 */
export function sanitizeDenyReason(reason: string): string | undefined {
  const cleaned = stripOscSequences(reason)
    .replace(/\r\n?/g, "\n")
    .replace(/(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (!cleaned) return undefined;
  const encoder = new TextEncoder();
  if (encoder.encode(cleaned).length <= MAX_DENY_REASON_BYTES) return cleaned;
  // encodeInto writes only whole characters, so `read` ends on a character boundary.
  const { read } = encoder.encodeInto(cleaned, new Uint8Array(MAX_DENY_REASON_BYTES - encoder.encode(DENY_REASON_TRUNCATED).length));
  return `${cleaned.slice(0, read)}${DENY_REASON_TRUNCATED}`;
}

/** The text and details a denied or gated call returns, shared by every call path. */
export function approvalBlockedResult(
  approval: Exclude<ToolCallApprovalResult, { ok: true }>,
  serverName: string,
  toolName: string,
): { text: string; details: { error: "approval_denied" | "approval_required"; server: string; tool: string; reason?: string } } {
  if (approval.reason === "denied") {
    const base = `MCP tool "${toolName}" on server "${serverName}" was blocked by the approval gate; it was not executed. This does not by itself mean the user rejected it.`;
    return {
      text: approval.denyReason ? `${base}\nReason: ${approval.denyReason}` : base,
      details: {
        error: "approval_denied",
        server: serverName,
        tool: toolName,
        ...(approval.denyReason ? { reason: approval.denyReason } : {}),
      },
    };
  }
  return {
    text: `MCP tool "${toolName}" on server "${serverName}" is approval-gated and requires an interactive session.`,
    details: { error: "approval_required", server: serverName, tool: toolName },
  };
}

export function isToolCallApprovalRequired(
  config: McpConfig,
  serverName: string,
  toolMeta: Pick<ToolMetadata, "originalName" | "annotations" | "resourceUri">,
  toolMetadata?: ReadonlyMap<string, readonly ToolMetadata[]>,
): boolean {
  const definition = config.mcpServers[serverName];
  const serverApproval = definition?.approveTools;
  const approval = serverApproval !== undefined ? serverApproval : config.settings?.approveTools;

  if (approval === undefined || approval === false) return false;
  // MCP treats a tool as possibly destructive unless it says otherwise; reading a resource never is.
  if (approval === "destructive") {
    return toolMeta.resourceUri === undefined
      && toolMeta.annotations?.readOnlyHint !== true
      && toolMeta.annotations?.destructiveHint !== false;
  }
  // Values from unvalidated sources (imports, runtime registration) fail closed.
  if (!Array.isArray(approval)) return true;
  if (approval.length === 0) return false;

  const prefix = resolveToolPrefix(definition, config.settings?.toolPrefix);
  const currentCandidates = getToolNameCandidates(toolMeta.originalName, serverName, prefix, false);
  if (serverApproval !== undefined) {
    if (matchesToolPattern(currentCandidates, approval)) return true;
    if (!toolMetadata) return matchesToolPattern(getToolNameCandidates(toolMeta.originalName, serverName, prefix), approval);
    const legacyCandidates = getToolNameCandidates(toolMeta.originalName, serverName, prefix);
    const legacyEmittedName = [...currentCandidates].find(candidate => candidate !== toolMeta.originalName)?.replace(/-/g, "_");
    if (legacyEmittedName) legacyCandidates.add(legacyEmittedName);
    for (const candidate of currentCandidates) legacyCandidates.delete(candidate);
    const otherCurrentCandidates = new Set<string>();
    for (const tool of toolMetadata.get(serverName) ?? []) {
      for (const candidate of getToolNameCandidates(tool.originalName, serverName, prefix, false)) {
        otherCurrentCandidates.add(candidate);
      }
    }
    for (const candidate of currentCandidates) otherCurrentCandidates.delete(candidate);
    return approval.some(pattern =>
      matchesToolPattern(legacyCandidates, [pattern])
      && !matchesToolPattern(otherCurrentCandidates, [pattern]),
    );
  }


  if (matchesToolPattern(currentCandidates, approval)) return true;
  if (!toolMetadata) return false;

  const legacyCandidates = getToolNameCandidates(toolMeta.originalName, serverName, prefix);
  const legacyEmittedName = [...currentCandidates].find(candidate => candidate !== toolMeta.originalName)?.replace(/-/g, "_");
  if (legacyEmittedName) legacyCandidates.add(legacyEmittedName);
  for (const candidate of currentCandidates) legacyCandidates.delete(candidate);
  const otherCurrentCandidates = new Set<string>();
  for (const [name, metadata] of toolMetadata) {
    const otherPrefix = resolveToolPrefix(config.mcpServers[name], config.settings?.toolPrefix);
    for (const tool of metadata) {
      for (const candidate of getToolNameCandidates(tool.originalName, name, otherPrefix, false)) {
        otherCurrentCandidates.add(candidate);
      }
    }
  }
  for (const candidate of currentCandidates) otherCurrentCandidates.delete(candidate);

  return approval.some(pattern =>
    matchesToolPattern(legacyCandidates, [pattern])
    && !matchesToolPattern(otherCurrentCandidates, [pattern]),
  );
}

function isMcpToolApprovalDecision(value: unknown): value is McpToolApprovalDecision {
  return value === "allow_once"
    || value === "allow_for_session"
    || value === "deny"
    || value === "abstain";
}

/** Anything but a known string or a well-formed denial object is a deny. */
function normalizeHandlerResult(value: unknown): McpToolApprovalHandlerResult {
  if (isMcpToolApprovalDecision(value)) return value;
  if (typeof value === "object" && value !== null && "decision" in value && value.decision === "deny"
    && "reason" in value && typeof value.reason === "string") {
    const reason = sanitizeDenyReason(value.reason);
    return reason ? { decision: "deny", reason } : "deny";
  }
  return "deny";
}

/**
 * Returns "abstain" when no handler claims the request. A handler that throws
 * or returns an unknown value counts as "deny". Rethrows only when `signal` aborted.
 */
export async function requestBrokerApproval(
  events: ExtensionAPI["events"] | undefined,
  serverName: string,
  toolMeta: Pick<ToolMetadata, "name" | "originalName">,
  args: Record<string, unknown> | undefined,
  origin: McpToolApprovalOrigin,
  signal?: AbortSignal,
): Promise<McpToolApprovalHandlerResult> {
  if (!events) return "abstain";

  let acceptingClaim = true;
  let handler: McpToolApprovalHandler | undefined;
  const request: McpToolApprovalRequest = {
    requestId: randomUUID(),
    serverName,
    originalToolName: toolMeta.originalName,
    prefixedToolName: toolMeta.name,
    args: args ?? {},
    origin,
    ...(signal !== undefined ? { signal } : {}),
    supportsDenyReason: true,
    claim(candidate: McpToolApprovalHandler) {
      if (!acceptingClaim || handler) return false;
      handler = candidate;
      return true;
    },
  };

  events.emit(MCP_TOOL_APPROVAL_REQUEST_EVENT, request);
  acceptingClaim = false;
  if (!handler) return "abstain";

  try {
    const decision = await abortable(Promise.resolve().then(handler), signal);
    return normalizeHandlerResult(decision);
  } catch (error) {
    if (signal?.aborted) throw error;
    return "deny";
  }
}

export async function ensureToolCallApproved(
  state: McpExtensionState,
  serverName: string,
  toolMeta: ToolMetadata,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  origin: McpToolApprovalOrigin = toolMeta.resourceUri ? "resource" : "proxy",
  approvalMetadata?: ReadonlyMap<string, readonly ToolMetadata[]>,
): Promise<ToolCallApprovalResult> {
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  const approvedServers = state.approvedServers ??= new Map();
  const serverIdentity = getServerApprovalIdentity(state, serverName);
  const brokerDecision = await requestBrokerApproval(state.approvalEvents, serverName, toolMeta, args, origin, signal);
  if (brokerDecision === "allow_once") return { ok: true };
  if (brokerDecision === "allow_for_session") {
    rememberToolApproval(state, serverName, toolMeta, args);
    return { ok: true };
  }
  if (brokerDecision === "deny") return { ok: false, reason: "denied" };
  if (typeof brokerDecision === "object") return { ok: false, reason: "denied", denyReason: brokerDecision.reason };

  const serverGrant = approvedServers.get(serverName);
  const liveServerIdentity = getServerApprovalIdentity(state, serverName);
  if (serverGrant && state.approvedServers === approvedServers
    && serverGrant.definition === liveServerIdentity?.definition && serverGrant.hash === liveServerIdentity?.hash) {
    ownedSignal?.throwIfAborted();
    return { ok: true };
  }
  approvedServers.delete(serverName);

  const { cacheKey } = getToolApprovalIdentity(serverName, toolMeta, args);
  const approvedToolCalls = state.approvedToolCalls ??= new Map<string, true>();
  if (approvedToolCalls.has(cacheKey)) {
    return { ok: true };
  }

  if (!isToolCallApprovalRequired(state.config, serverName, toolMeta, approvalMetadata ?? state.toolMetadata)) {
    return { ok: true };
  }

  if (!state.ui) {
    return { ok: false, reason: "approval_required_headless" };
  }

  const json = JSON.stringify(args ?? {}, null, 2);
  const sanitized = sanitizeTerminalText(json);
  const preview = sanitized.length > 500 ? `${sanitized.slice(0, 500)}...` : sanitized;
  const title = `MCP: ${sanitizeTerminalText(serverName)} wants to run ${sanitizeTerminalText(toolMeta.originalName)}`;
  const hint = toolMeta.annotations?.destructiveHint === true
    ? "\n\nThe server marks this tool as destructive: it may delete or overwrite data."
    : toolMeta.annotations?.readOnlyHint === true
      ? "\n\nThe server marks this tool as read-only."
      : "";
  const serverScope = "Allow server for this session permits all tools and arguments on this server until reload or session/branch change. Other security and UI consent checks still apply.";
  const decision = await abortable(
    state.ui.select(
      `${title}${hint}\n\nArguments:\n${preview}\n\n${serverScope}`,
      ["Allow once", "Allow for session", "Allow server for this session", "Deny"],
    ),
    ownedSignal,
  );

  if (decision === "Allow server for this session") {
    ownedSignal?.throwIfAborted();
    const currentIdentity = getServerApprovalIdentity(state, serverName);
    if (!serverIdentity || state.approvedServers !== approvedServers
      || currentIdentity?.definition !== serverIdentity.definition || currentIdentity.hash !== serverIdentity.hash) {
      return { ok: false, reason: "denied" };
    }
    approvedServers.set(serverName, serverIdentity);
    return { ok: true };
  }
  if (decision === "Allow once") {
    return { ok: true };
  }
  if (decision === "Allow for session") {
    rememberToolApproval(state, serverName, toolMeta, args);
    return { ok: true };
  }
  if (decision === "Deny") return { ok: false, reason: "denied", denyReason: "The user denied it in the approval dialog." };
  return { ok: false, reason: "denied" };
}
