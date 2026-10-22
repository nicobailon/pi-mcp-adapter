import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScriptTools, resolveScriptToolPath, validateScriptToolEntry } from "../script-tools.ts";

describe("resolveScriptToolPath", () => {
  it("expands ~, keeps an absolute path, and resolves a relative one against the config's directory", () => {
    expect(resolveScriptToolPath("~", "/config")).toBe(homedir());
    expect(resolveScriptToolPath("~/scripts/a.js", "/config")).toBe(join(homedir(), "scripts", "a.js"));
    expect(resolveScriptToolPath("/abs/a.js", "/config")).toBe("/abs/a.js");
    expect(resolveScriptToolPath("./a.js", "/config/dir")).toBe("/config/dir/a.js");
    expect(resolveScriptToolPath("../a.js", "/config/dir")).toBe("/config/a.js");
    expect(resolveScriptToolPath("~other/a.js", "/config")).toBe("/config/~other/a.js");
  });
});

describe("validateScriptToolEntry", () => {
  const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { repo: { type: "string" } }, additionalProperties: false };

  it("returns the definition with file resolved and the schema as written", () => {
    expect(validateScriptToolEntry("close_stale", { description: "Close", file: "./c.js", inputSchema: schema, declare: true }, "/cfg")).toEqual({
      description: "Close", file: "/cfg/c.js", inputSchema: schema, declare: true,
    });
    expect(validateScriptToolEntry("a", { description: "A", file: "a.js" }, "/cfg")).toEqual({ description: "A", file: "/cfg/a.js" });
  });

  it.each([
    ["a"],
    ["close_stale_2"],
    [`a${"b".repeat(47)}`],
  ])("accepts the name %s", (name) => {
    expect(typeof validateScriptToolEntry(name, { description: "D", file: "f.js" }, "/cfg")).toBe("object");
  });

  it.each([
    [""],
    ["Close"],
    ["2close"],
    ["_close"],
    ["close-stale"],
    ["close.stale"],
    ["__proto__"],
    [`a${"b".repeat(48)}`],
  ])("rejects the name %j", (name) => {
    expect(validateScriptToolEntry(name, { description: "D", file: "f.js" }, "/cfg")).toMatch(/^its name must start with a lowercase letter/);
  });

  it.each([
    ["a string entry", "f.js", "it must be an object"],
    ["an array entry", [], "it must be an object"],
    ["two unknown keys", { description: "D", file: "f.js", command: "x", args: [] }, 'it has unknown keys "command", "args"'],
    ["a non-string description", { description: 1, file: "f.js" }, "description must be a non-empty string"],
    ["a blank file", { description: "D", file: " \n" }, "file must be a non-empty string"],
    ["a schema without a type", { description: "D", file: "f.js", inputSchema: { properties: {} } }, 'inputSchema must be a JSON Schema object with "type": "object"'],
    ["a null schema", { description: "D", file: "f.js", inputSchema: null }, 'inputSchema must be a JSON Schema object with "type": "object"'],
    ["a numeric declare", { description: "D", file: "f.js", declare: 1 }, "declare must be true or false"],
  ])("rejects %s", (_case, value, reason) => {
    expect(validateScriptToolEntry("tool", value, "/cfg")).toBe(reason);
  });
});

describe("parseScriptTools", () => {
  it("keeps the good entries and reports each bad one against the config path", () => {
    const parsed = parseScriptTools({
      good: { description: "Good", file: "./good.js" },
      Bad: { description: "Bad", file: "./bad.js" },
      worse: { file: "./worse.js" },
    }, "/cfg/mcp-adapter.json");

    expect(parsed.scriptTools).toEqual({ good: { description: "Good", file: "/cfg/good.js" } });
    expect(parsed.issues).toEqual([
      '/cfg/mcp-adapter.json: script tool "Bad" was not loaded — its name must start with a lowercase letter and have only lowercase letters, digits and underscores, at most 48 characters.',
      '/cfg/mcp-adapter.json: script tool "worse" was not loaded — description must be a non-empty string.',
    ]);
  });

  it("names a config with no file by its label, and resolves its relative paths against the given folder", () => {
    expect(parseScriptTools({ good: { description: "Good", file: "good.js" }, "Close Stale!": { description: "Bad", file: "bad.js" } }, "The supplied config", "/work")).toEqual({
      scriptTools: { good: { description: "Good", file: "/work/good.js" } },
      issues: ['The supplied config: script tool "Close Stale!" was not loaded — its name must start with a lowercase letter and have only lowercase letters, digits and underscores, at most 48 characters.'],
    });
  });

  it("reports a block that is not an object", () => {
    expect(parseScriptTools("close_stale", "/cfg/a.json")).toEqual({
      scriptTools: {},
      issues: ["/cfg/a.json: scriptTools was not loaded — it must be an object that maps tool names to script tools."],
    });
  });
});
