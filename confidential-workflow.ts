import type { CallToolResult } from "@modelcontextprotocol/client";
import type { McpExtensionState } from "./state.ts";
import { throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { runWithoutMcpTrace } from "./mcp-trace.ts";
import {
  formatToolName,
  isServerDisabled,
  resolveToolPrefix,
  type ToolMetadata,
} from "./types.ts";
import { ensureToolCallApproved } from "./tool-approval.ts";

/**
 * The confidential bridge is deliberately an allowlist, not a general-purpose
 * raw MCP escape hatch. Add a workflow here only when its safe projection and
 * owning extension have been reviewed together.
 */
export const MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD =
  "dps-catalog-local-upload:v1" as const;

export type McpConfidentialWorkflowName =
  typeof MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD;

export const MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD_TOOLS = Object.freeze([
  "presign_file_upload",
  "confirm_file_upload",
]) as readonly ["presign_file_upload", "confirm_file_upload"];

export interface ConfidentialWorkflowSpec {
  readonly serverName: "eproduct-catalog";
  readonly tools: typeof MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD_TOOLS;
}

const CATALOG_LOCAL_UPLOAD_SPEC: ConfidentialWorkflowSpec = Object.freeze({
  serverName: "eproduct-catalog",
  tools: MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD_TOOLS,
});

const CONFIDENTIAL_TOOL_ARGUMENT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  presign_file_upload: new Set(["store_id", "locale", "filename", "size_bytes"]),
  confirm_file_upload: new Set(["upload_id", "store_id", "filename", "locale"]),
});

const CONFIDENTIAL_STORE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/;
const CONFIDENTIAL_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/;
const CONFIDENTIAL_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:pdf|xlsx)$/;
const CONFIDENTIAL_UPLOAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONFIDENTIAL_MAX_FILENAME_LENGTH = 256;
const CONFIDENTIAL_MAX_FILE_SIZE = 100 * 1024 * 1024;
const CONFIDENTIAL_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    return keys.every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable === true;
    });
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expected.size &&
      keys.every((key) => typeof key === "string" && expected.has(key));
  } catch {
    return false;
  }
}

function isSafeBoundedString(value: unknown, pattern: RegExp, maximum: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONFIDENTIAL_CONTROL_CHARACTER_PATTERN.test(value) &&
    pattern.test(value);
}

function validateConfidentialArguments(
  toolName: string,
  args: unknown,
): Record<string, unknown> {
  if (!isPlainRecord(args)) fail("invalid_request");
  const expectedKeys = CONFIDENTIAL_TOOL_ARGUMENT_KEYS[toolName];
  if (!expectedKeys || !hasExactKeys(args, expectedKeys)) fail("invalid_request");

  const values = Object.fromEntries(Object.keys(args).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    return [key, descriptor && "value" in descriptor ? descriptor.value : undefined];
  }));
  if (toolName === "presign_file_upload") {
    if (!isSafeBoundedString(values.store_id, CONFIDENTIAL_STORE_PATTERN, 30) ||
      !isSafeBoundedString(values.locale, CONFIDENTIAL_LOCALE_PATTERN, 8) ||
      !isSafeBoundedString(values.filename, CONFIDENTIAL_FILENAME_PATTERN, CONFIDENTIAL_MAX_FILENAME_LENGTH) ||
      Number.isSafeInteger(values.size_bytes) === false ||
      (values.size_bytes as number) < 1 ||
      (values.size_bytes as number) > CONFIDENTIAL_MAX_FILE_SIZE ||
      /[\\/]/.test(values.filename)) {
      fail("invalid_request");
    }
  } else if (
    !isSafeBoundedString(values.upload_id, CONFIDENTIAL_UPLOAD_ID_PATTERN, 128) ||
    !isSafeBoundedString(values.store_id, CONFIDENTIAL_STORE_PATTERN, 30) ||
    !isSafeBoundedString(values.filename, CONFIDENTIAL_FILENAME_PATTERN, CONFIDENTIAL_MAX_FILENAME_LENGTH) ||
    !isSafeBoundedString(values.locale, CONFIDENTIAL_LOCALE_PATTERN, 8) ||
    /[\\/]/.test(values.filename)
  ) {
    fail("invalid_request");
  }

  // Approval handlers are other extensions. Keep their preview immutable so
  // a handler cannot rewrite the validated payload before the MCP call.
  return Object.freeze(values) as Record<string, unknown>;
}

/** Return the immutable allowlist entry for the one supported trusted workflow. */
export function getConfidentialWorkflowSpec(
  name: string,
): ConfidentialWorkflowSpec | undefined {
  if (name !== MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD) return undefined;
  return CATALOG_LOCAL_UPLOAD_SPEC;
}

/** Stable, non-sensitive errors exposed by the confidential bridge. */
export type McpConfidentialErrorCode =
  | "invalid_request"
  | "workflow_not_registered"
  | "tool_not_registered"
  | "server_not_found"
  | "server_disabled"
  | "server_not_connected"
  | "auth_required"
  | "approval_denied"
  | "approval_required"
  | "aborted"
  | "call_failed";

export class McpConfidentialError extends Error {
  readonly code: McpConfidentialErrorCode;

  constructor(code: McpConfidentialErrorCode) {
    super(`Confidential MCP operation failed (${code})`);
    this.name = "McpConfidentialError";
    this.code = code;
  }
}

/**
 * The raw SDK result is available only to trusted extension code. A workflow
 * implementation must project it before returning anything from a model-facing
 * tool. This type is intentionally not part of any registered Pi tool schema.
 */
export type McpConfidentialCallResult = CallToolResult;

/** Trusted extension handle returned by the fixed, versioned allowlist. */
export interface McpConfidentialWorkflow {
  readonly name: McpConfidentialWorkflowName;
  readonly serverName: "eproduct-catalog";
  call(
    toolName: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpConfidentialCallResult>;
  dispose(): Promise<void>;
}

export type McpConfidentialWorkflowRegistrationResult =
  | { ok: true; workflow: McpConfidentialWorkflow }
  | { ok: false; error: McpConfidentialError };

function fail(code: McpConfidentialErrorCode): never {
  throw new McpConfidentialError(code);
}

function isAbortLike(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Execute one registered confidential MCP operation without going through the
 * model-facing proxy/direct-tool execution path. Approval is handled by the
 * existing broker contract with validated arguments. No result guard, renderer,
 * UI session, metadata publication, normal MCP trace, or provider error is
 * returned by this function.
 */
export async function executeConfidentialToolCall(
  state: McpExtensionState,
  serverName: string,
  toolName: string,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<McpConfidentialCallResult> {
  if (typeof serverName !== "string" || typeof toolName !== "string" || !serverName.trim() || !toolName.trim()) {
    fail("invalid_request");
  }
  if (
    serverName !== CATALOG_LOCAL_UPLOAD_SPEC.serverName ||
    !MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD_TOOLS.includes(
      toolName as typeof MCP_CONFIDENTIAL_WORKFLOW_CATALOG_LOCAL_UPLOAD_TOOLS[number],
    )
  ) fail("tool_not_registered");
  const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
  try {
    throwIfAborted(ownedSignal);
  } catch {
    fail("aborted");
  }

  const normalizedArgs = validateConfidentialArguments(toolName, args);

  const definition = state.config.mcpServers[serverName];
  if (!definition) fail("server_not_found");
  if (isServerDisabled(definition)) fail("server_disabled");

  const toolMeta: ToolMetadata = {
    name: formatToolName(toolName, serverName, resolveToolPrefix(definition, state.config.settings?.toolPrefix)),
    originalName: toolName,
    description: `Confidential workflow tool ${toolName}`,
  };
  let approval: Awaited<ReturnType<typeof ensureToolCallApproved>>;
  try {
    approval = await ensureToolCallApproved(
      state,
      serverName,
      toolMeta,
      normalizedArgs,
      ownedSignal,
      "proxy",
      new Map([[serverName, [toolMeta]]]),
    );
  } catch (error) {
    if (isAbortLike(error, ownedSignal)) fail("aborted");
    // Approval handlers are extension-owned, but an unexpected handler/UI
    // failure must not expose its error or accidentally authorize the call.
    fail("call_failed");
  }
  if (!approval.ok) {
    fail(approval.reason === "denied" ? "approval_denied" : "approval_required");
  }

  let connection = state.manager.getConnection(serverName);
  try {
    if (!connection || connection.status === "closed") {
      connection = await runWithoutMcpTrace(() =>
        state.manager.connect(serverName, definition, ownedSignal)
      );
    }
  } catch (error) {
    if (isAbortLike(error, ownedSignal)) throw new McpConfidentialError("aborted");
    // Deliberately drop the provider error. It can contain URLs, headers, or
    // response bodies and must never become a transcript-visible error.
    fail("call_failed");
  }

  if (connection.status === "needs-auth") fail("auth_required");
  if (connection.status !== "connected") fail("server_not_connected");

  try {
    return await runWithoutMcpTrace(() =>
      state.manager.callTool(serverName, toolName, normalizedArgs, ownedSignal)
    );
  } catch (error) {
    if (isAbortLike(error, ownedSignal)) throw new McpConfidentialError("aborted");
    // Never preserve the raw CallToolResult or provider exception on failure.
    fail("call_failed");
  }
}

/** Apply trusted workflow exclusions to a freshly loaded adapter config. */
export function applyConfidentialToolFilters(
  config: { mcpServers: Record<string, { excludeTools?: string[] }> },
  tools: Record<string, string[]> | undefined,
): void {
  if (!tools) return;
  for (const [serverName, names] of Object.entries(tools)) {
    const definition = config.mcpServers[serverName];
    if (!definition || !Array.isArray(names) || names.length === 0) continue;
    const excluded = new Set(definition.excludeTools ?? []);
    for (const toolName of names) {
      if (typeof toolName === "string" && toolName.trim()) {
        excluded.add(toolName.trim());
      }
    }
    const nextExcluded = [...excluded];
    if (
      Array.isArray(definition.excludeTools) &&
      definition.excludeTools.length === nextExcluded.length &&
      definition.excludeTools.every((toolName, index) => toolName === nextExcluded[index])
    ) continue;
    config.mcpServers[serverName] = { ...definition, excludeTools: nextExcluded };
  }
}

export interface ConfidentialCallExecutor {
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<McpConfidentialCallResult>;
}

/**
 * Build the executor used by the adapter's in-process broker. Keeping this
 * boundary small lets tests prove authorization and error redaction without
 * starting a Pi session.
 */
export function createConfidentialCallExecutor(
  getState: () => McpExtensionState | null,
  isRegistered: (serverName: string, toolName: string) => boolean,
): ConfidentialCallExecutor {
  return {
    async callTool(serverName, toolName, args, signal) {
      if (!isRegistered(serverName, toolName)) fail("tool_not_registered");
      const state = getState();
      if (!state) fail("server_not_connected");
      return executeConfidentialToolCall(state, serverName, toolName, args, signal);
    },
  };
}
