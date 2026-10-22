import { open, stat } from "node:fs/promises";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { CODEMODE_UNAVAILABLE, runCodemodeScript } from "./codemode-bridge.ts";
import type { ContentBlock, McpSettings, ScriptToolDefinition } from "./types.ts";

export const SCRIPT_TOOL_NAMESPACE = "mcp__script";
export const MAX_SCRIPT_BYTES = 1024 * 1024;

export interface ScriptToolSpec {
  /** The name in `scriptTools`. */
  name: string;
  /** The Pi tool name, `mcp__script__<name>`. */
  toolName: string;
  definition: ScriptToolDefinition;
}

/** Names a script tool must not take, and why. Checked in order. */
export interface ScriptToolReservation {
  names: ReadonlySet<string>;
  reason: string;
}

/**
 * The script tools to register, by Pi name. One whose name is already taken is left out, with the
 * reason: the operator chose both names, so neither is renamed. `owners` holds the key each name was
 * first given to this session; a name given to another tool stays that tool's.
 */
export function resolveScriptToolSpecs(
  scriptTools: Record<string, ScriptToolDefinition> | undefined,
  reservations: readonly ScriptToolReservation[],
  owners: ReadonlyMap<string, string>,
): { specs: ScriptToolSpec[]; issues: string[] } {
  const specs: ScriptToolSpec[] = [];
  const issues: string[] = [];
  for (const [name, definition] of Object.entries(scriptTools ?? {})) {
    const toolName = `${SCRIPT_TOOL_NAMESPACE}__${name}`;
    const reason = scriptToolNameConflict(name, reservations, owners);
    if (reason) issues.push(`Script tool "${name}" was not loaded — ${toolName} ${reason}.`);
    else specs.push({ name, toolName, definition });
  }
  return { specs, issues };
}

/** Why `mcp__script__<name>` cannot go to the script tool `name`, or undefined when it can. */
export function scriptToolNameConflict(name: string, reservations: readonly ScriptToolReservation[], owners: ReadonlyMap<string, string>): string | undefined {
  const toolName = `${SCRIPT_TOOL_NAMESPACE}__${name}`;
  const owner = owners.get(toolName);
  return reservations.find((reservation) => reservation.names.has(toolName))?.reason
    ?? (owner !== undefined && owner !== scriptToolOwnerKey(name) ? "was given to an MCP tool earlier in this session" : undefined);
}

/** The `deferredNameOwners` key of a script tool; never equal to an MCP tool's deferredToolKey. */
export function scriptToolOwnerKey(name: string): string {
  return JSON.stringify(["script", name]);
}

/** The script tool `mcp({ tool })` or `mcp({ describe })` names, by its config name or its Pi name. */
export function findScriptTool<T extends Pick<ScriptToolSpec, "name" | "toolName">>(specs: readonly T[], name: string): T | undefined {
  return specs.find((spec) => spec.name === name || spec.toolName === name);
}

type ScriptToolResult = AgentToolResult<Record<string, unknown>>;

function failure(tool: string, error: string, text: string): ScriptToolResult {
  return { content: [{ type: "text", text }], details: { mode: "script_tool", tool, error } };
}

/** A script tool called by another tool, a codemode script included, starts no second sandbox. */
export function nestedScriptToolResult(tool: string): ScriptToolResult {
  return failure(tool, "nested_script_tool",
    `Script tool "${tool}" cannot run inside another script. Pi does not let a codemode script start another script, so call this tool directly.`);
}

async function readScript(tool: string, file: string): Promise<string | ScriptToolResult> {
  try {
    const info = await stat(file);
    // A FIFO or a device reports no size and may never end, so only regular files are read.
    if (!info.isFile() && !info.isDirectory()) {
      return failure(tool, "script_file_unreadable", `Script tool "${tool}" cannot run: ${file} could not be read (not a regular file).`);
    }
    // One handle, read up to one byte past the limit, so a file that grows after stat is still bounded.
    const handle = await open(file, "r");
    const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1);
    let length = 0;
    try {
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
    } finally {
      await handle.close();
    }
    if (length > MAX_SCRIPT_BYTES) {
      return failure(tool, "script_file_too_large", `Script tool "${tool}" cannot run: ${file} is larger than 1 MiB.`);
    }
    const source = buffer.toString("utf8", 0, length);
    if (source.trim() === "") return failure(tool, "script_file_empty", `Script tool "${tool}" cannot run: ${file} is empty.`);
    return source;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return failure(tool, "script_file_missing", `Script tool "${tool}" cannot run: its script file ${file} does not exist.`);
    }
    return failure(tool, "script_file_unreadable",
      `Script tool "${tool}" cannot run: ${file} could not be read (${error instanceof Error ? error.message : String(error)}).`);
  }
}

export interface RunScriptToolOptions {
  pi: ExtensionAPI;
  ctx: ExtensionToolContext;
  toolCallId: string;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<unknown> | undefined;
  spec: ScriptToolSpec;
  input: Record<string, unknown>;
  /** The adapter settings, for the output guard. */
  settings: McpSettings | undefined;
}

/**
 * Read the script now, so the call runs what the file holds, and run it in Pi's codemode. The result
 * goes to the model, so the output guard applies.
 */
export async function runScriptTool(options: RunScriptToolOptions): Promise<ScriptToolResult> {
  const { spec } = options;
  const source = await readScript(spec.name, spec.definition.file);
  if (typeof source !== "string") return source;
  const result = await runCodemodeScript({
    pi: options.pi, ctx: options.ctx, toolCallId: options.toolCallId, signal: options.signal, onUpdate: options.onUpdate,
    tool: spec.name, source, input: options.input,
  });
  const details = (result.details ?? {}) as Record<string, unknown>;
  if (details.error === CODEMODE_UNAVAILABLE) return result as ScriptToolResult;
  const { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } = await import("./mcp-output-guard.ts");
  const guarded = await guardMcpOutput(result.content as ContentBlock[], resolveMcpOutputGuardOptions(options.settings));
  return {
    ...result,
    content: guarded.content as ScriptToolResult["content"],
    details: {
      mode: "script_tool", tool: spec.name, calls: details.calls ?? [],
      // Where codemode saved the whole output when it cut it; the guard below can cut its notice off.
      ...(typeof details.fullOutputPath === "string" ? { fullOutputPath: details.fullOutputPath } : {}),
      ...guardedMcpDetails(guarded),
    },
  };
}
