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
 * Read a config file's `scriptTools` block. A bad entry is dropped and reported; it never drops the
 * file's other entries or its servers.
 */
export declare function parseScriptTools(value: unknown, configPath: string): {
    scriptTools: Record<string, ScriptToolDefinition>;
    issues: string[];
};
