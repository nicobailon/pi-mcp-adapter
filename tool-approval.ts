import { randomUUID } from "node:crypto";
import { abortable } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { McpExtensionState } from "./state.ts";
import {
  getToolNameCandidates,
  matchesToolPattern,
  resolveToolPrefix,
  MCP_TOOL_APPROVAL_REQUEST_EVENT,
  type McpConfig,
  type McpToolApprovalDecision,
  type McpToolApprovalHandler,
  type McpToolApprovalOrigin,
  type McpToolApprovalRequest,
  type ToolMetadata,
} from "./types.ts";
import { sanitizeTerminalText } from "./utils.ts";

export type ToolCallApprovalResult =
  | { ok: true }
  | { ok: false; reason: "denied" | "approval_required_headless" };

export function isToolCallApprovalRequired(
  config: McpConfig,
  serverName: string,
  toolMeta: Pick<ToolMetadata, "originalName">,
  toolMetadata?: ReadonlyMap<string, readonly ToolMetadata[]>,
): boolean {
  const definition = config.mcpServers[serverName];
  const serverApproval = definition?.approveTools;
  const approval = serverApproval !== undefined ? serverApproval : config.settings?.approveTools;

  if (approval === true) return true;
  if (!Array.isArray(approval) || approval.length === 0) return false;

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

async function requestBrokerApproval(
  state: McpExtensionState,
  serverName: string,
  toolMeta: ToolMetadata,
  args: Record<string, unknown> | undefined,
  origin: McpToolApprovalOrigin,
  signal?: AbortSignal,
): Promise<McpToolApprovalDecision> {
  if (!state.approvalEvents) return "abstain";

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
    claim(candidate: McpToolApprovalHandler) {
      if (!acceptingClaim || handler) return false;
      handler = candidate;
      return true;
    },
  };

  state.approvalEvents.emit(MCP_TOOL_APPROVAL_REQUEST_EVENT, request);
  acceptingClaim = false;
  if (!handler) return "abstain";

  try {
    const decision = await abortable(Promise.resolve().then(handler), signal);
    return isMcpToolApprovalDecision(decision) ? decision : "deny";
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
  const cacheKey = `${serverName}\u0000${toolMeta.originalName}`;
  const approvedToolCalls = state.approvedToolCalls ??= new Map<string, true>();
  if (approvedToolCalls.has(cacheKey)) {
    return { ok: true };
  }

  const brokerDecision = await requestBrokerApproval(state, serverName, toolMeta, args, origin, signal);
  if (brokerDecision === "allow_once") return { ok: true };
  if (brokerDecision === "allow_for_session") {
    approvedToolCalls.set(cacheKey, true);
    return { ok: true };
  }
  if (brokerDecision === "deny") return { ok: false, reason: "denied" };

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
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  const decision = await abortable(
    state.ui.select(
      `${title}\n\nArguments:\n${preview}`,
      ["Allow once", "Allow for session", "Deny"],
    ),
    ownedSignal,
  );

  if (decision === "Allow once") {
    return { ok: true };
  }
  if (decision === "Allow for session") {
    approvedToolCalls.set(cacheKey, true);
    return { ok: true };
  }
  return { ok: false, reason: "denied" };
}
