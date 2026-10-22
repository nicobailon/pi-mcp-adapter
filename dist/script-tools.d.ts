import type { ScriptToolDefinition } from "./types.ts";
/**
 * Where a script tool's file is: `~` and `~/…` are under the home directory, an absolute path is
 * kept, and a relative path is relative to `sourceDir`, the directory of the config file that set it.
 */
export declare function resolveScriptToolPath(file: string, sourceDir: string): string;
/**
 * Check one `scriptTools` entry. Returns the definition, with `file` resolved, or why the entry is
 * not loaded. Never reads the script file.
 */
export declare function validateScriptToolEntry(name: string, value: unknown, sourceDir: string): ScriptToolDefinition | string;
/**
 * Read a config's `scriptTools` block. A bad entry is dropped and reported; it never drops the
 * config's other entries or its servers. `source` names the config in each issue. Relative `file`
 * paths resolve against `sourceDir`, by default the folder of the config file `source` names.
 */
export declare function parseScriptTools(value: unknown, source: string, sourceDir?: string): {
    scriptTools: Record<string, ScriptToolDefinition>;
    issues: string[];
};
