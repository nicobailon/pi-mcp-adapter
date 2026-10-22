import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUnifiedDiff, previewScriptToolEntryTexts } from "../config.ts";
import {
  buildScriptToolSavePrompt,
  checkScriptToolCode,
  checkScriptToolSave,
  resolveScriptToolSaveTarget,
  writeScriptToolSave,
  type ScriptToolSavePlan,
  type ScriptToolSaveRequest,
} from "../script-tool-save.ts";
import { MAX_SCRIPT_BYTES } from "../script-tool-surface.ts";
import { resolveScriptToolPath, validateScriptToolEntry } from "../script-tools.ts";

const CODE = "const issues = await mcp.github.list_issues({ state: input.state });\nreturn issues.length;\n";
const SCHEMA = { type: "object", properties: { state: { type: "string" } } };

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-mcp-script-save-")));
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  vi.stubEnv("PI_PACKAGE_DIR", "");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function request(args: unknown, overrides: Partial<ScriptToolSaveRequest> = {}): ScriptToolSaveRequest {
  return { args, target: "global", cwd, scriptTools: undefined, projectScriptTools: undefined, ...overrides };
}

function plan(overrides: Partial<ScriptToolSaveRequest> = {}, args: Record<string, unknown> = {}): ScriptToolSavePlan {
  const result = checkScriptToolSave(request({ name: "stale_issues", description: "List stale issues", code: CODE, ...args }, overrides));
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe("resolveScriptToolSaveTarget", () => {
  it("puts the script in mcp-scripts/ beside the target config, where the loader resolves the entry's file", () => {
    const override = join(root, "custom", "cfg.json");
    const cases = [
      [resolveScriptToolSaveTarget("global", "stale_issues", { cwd }), join(agentDir, "mcp-adapter.json")],
      [resolveScriptToolSaveTarget("global", "stale_issues", { cwd, configOverridePath: override }), override],
      [resolveScriptToolSaveTarget("project", "stale_issues", { cwd, configOverridePath: override }), join(cwd, ".pi", "mcp-adapter.json")],
    ] as const;
    for (const [target, configPath] of cases) {
      expect(target).toEqual({
        configPath,
        scriptPath: join(dirname(configPath), "mcp-scripts", "stale_issues.js"),
        file: "mcp-scripts/stale_issues.js",
      });
      expect(resolveScriptToolPath(target.file, dirname(target.configPath))).toBe(target.scriptPath);
    }
  });
});

describe("checkScriptToolCode", () => {
  it.each([
    ["empty", "", "code_empty", "the code is empty"],
    ["blank", " \n\t\n", "code_empty", "the code is empty"],
    ["over 1 MiB", "x".repeat(MAX_SCRIPT_BYTES + 1), "code_too_large", "the code is larger than 1 MiB"],
    ["over 1 MiB in UTF-8 bytes", "é".repeat(MAX_SCRIPT_BYTES / 2 + 1), "code_too_large", "the code is larger than 1 MiB"],
    ["with a NUL byte", "return 1;\0", "code_invalid", "the code contains a NUL byte"],
    ["only an options line", "\n  // @options: {\"timeout_ms\": 1000}\n\n", "code_invalid", "the code is only a // @options: line, with no script after it"],
  ])("refuses code that is %s", (_kind, code, error, reason) => {
    expect(checkScriptToolCode("a", code)).toEqual({ ok: false, error, name: "a", message: `Cannot save script tool "a": ${reason}.` });
  });

  it("accepts code it cannot parse, because it never compiles it", () => {
    expect(checkScriptToolCode("a", "x".repeat(MAX_SCRIPT_BYTES))).toBeUndefined();
    expect(checkScriptToolCode("a", "// @options: {}\nreturn 1;")).toBeUndefined();
    expect(checkScriptToolCode("a", "return )( not javascript")).toBeUndefined();
  });
});

describe("checkScriptToolSave", () => {
  const MISSING = 'save-script requires args with name, description and code. Example: mcp({ action: "save-script", args: { name: "stale_issues", description: "...", code: "..." } })';

  it.each([
    ["no args", undefined, undefined],
    ["a non-object", "stale_issues", undefined],
    ["a non-string name", { name: 1, description: "D", code: CODE }, undefined],
    ["no description", { name: "a", code: CODE }, "a"],
    ["a non-string code", { name: "a", description: "D", code: ["x"] }, "a"],
  ])("refuses %s as missing input", (_kind, args, name) => {
    expect(checkScriptToolSave(request(args))).toEqual({ ok: false, error: "missing_input", message: MISSING, ...(name ? { name } : {}) });
  });

  it("passes validateScriptToolEntry's reason through, and checks the code, before touching any path", () => {
    expect(checkScriptToolSave(request({ name: "../escape", description: "D", code: CODE }))).toEqual({
      ok: false, error: "invalid_entry", name: "../escape",
      message: 'Cannot save script tool "../escape": its name must start with a lowercase letter and have only lowercase letters, digits and underscores, at most 48 characters.',
    });
    expect(checkScriptToolSave(request({ name: "a", description: " ", code: CODE }))).toMatchObject({
      error: "invalid_entry", message: 'Cannot save script tool "a": description must be a non-empty string.',
    });
    expect(checkScriptToolSave(request({ name: "a", description: "D", code: CODE, inputSchema: { type: "string" } }))).toMatchObject({
      error: "invalid_entry", message: 'Cannot save script tool "a": inputSchema must be a JSON Schema object with "type": "object".',
    });
    expect(checkScriptToolSave(request({ name: "a", description: "D", code: "  " }))).toMatchObject({ error: "code_empty" });
    expect(existsSync(agentDir)).toBe(false);
  });

  it("returns the entry it would write, with a relative file", () => {
    expect(plan({}, { inputSchema: SCHEMA })).toEqual({
      ok: true, name: "stale_issues", target: "global",
      configPath: join(agentDir, "mcp-adapter.json"),
      scriptPath: join(agentDir, "mcp-scripts", "stale_issues.js"),
      entry: { description: "List stale issues", file: "mcp-scripts/stale_issues.js", inputSchema: SCHEMA },
      code: CODE,
      baseline: {},
    });
  });

  it("refuses any other key, declare and target included", () => {
    expect(checkScriptToolSave(request({ name: "a", description: "D", code: CODE, declare: true }))).toEqual({
      ok: false, error: "invalid_entry", name: "a", message: 'Cannot save script tool "a": unknown field "declare".',
    });
    // The action reads `target` itself and passes the rest here.
    expect(checkScriptToolSave(request({ name: "a", description: "D", code: CODE, target: "global" }))).toMatchObject({ error: "invalid_entry" });
  });

  it("reports an overwrite when the loaded config has the name or the script file exists", () => {
    const loaded = { description: "Old", file: join(root, "elsewhere.js") };
    expect(plan({ scriptTools: { stale_issues: loaded } }).overwrite).toEqual({ entry: loaded, scriptExisted: false });
    mkdirSync(join(agentDir, "mcp-scripts"), { recursive: true });
    writeFileSync(join(agentDir, "mcp-scripts", "stale_issues.js"), "return 0;\n");
    expect(plan().overwrite).toEqual({ scriptExisted: true });
    expect(plan({ scriptTools: { other: loaded } }).overwrite).toEqual({ scriptExisted: true });
  });

  it("refuses a global save of a name a project config defines, and allows a project save of it", () => {
    const projectScriptTools = new Map([["stale_issues", { path: join(cwd, ".mcp.json") }]]);
    const args = { name: "stale_issues", description: "D", code: CODE };
    expect(checkScriptToolSave(request(args, { projectScriptTools }))).toEqual({
      ok: false, error: "name_shadowed", name: "stale_issues", shadowedBy: join(cwd, ".mcp.json"),
      message: `Cannot save script tool "stale_issues" globally: ${join(cwd, ".mcp.json")} already defines it and takes precedence. Save it with target: "project", or remove the project entry.`,
    });
    expect(checkScriptToolSave(request(args, { projectScriptTools, target: "project" }))).toMatchObject({ ok: true, configPath: join(cwd, ".pi", "mcp-adapter.json") });
  });

  it.each([
    ["mcp-scripts is a file", (_configPath: string, scriptPath: string) => writeFileSync(dirname(scriptPath), ""), (scriptPath: string) => `${dirname(scriptPath)} is not a directory`],
    ["the script path is a directory", (_configPath: string, scriptPath: string) => mkdirSync(scriptPath, { recursive: true }), (scriptPath: string) => `${scriptPath} is not a regular file`],
    ["the script path is a symlink", (configPath: string, scriptPath: string) => { mkdirSync(dirname(scriptPath)); symlinkSync(configPath, scriptPath); }, (scriptPath: string) => `${scriptPath} is not a regular file`],
    ["the config is malformed", (configPath: string) => writeFileSync(configPath, "{ malformed"), (_scriptPath: string, configPath: string) => `Failed to read MCP config at ${configPath}: `],
    ["the config's scriptTools is not an object", (configPath: string) => writeFileSync(configPath, '{"scriptTools": []}'), (_scriptPath: string, configPath: string) => `Failed to update MCP config at ${configPath}: scriptTools must be an object`],
    ["the script file is larger than 1 MiB", (_configPath: string, scriptPath: string) => { mkdirSync(dirname(scriptPath)); writeFileSync(scriptPath, "x".repeat(MAX_SCRIPT_BYTES + 1)); }, (scriptPath: string) => `${scriptPath} is larger than 1 MiB`],
  ])("refuses as script_save_failed when %s, writing nothing", (_kind, arrange, reason) => {
    const configPath = join(agentDir, "mcp-adapter.json");
    const scriptPath = join(agentDir, "mcp-scripts", "stale_issues.js");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(configPath, "{}\n");
    arrange(configPath, scriptPath);
    const before = readFileSync(configPath, "utf8");
    const result = checkScriptToolSave(request({ name: "stale_issues", description: "D", code: CODE })) as { ok: false; message: string; reason: string };
    expect(result).toMatchObject({ ok: false, error: "script_save_failed", name: "stale_issues" });
    expect(result.reason.startsWith(reason(scriptPath, configPath))).toBe(true);
    expect(result.message).toBe(`Cannot save script tool "stale_issues": ${result.reason}`);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("never compiles, evaluates or loads the code, and reads no implicit cwd or home directory", () => {
    const source = readFileSync(new URL("../script-tool-save.ts", import.meta.url), "utf8");
    for (const pattern of [/node:vm/, /\bFunction\s*\(/, /AsyncFunction/, /\beval\s*\(/, /\brequire\s*\(/, /\bimport\s*\(/, /process\.cwd/, /homedir/]) {
      expect(source, String(pattern)).not.toMatch(pattern);
    }
  });
});

describe("buildScriptToolSavePrompt", () => {
  it("names the tool, both new paths, the config diff and the line count, without the code", () => {
    const saved = plan();
    const { beforeText, afterText } = previewScriptToolEntryTexts(saved.configPath, saved.name, saved.entry);
    const diffText = buildUnifiedDiff(beforeText, afterText, { context: 3 });
    expect(buildScriptToolSavePrompt(saved)).toBe([
      'Save script tool "stale_issues" as mcp__script__stale_issues?',
      "",
      `Script: ${join(agentDir, "mcp-scripts", "stale_issues.js")} (new, 2 lines)`,
      `Config: ${join(agentDir, "mcp-adapter.json")} (new file)`,
      "",
      "Config change:",
      diffText,
    ].join("\n"));
    // A missing file has no lines, so nothing is removed.
    expect(diffText).toMatch(/^--- before\n\+\+\+ after\n@@ -0,0 \+1,\d+ @@\n/);
    expect(diffText.split("\n").filter((line) => line.startsWith("- "))).toEqual([]);
    expect(diffText).toContain('+       "file": "mcp-scripts/stale_issues.js"');
  });

  it("marks replaced files, says a rewritten config loses its comments, and bounds the script diff", () => {
    const configPath = join(agentDir, "mcp-adapter.json");
    mkdirSync(join(agentDir, "mcp-scripts"), { recursive: true });
    writeFileSync(configPath, '{\n  // keep me\n  "scriptTools": { "stale_issues": { "description": "Old", "file": "mcp-scripts/stale_issues.js" } }\n}\n');
    const oldScript = Array.from({ length: 100 }, (_, i) => `// old ${i}`).join("\n");
    writeFileSync(join(agentDir, "mcp-scripts", "stale_issues.js"), oldScript);

    const prompt = buildScriptToolSavePrompt(plan()).split("\n");
    expect(prompt.slice(2, 5)).toEqual([
      `Script: ${join(agentDir, "mcp-scripts", "stale_issues.js")} (replaced, 2 lines)`,
      `Config: ${configPath} (entry replaced)`,
      "Comments and formatting in this file will be rewritten.",
    ]);
    const scriptDiff = prompt.slice(prompt.indexOf("Script change:") + 1);
    expect(scriptDiff).toHaveLength(61);
    expect(scriptDiff.slice(0, 4)).toEqual(["--- before", "+++ after", "@@ -1,100 +1,2 @@", "- // old 0"]);
    // 3 headers + 100 removed + 2 added lines.
    expect(scriptDiff[60]).toBe("… (45 more lines)");
  });

  it("shows only the changed lines and 3 lines around them, so a change deep in a long file is shown", () => {
    const configPath = join(agentDir, "mcp-adapter.json");
    const scriptPath = join(agentDir, "mcp-scripts", "stale_issues.js");
    mkdirSync(dirname(scriptPath), { recursive: true });
    const servers = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`server${i}`, { command: `cmd${i}` }]));
    writeFileSync(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
    const lines = Array.from({ length: 200 }, (_, i) => `return ${i};`);
    writeFileSync(scriptPath, lines.join("\n"));
    lines[150] = "return 'changed';";

    const prompt = buildScriptToolSavePrompt(plan({}, { code: lines.join("\n") })).split("\n");
    const configDiff = prompt.slice(prompt.indexOf("Config change:") + 1, prompt.indexOf("Script change:") - 1);
    expect(configDiff.length).toBeLessThan(20);
    expect(configDiff).toContain('+   "scriptTools": {');
    expect(configDiff).toContain('+       "file": "mcp-scripts/stale_issues.js"');
    expect(prompt.slice(prompt.indexOf("Script change:") + 1)).toEqual([
      "--- before", "+++ after", "@@ -148,7 +148,7 @@",
      "  return 147;", "  return 148;", "  return 149;", "- return 150;", "+ return 'changed';", "  return 151;", "  return 152;", "  return 153;",
    ]);
  });

  it("says a diff is too large to show instead of computing it, so 30,000 lines each side can't exhaust memory", () => {
    const scriptPath = join(agentDir, "mcp-scripts", "stale_issues.js");
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, Array.from({ length: 30_000 }, (_, i) => `// old ${i}`).join("\n"));
    const code = Array.from({ length: 30_000 }, (_, i) => `return ${i};`).join("\n");

    const started = Date.now();
    const prompt = buildScriptToolSavePrompt(plan({}, { code }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(prompt.endsWith("Script change:\n30000 lines replaced by 30000 lines; too large to show here. Review the new script in the editor.")).toBe(true);
  });

  it("cuts a diff of one-line 1 MiB scripts to a few kilobytes", () => {
    const scriptPath = join(agentDir, "mcp-scripts", "stale_issues.js");
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, "a".repeat(MAX_SCRIPT_BYTES - 100));

    const prompt = buildScriptToolSavePrompt(plan({}, { code: "b".repeat(MAX_SCRIPT_BYTES - 100) }));
    expect(Buffer.byteLength(prompt)).toBeLessThan(20 * 1024);
    expect(prompt).toMatch(/Script change:\n--- before\n\+\+\+ after\n@@ -1,1 \+1,1 @@\n- a+…\n… \(1 more line\)$/);
  });

  it("shows a bounded diff when a 150,000-line script is replaced by one line", () => {
    const scriptPath = join(agentDir, "mcp-scripts", "stale_issues.js");
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, "a\n".repeat(150_000));

    const prompt = buildScriptToolSavePrompt(plan({}, { code: "return 1;" })).split("\n");
    const scriptDiff = prompt.slice(prompt.indexOf("Script change:") + 1);
    expect(scriptDiff.slice(0, 4)).toEqual(["--- before", "+++ after", "@@ -1,150000 +1,1 @@", "- a"]);
    expect(scriptDiff).toHaveLength(61);
    expect(scriptDiff[60]).toBe("… (149944 more lines)");
  });

  it("leaves out the rewrite sentence for a file the writer would reproduce, and warns a project save about later script edits", () => {
    const configPath = join(cwd, ".pi", "mcp-adapter.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    const prompt = buildScriptToolSavePrompt(plan({ target: "project" }));
    expect(prompt).toContain(`Config: ${configPath} (new entry)\n\nApproving a project script tool covers its entry, not the script. The script file can change without asking you again.\n`);
    expect(prompt).not.toContain("Comments and formatting");
    expect(prompt).not.toContain("Script change:");
  });

  it("leaves out the rewrite sentence for a blank config file", () => {
    const configPath = join(agentDir, "mcp-adapter.json");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(configPath, "  \n");
    const prompt = buildScriptToolSavePrompt(plan());
    expect(prompt).toContain(`Config: ${configPath} (new entry)\n`);
    expect(prompt).not.toContain("Comments and formatting");
  });

  it("names the script an entry from another config file runs, which the save replaces", () => {
    const loaded = { description: "Old global", file: join(agentDir, "mcp-scripts", "stale_issues.js") };
    const configPath = join(cwd, ".pi", "mcp-adapter.json");
    const prompt = buildScriptToolSavePrompt(plan({ target: "project", scriptTools: { stale_issues: loaded } }));
    expect(prompt).toContain(`Config: ${configPath} (new file)\nThis name already runs ${loaded.file}, from another config file; the new entry takes precedence.\n`);
  });
});

describe("writeScriptToolSave", () => {
  const files = (dir: string) => readdirSync(dir).sort();

  it("writes the script and then the entry the loader resolves to it", () => {
    const configPath = join(agentDir, "mcp-adapter.json");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(configPath, '{"settings":{"toolPrefix":"short"}}\n');
    const saved = plan({}, { inputSchema: SCHEMA });
    writeScriptToolSave(saved);

    expect(readFileSync(saved.scriptPath, "utf8")).toBe(CODE);
    expect(files(join(agentDir, "mcp-scripts"))).toEqual(["stale_issues.js"]);
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw).toEqual({ settings: { toolPrefix: "short" }, scriptTools: { stale_issues: saved.entry } });
    expect(validateScriptToolEntry("stale_issues", raw.scriptTools.stale_issues, dirname(configPath))).toEqual({ ...saved.entry, file: saved.scriptPath });
  });

  // These break a file after the check, which refuses a broken one before any dialog.
  it("removes a script and the empty mcp-scripts directory it created when the config write fails", () => {
    const configPath = join(agentDir, "mcp-adapter.json");
    const saved = plan();
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(configPath, "{ malformed");
    expect(() => writeScriptToolSave(saved)).toThrow(`Failed to read MCP config at ${configPath}`);
    expect(existsSync(join(agentDir, "mcp-scripts"))).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe("{ malformed");

    // A directory that was already there stays.
    mkdirSync(join(agentDir, "mcp-scripts"));
    expect(() => writeScriptToolSave(saved)).toThrow(`Failed to read MCP config at ${configPath}`);
    expect(files(join(agentDir, "mcp-scripts"))).toEqual([]);
  });

  it("leaves a script it replaced byte-identical when the config write fails", () => {
    const configPath = join(agentDir, "mcp-adapter.json");
    const scriptPath = join(agentDir, "mcp-scripts", "stale_issues.js");
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, "return 'old';\r\n");
    chmodSync(scriptPath, 0o640);
    const saved = plan();
    writeFileSync(configPath, '{"scriptTools": []}');
    expect(() => writeScriptToolSave(saved)).toThrow(`Failed to update MCP config at ${configPath}: scriptTools must be an object`);
    expect(readFileSync(scriptPath, "utf8")).toBe("return 'old';\r\n");
    expect(statSync(scriptPath).mode & 0o777).toBe(0o640);
    expect(files(dirname(scriptPath))).toEqual(["stale_issues.js"]);
  });

  it("refuses to replace something that is not a regular file, writing nothing", () => {
    const scriptPath = join(agentDir, "mcp-scripts", "stale_issues.js");
    const saved = plan();
    mkdirSync(scriptPath, { recursive: true });
    expect(() => writeScriptToolSave(saved)).toThrow(`Failed to write script tool file at ${scriptPath}: it is not a regular file`);
    expect(existsSync(join(agentDir, "mcp-adapter.json"))).toBe(false);
  });

  it("writes through a linked mcp-scripts directory, which the summary names, and refuses one that isn't a directory", () => {
    const elsewhere = join(root, "dotfiles", "scripts");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    symlinkSync(elsewhere, join(agentDir, "mcp-scripts"));
    const saved = plan();
    expect(buildScriptToolSavePrompt(saved)).toContain(`Script: ${saved.scriptPath} (new, 2 lines; writes to ${join(elsewhere, "stale_issues.js")})`);
    writeScriptToolSave(saved);
    expect(readFileSync(join(elsewhere, "stale_issues.js"), "utf8")).toBe(CODE);

    // Replaced by a file after the check: the writer refuses too.
    rmSync(join(agentDir, "mcp-scripts"), { recursive: true });
    const next = plan({}, { name: "other" });
    writeFileSync(join(agentDir, "mcp-scripts"), "");
    expect(() => writeScriptToolSave(next)).toThrow(`Failed to write script tool file at ${next.scriptPath}: ${join(agentDir, "mcp-scripts")} is not a directory`);
  });
});
