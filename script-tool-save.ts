import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildUnifiedDiff, getPiGlobalConfigPath, getProjectPiConfigPath, previewScriptToolEntry, writeScriptToolEntry } from "./config.ts";
import { MAX_SCRIPT_BYTES, SCRIPT_TOOL_NAMESPACE } from "./script-tool-surface.ts";
import { resolveScriptToolPath, validateScriptToolEntry } from "./script-tools.ts";
import type { ScriptToolDefinition } from "./types.ts";

// The save never compiles or runs the code: scripts run only in Pi's codemode sandbox.

export type ScriptToolSaveTargetKind = "global" | "project";

export interface ScriptToolSaveTarget {
  configPath: string;
  scriptPath: string;
  /** The entry's `file`, relative to the config file's directory, with `/` on every platform. */
  file: string;
}

export interface ScriptToolSaveRequest {
  /** The save call's `args`, not yet validated. */
  args: unknown;
  target: ScriptToolSaveTargetKind;
  cwd: string;
  /** `--mcp-config`, which replaces the global config path. */
  configOverridePath?: string;
  /** The loaded config's script tools. */
  scriptTools: Record<string, ScriptToolDefinition> | undefined;
  /** The script tools a project config file defines, as `loadMcpConfigWithSources` reports them. */
  projectScriptTools: ReadonlyMap<string, { path: string }> | undefined;
}

export type ScriptToolSaveError = "missing_input" | "invalid_entry" | "code_empty" | "code_too_large" | "code_invalid" | "name_shadowed" | "script_save_failed";

export interface ScriptToolSaveRefusal {
  ok: false;
  error: ScriptToolSaveError;
  message: string;
  name?: string;
  /** The project config file that defines the name, for `name_shadowed`. */
  shadowedBy?: string;
}

export interface ScriptToolSavePlan extends ScriptToolSaveTarget {
  ok: true;
  name: string;
  target: ScriptToolSaveTargetKind;
  /** The entry as written, with `file` relative. */
  entry: ScriptToolDefinition;
  code: string;
  /** Set when the loaded config already has the name or the script file exists. */
  overwrite?: { entry?: ScriptToolDefinition; scriptExisted: boolean };
}

const OPTIONS_PREFIX = "// @options:";
// `target` is read by the save action itself.
const SAVE_ARGS = new Set(["name", "description", "code", "inputSchema", "target"]);
const MAX_DIFF_LINES = 60;
const DIFF_CONTEXT = 3;
const MISSING_INPUT = 'save-script requires args with name, description and code. Example: mcp({ action: "save-script", args: { name: "stale_issues", description: "...", code: "..." } })';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a save writes: the script goes to `mcp-scripts/<name>.js` beside the target config file. */
export function resolveScriptToolSaveTarget(
  target: ScriptToolSaveTargetKind,
  name: string,
  paths: { cwd: string; configOverridePath?: string },
): ScriptToolSaveTarget {
  const configPath = target === "global" ? getPiGlobalConfigPath(paths.configOverridePath) : getProjectPiConfigPath(paths.cwd);
  const file = `mcp-scripts/${name}.js`;
  return { configPath, scriptPath: resolveScriptToolPath(file, dirname(configPath)), file };
}

function refusal(error: ScriptToolSaveError, name: string, reason: string): ScriptToolSaveRefusal {
  return { ok: false, error, name, message: `Cannot save script tool "${name}": ${reason}.` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The checks a script's text must pass before it is written: not empty, at most 1 MiB, no NUL
 * byte, and more than a lone `// @options:` line, which codemode refuses to run.
 */
export function checkScriptToolCode(name: string, code: string): ScriptToolSaveRefusal | undefined {
  if (code.trim() === "") return refusal("code_empty", name, "the code is empty");
  if (Buffer.byteLength(code, "utf8") > MAX_SCRIPT_BYTES) return refusal("code_too_large", name, "the code is larger than 1 MiB");
  if (code.includes("\0")) return refusal("code_invalid", name, "the code contains a NUL byte");
  const lines = code.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 1 && lines[0]!.trimStart().startsWith(OPTIONS_PREFIX)) {
    return refusal("code_invalid", name, "the code is only a // @options: line, with no script after it");
  }
  return undefined;
}

/** Decide whether a requested save can be offered, and exactly what it would write. */
export function checkScriptToolSave(request: ScriptToolSaveRequest): ScriptToolSavePlan | ScriptToolSaveRefusal {
  const args = isRecord(request.args) ? request.args : {};
  const { name, description, code, inputSchema } = args;
  if (typeof name !== "string" || typeof description !== "string" || typeof code !== "string") {
    return { ok: false, error: "missing_input", message: MISSING_INPUT, ...(typeof name === "string" ? { name } : {}) };
  }
  const unknownKey = Object.keys(args).find((key) => !SAVE_ARGS.has(key));
  if (unknownKey !== undefined) return refusal("invalid_entry", name, `unknown field ${JSON.stringify(unknownKey)}`);
  const target = resolveScriptToolSaveTarget(request.target, name, request);
  const entry: ScriptToolDefinition = { description, file: target.file, ...(inputSchema !== undefined ? { inputSchema: inputSchema as Record<string, unknown> } : {}) };
  // Validated before any path built from the name is touched.
  const validated = validateScriptToolEntry(name, entry, dirname(target.configPath));
  if (typeof validated === "string") return refusal("invalid_entry", name, validated);
  if (validated.file !== target.scriptPath) throw new Error(`Script tool "${name}" resolves to ${validated.file}, not ${target.scriptPath}`);
  const codeRefusal = checkScriptToolCode(name, code);
  if (codeRefusal) return codeRefusal;

  // A project entry wins over a global one, so a global save of that name would never load.
  const shadowedBy = request.target === "global" ? request.projectScriptTools?.get(name)?.path : undefined;
  if (shadowedBy !== undefined) {
    return {
      ok: false, error: "name_shadowed", name, shadowedBy,
      message: `Cannot save script tool "${name}" globally: ${shadowedBy} already defines it and takes precedence. Save it with target: "project", or remove the project entry.`,
    };
  }

  let existing: ReturnType<typeof lstatSync>;
  try {
    existing = lstatSync(target.scriptPath, { throwIfNoEntry: false });
  } catch (error) {
    return refusal("script_save_failed", name, `${target.scriptPath} cannot be checked (${errorMessage(error)})`);
  }
  // Renaming over a symlink would replace the link, so only a regular file is replaced.
  if (existing && !existing.isFile()) return refusal("script_save_failed", name, `${target.scriptPath} is not a regular file`);
  try {
    previewScriptToolEntry(target.configPath, name, entry);
  } catch (error) {
    return refusal("script_save_failed", name, errorMessage(error));
  }
  const existingEntry = request.scriptTools?.[name];
  const scriptExisted = existing !== undefined;
  return {
    ok: true, name, target: request.target, ...target, entry, code,
    ...(existingEntry || scriptExisted ? { overwrite: { ...(existingEntry ? { entry: existingEntry } : {}), scriptExisted } } : {}),
  };
}

function countLines(text: string): number {
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function hasEntry(configText: string, name: string): boolean {
  if (configText === "") return false;
  const scriptTools = (JSON.parse(configText) as Record<string, unknown>).scriptTools;
  return isRecord(scriptTools) && Object.hasOwn(scriptTools, name);
}

/** The summary the operator approves before reviewing the script: both files, the config diff and any script diff. */
export function buildScriptToolSavePrompt(plan: ScriptToolSavePlan): string {
  const preview = previewScriptToolEntry(plan.configPath, plan.name, plan.entry);
  const scriptExisted = plan.overwrite?.scriptExisted === true;
  const lineCount = countLines(plan.code);
  const configState = !preview.existed ? "new file" : hasEntry(preview.beforeText, plan.name) ? "entry replaced" : "new entry";
  const lines = [
    `Save script tool "${plan.name}" as ${SCRIPT_TOOL_NAMESPACE}__${plan.name}?`,
    "",
    `Script: ${plan.scriptPath} (${scriptExisted ? "replaced" : "new"}, ${lineCount} ${lineCount === 1 ? "line" : "lines"})`,
    `Config: ${plan.configPath} (${configState})`,
  ];
  // The loaded entry can come from a file other than the target, which the config diff cannot show.
  if (plan.overwrite?.entry && configState !== "entry replaced") {
    lines.push(`This name already runs ${plan.overwrite.entry.file}, from another config file; the new entry takes precedence.`);
  }
  // The writer re-serializes the parsed config, which the diff cannot show. A blank file loses nothing.
  if (preview.existed) {
    const raw = readFileSync(plan.configPath, "utf8");
    if (raw.trim() !== "" && raw !== preview.beforeText) lines.push("Comments and formatting in this file will be rewritten.");
  }
  if (plan.target === "project") {
    lines.push("", "Approving a project script tool covers its entry, not the script. The script file can change without asking you again.");
  }
  lines.push("", "Config change:", ...boundedDiff(preview.beforeText, preview.afterText));
  if (scriptExisted) {
    let before: string;
    try {
      before = readFileSync(plan.scriptPath, "utf8");
    } catch (error) {
      throw new Error(`Failed to read script tool file at ${plan.scriptPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    lines.push("", "Script change:", ...boundedDiff(before, plan.code));
  }
  return lines.join("\n");
}

function boundedDiff(before: string, after: string): string[] {
  const diff = buildUnifiedDiff(before, after, { context: DIFF_CONTEXT }).split("\n");
  if (diff.length <= MAX_DIFF_LINES) return diff;
  return [...diff.slice(0, MAX_DIFF_LINES), `… (${diff.length - MAX_DIFF_LINES} more lines)`];
}

// Another save may have written into the directory meanwhile, and then it stays.
function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  }
}

function writeFileAtomic(path: string, data: string | Buffer, mode: number | undefined): void {
  const tmpPath = `${path}.${process.pid}.tmp`;
  rmSync(tmpPath, { force: true });
  try {
    writeFileSync(tmpPath, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(tmpPath, mode);
    renameSync(tmpPath, path);
  } catch (error) {
    try { rmSync(tmpPath, { force: true }); } catch {}
    throw error;
  }
}

/**
 * Write the script, then the config entry. When the config write fails, a script file this save
 * created is removed, with its `mcp-scripts/` directory if the save created it and it is empty, and
 * one it replaced is restored; then the config error is thrown.
 */
export function writeScriptToolSave(plan: Pick<ScriptToolSavePlan, "name" | "configPath" | "scriptPath" | "entry" | "code">): void {
  const { scriptPath } = plan;
  let previous: { bytes: Buffer; mode: number } | undefined;
  let createdDir = false;
  try {
    const existing = lstatSync(scriptPath, { throwIfNoEntry: false });
    // Renaming over a symlink would replace the link, so only a regular file is replaced.
    if (existing && !existing.isFile()) throw new Error("it is not a regular file");
    if (existing) previous = { bytes: readFileSync(scriptPath), mode: existing.mode & 0o777 };
    createdDir = mkdirSync(dirname(scriptPath), { recursive: true }) !== undefined;
    writeFileAtomic(scriptPath, plan.code, previous?.mode);
  } catch (error) {
    throw new Error(`Failed to write script tool file at ${scriptPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  try {
    writeScriptToolEntry(plan.configPath, plan.name, plan.entry);
  } catch (error) {
    try {
      if (previous) writeFileAtomic(scriptPath, previous.bytes, previous.mode);
      else {
        rmSync(scriptPath, { force: true });
        if (createdDir) removeIfEmpty(dirname(scriptPath));
      }
    } catch (restoreError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; the script file ${scriptPath} could not be restored either: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}
