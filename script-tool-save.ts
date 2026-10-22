import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildUnifiedDiff, getPiGlobalConfigPath, getProjectPiConfigPath, previewScriptToolEntryTexts, readScriptToolEntry, writeScriptToolEntry } from "./config.ts";
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
  /** For `script_save_failed`: what failed, which the save action reports as `details.message`. */
  reason?: string;
}

export interface ScriptToolSavePlan {
  ok: true;
  name: string;
  configPath: string;
  scriptPath: string;
  target: ScriptToolSaveTargetKind;
  /** The entry as written, with `file` relative. */
  entry: ScriptToolDefinition;
  code: string;
  /** Set when the loaded config already has the name or the script file exists. */
  overwrite?: { entry?: ScriptToolDefinition; scriptExisted: boolean };
  /** What the operator is shown as replaced, checked again just before the write. */
  baseline: ScriptToolSaveBaseline;
  /** Where the script is written, when a linked `mcp-scripts` directory sends it elsewhere. */
  scriptRealPath?: string;
}

interface ScriptToolSaveBaseline {
  /** The SHA-256 of the script file, when there is one. */
  scriptHash?: string;
  /** The script file as UTF-8, read with the hash, so the summary needs no second read. */
  scriptText?: string;
  /** The target config file's entry for the name, as JSON, when it has one. */
  configEntry?: string;
  /** The real path of `mcp-scripts`, when it exists; absent, the write will create it. */
  scriptDir?: string;
}

const OPTIONS_PREFIX = "// @options:";
const SAVE_ARGS = new Set(["name", "description", "code", "inputSchema"]);
const MAX_DIFF_LINES = 60;
// Each diff in the summary is cut here too, so a minified script can't make a huge dialog; the two
// diffs stay within 16 KB.
const MAX_DIFF_BYTES = 8 * 1024;
// The diff's LCS table has a cell per pair of lines; past this it would take too long or run out of memory.
const MAX_DIFF_CELLS = 4_000_000;
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

/** A save that cannot be written, in the shape the save action reports for every such failure. */
function saveFailed(name: string, reason: string): ScriptToolSaveRefusal {
  return { ok: false, error: "script_save_failed", name, message: `Cannot save script tool "${name}": ${reason}`, reason };
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

  // A linked mcp-scripts directory is fine, but the summary says where the bytes go.
  const scriptDir = dirname(target.scriptPath);
  let scriptRealPath: string | undefined;
  let existing: ReturnType<typeof lstatSync>;
  try {
    if (lstatSync(scriptDir, { throwIfNoEntry: false })) {
      if (!statSync(scriptDir, { throwIfNoEntry: false })?.isDirectory()) return saveFailed(name, `${scriptDir} is not a directory`);
      const realDir = realpathSync(scriptDir);
      if (realDir !== scriptDir) scriptRealPath = join(realDir, basename(target.scriptPath));
    }
    existing = lstatSync(target.scriptPath, { throwIfNoEntry: false });
  } catch (error) {
    return saveFailed(name, `${target.scriptPath} cannot be checked (${errorMessage(error)})`);
  }
  // Renaming over a symlink would replace the link, so only a regular file is replaced.
  if (existing && !existing.isFile()) return saveFailed(name, `${target.scriptPath} is not a regular file`);
  // A script tool doesn't run a file this large either, and reading it to diff could take too long.
  if (existing && existing.size > MAX_SCRIPT_BYTES) return saveFailed(name, `${target.scriptPath} is larger than 1 MiB`);
  let baseline: ScriptToolSaveBaseline;
  try {
    baseline = readBaseline(target.configPath, target.scriptPath, name);
  } catch (error) {
    return saveFailed(name, errorMessage(error));
  }
  const existingEntry = request.scriptTools?.[name];
  const scriptExisted = existing !== undefined;
  return {
    ok: true, name, target: request.target, configPath: target.configPath, scriptPath: target.scriptPath, entry, code, baseline,
    ...(scriptRealPath ? { scriptRealPath } : {}),
    ...(existingEntry || scriptExisted ? { overwrite: { ...(existingEntry ? { entry: existingEntry } : {}), scriptExisted } } : {}),
  };
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// Throws when the config, the script or the folder mcp-scripts leads to cannot be read.
function readBaseline(configPath: string, scriptPath: string, name: string): ScriptToolSaveBaseline {
  const current = readScriptToolEntry(configPath, name);
  const configEntry = current === undefined ? undefined : JSON.stringify(current);
  const script = lstatSync(scriptPath, { throwIfNoEntry: false }) ? readFileSync(scriptPath) : undefined;
  const dir = dirname(scriptPath);
  const scriptDir = lstatSync(dir, { throwIfNoEntry: false }) ? realpathSync(dir) : undefined;
  return {
    ...(script ? { scriptHash: createHash("sha256").update(script).digest("hex"), scriptText: script.toString("utf8") } : {}),
    ...(configEntry !== undefined ? { configEntry } : {}),
    ...(scriptDir !== undefined ? { scriptDir } : {}),
  };
}

/**
 * Why the save must not be written now, or undefined: the script file, the target file's entry or
 * the folder `mcp-scripts` leads to changed after the operator was shown them. Throws when one
 * cannot be read.
 */
export function scriptToolSaveChange(plan: ScriptToolSavePlan): string | undefined {
  const now = readBaseline(plan.configPath, plan.scriptPath, plan.name);
  if (now.scriptHash !== plan.baseline.scriptHash || now.configEntry !== plan.baseline.configEntry) {
    return "the script file or its config entry changed after you approved the save, so nothing was written";
  }
  // A relinked or newly created mcp-scripts link would send the bytes somewhere the operator wasn't shown.
  if (now.scriptDir !== plan.baseline.scriptDir) {
    return `${dirname(plan.scriptPath)} leads to a different folder than when you approved the save, so nothing was written`;
  }
  return undefined;
}

/** The summary the operator approves before reviewing the script: both files, the config diff and any script diff. */
export function buildScriptToolSavePrompt(plan: ScriptToolSavePlan): string {
  const preview = previewScriptToolEntryTexts(plan.configPath, plan.name, plan.entry);
  const scriptExisted = plan.overwrite?.scriptExisted === true;
  const lineCount = countLines(plan.code);
  const configState = !preview.existed ? "new file" : plan.baseline.configEntry !== undefined ? "entry replaced" : "new entry";
  const lines = [
    `Save script tool "${plan.name}" as ${SCRIPT_TOOL_NAMESPACE}__${plan.name}?`,
    "",
    `Script: ${plan.scriptPath} (${scriptExisted ? "replaced" : "new"}, ${lineCount} ${lineCount === 1 ? "line" : "lines"}${plan.scriptRealPath ? `; writes to ${plan.scriptRealPath}` : ""})`,
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
  lines.push("", "Config change:", ...boundedDiff(preview.beforeText, preview.afterText, `Only the "${plan.name}" entry in scriptTools changes.`));
  if (plan.baseline.scriptText !== undefined) {
    lines.push("", "Script change:", ...boundedDiff(plan.baseline.scriptText, plan.code, "Review the new script in the editor."));
  }
  return lines.join("\n");
}

/** A context diff cut to MAX_DIFF_LINES lines and MAX_DIFF_BYTES, or one line when it is too large to compute. */
function boundedDiff(before: string, after: string, tooLargeHint: string): string[] {
  const rows = countLines(before);
  const cols = countLines(after);
  if ((rows + 1) * (cols + 1) > MAX_DIFF_CELLS) {
    return [`${rows} lines replaced by ${cols} lines; too large to show here. ${tooLargeHint}`];
  }
  const diff = buildUnifiedDiff(before, after, { context: DIFF_CONTEXT }).split("\n");
  const shown: string[] = [];
  let bytes = 0;
  for (const line of diff) {
    if (shown.length === MAX_DIFF_LINES || bytes >= MAX_DIFF_BYTES) break;
    const room = MAX_DIFF_BYTES - bytes;
    // A multi-byte character cut in half decodes to U+FFFD, which is dropped.
    const cut = Buffer.byteLength(line) > room ? `${Buffer.from(line).subarray(0, room).toString().replace(/�$/, "")}…` : line;
    shown.push(cut);
    bytes += Buffer.byteLength(cut) + 1;
  }
  const hidden = diff.length - shown.length;
  if (hidden > 0) shown.push(`… (${hidden} more ${hidden === 1 ? "line" : "lines"})`);
  return shown;
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
    const scriptDir = dirname(scriptPath);
    if (lstatSync(scriptDir, { throwIfNoEntry: false }) && !statSync(scriptDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${scriptDir} is not a directory`);
    }
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
