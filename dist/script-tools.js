import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Check } from "typebox/value";
import { normalizeDirectToolInputSchema } from "./utils.js";
// The name becomes the tail of `mcp__script__<name>`; 48 characters keep that within 64.
const SCRIPT_TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const SCRIPT_TOOL_KEYS = new Set(["description", "file", "inputSchema", "declare"]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
}
/**
 * Where a script tool's file is: `~` and `~/…` are under the home directory, an absolute path is
 * kept, and a relative path is relative to `sourceDir`, the directory of the config file that set it.
 */
export function resolveScriptToolPath(file, sourceDir) {
    if (file === "~")
        return homedir();
    if (file.startsWith("~/"))
        return join(homedir(), file.slice(2));
    return resolve(sourceDir, file);
}
/**
 * Check one `scriptTools` entry. Returns the definition, with `file` resolved, or why the entry is
 * not loaded. Never reads the script file.
 */
export function validateScriptToolEntry(name, value, sourceDir) {
    if (!SCRIPT_TOOL_NAME.test(name)) {
        return "its name must start with a lowercase letter and have only lowercase letters, digits and underscores, at most 48 characters";
    }
    if (!isRecord(value))
        return "it must be an object";
    const unknown = Object.keys(value).filter((key) => !SCRIPT_TOOL_KEYS.has(key));
    if (unknown.length > 0) {
        return `it has unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown.map((key) => JSON.stringify(key)).join(", ")}`;
    }
    const { description, file, inputSchema, declare } = value;
    if (!isNonEmptyString(description))
        return "description must be a non-empty string";
    if (!isNonEmptyString(file))
        return "file must be a non-empty string";
    if (inputSchema !== undefined) {
        if (!isRecord(inputSchema) || inputSchema.type !== "object") {
            return 'inputSchema must be a JSON Schema object with "type": "object"';
        }
        try {
            // The validator a call's arguments go through, on the schema Pi is given.
            Check(normalizeDirectToolInputSchema(inputSchema), {});
        }
        catch (error) {
            return `inputSchema is not a usable JSON Schema (${error instanceof Error ? error.message : String(error)})`;
        }
    }
    if (declare !== undefined && typeof declare !== "boolean")
        return "declare must be true or false";
    return {
        description,
        file: resolveScriptToolPath(file, sourceDir),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
        ...(declare !== undefined ? { declare } : {}),
    };
}
/**
 * Read a config's `scriptTools` block. A bad entry is dropped and reported; it never drops the
 * config's other entries or its servers. `source` names the config in each issue. Relative `file`
 * paths resolve against `sourceDir`, by default the folder of the config file `source` names.
 */
export function parseScriptTools(value, source, sourceDir = dirname(source)) {
    const scriptTools = {};
    if (!isRecord(value)) {
        return { scriptTools, issues: [`${source}: scriptTools was not loaded — it must be an object that maps tool names to script tools.`] };
    }
    const issues = [];
    for (const [name, entry] of Object.entries(value)) {
        const validated = validateScriptToolEntry(name, entry, sourceDir);
        if (typeof validated === "string")
            issues.push(`${source}: script tool ${JSON.stringify(name)} was not loaded — ${validated}.`);
        else
            scriptTools[name] = validated;
    }
    return { scriptTools, issues };
}
//# sourceMappingURL=script-tools.js.map