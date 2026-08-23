import type { McpExtensionState } from "./state.ts";
import {
  MCP_STATUS_EVENT,
  MCP_STATUS_SNAPSHOT_VERSION,
  type McpServerStatusSnapshot,
  type McpStatusEventBus,
  type McpStatusSnapshot,
} from "./types.ts";
import { getFailureAgeSeconds, isServerInActiveFailureBackoff } from "./failure-backoff.ts";

/** Build a sanitized snapshot without connecting or querying any MCP server. */
export function createMcpStatusSnapshot(state: McpExtensionState): McpStatusSnapshot {
  const servers: McpServerStatusSnapshot[] = [];
  let totalTools = 0;
  let totalResources = 0;
  let connectedCount = 0;
  let disabledCount = 0;

  for (const name of Object.keys(state.config.mcpServers)) {
    const definition = state.config.mcpServers[name];
    const disabled = definition?.disabled === true;
    const connection = disabled ? undefined : state.manager.getConnection(name);
    const failedAgoSeconds = disabled ? null : getFailureAgeSeconds(state, name);
    const activeFailure = !disabled && isServerInActiveFailureBackoff(state, name);
    const metadata = disabled || activeFailure ? undefined : state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? (connection?.status === "connected" ? connection.tools.length : 0);
    const resourceCount = disabled || activeFailure
      ? undefined
      : state.resourceCounts?.get(name) ?? (connection?.status === "connected" ? connection.resources.length : undefined);

    let status: McpServerStatusSnapshot["status"] = "not-connected";
    if (disabled) {
      status = "disabled";
      disabledCount++;
    } else if (connection?.status === "connected") {
      status = "connected";
      connectedCount++;
    } else if (connection?.status === "needs-auth") {
      status = "needs-auth";
    } else if (activeFailure) {
      status = "failed";
    } else if (metadata !== undefined) {
      status = "cached";
    }

    totalTools += disabled ? 0 : toolCount;
    if (!disabled && resourceCount !== undefined) totalResources += resourceCount;
    servers.push({
      name,
      status,
      toolCount,
      ...(resourceCount !== undefined ? { resourceCount } : {}),
      ...(status === "failed" && failedAgoSeconds !== null ? { failedAgoSeconds } : {}),
      disabled,
    });
  }

  return {
    version: MCP_STATUS_SNAPSHOT_VERSION,
    servers,
    totalTools,
    totalResources,
    connectedCount,
    disabledCount,
  };
}

export function publishMcpStatusSnapshot(
  state: McpExtensionState,
  snapshot?: McpStatusSnapshot,
): void {
  const events = state.statusEvents;
  if (!events) return;
  try {
    events.emit(MCP_STATUS_EVENT, snapshot ?? createMcpStatusSnapshot(state));
  } catch {
    // Event consumers must not be able to interrupt MCP operations.
  }
}

export function publishMcpStatusShutdown(events: McpStatusEventBus | undefined): void {
  if (!events) return;
  try {
    events.emit(MCP_STATUS_EVENT, {
      version: MCP_STATUS_SNAPSHOT_VERSION,
      servers: [],
      totalTools: 0,
      totalResources: 0,
      connectedCount: 0,
      disabledCount: 0,
    } satisfies McpStatusSnapshot);
  } catch {
    // Event consumers must not be able to interrupt MCP shutdown.
  }
}

export type { McpServerStatusSnapshot, McpStatusSnapshot } from "./types.ts";
export { MCP_STATUS_EVENT, MCP_STATUS_SNAPSHOT_VERSION } from "./types.ts";
