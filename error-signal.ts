import { INPUT_REQUIRED_NEEDS_UI } from "./errors.ts";

// A script tool that could not run, or was refused, is a failed call too. So is a call the gateway
// handed off as a nested Pi call that Pi blocked or rejected before the tool ran, and a script tool
// save that can't be written, found before the dialogs (an unreadable config, a script path that
// isn't a regular file, an existing script over 1 MiB, an mcp-scripts that isn't a directory) or
// when the approved write fails, so the model does not believe the tool exists.
const SCRIPT_TOOL_FAILURES = new Set([
  "codemode_unavailable",
  "nested_call_failed",
  "nested_script_tool",
  "script_file_missing",
  "script_file_unreadable",
  "script_file_empty",
  "script_file_too_large",
  "script_save_failed",
]);

/**
 * Decide the `isError` override for a finished tool result in the `tool_result` hook.
 *
 * A failed MCP tool call is *returned* (not thrown), tagged `details.error: "tool_error"` (the server
 * returned an error result), `"call_failed"` (the call itself threw and was caught), or a typed
 * input-required failure that could not run without UI. pi never reads a result-level `isError`,
 * so without this such a call is recorded as a success. Returning
 * `{ isError: true }` (and nothing else) flips the flag; pi's field-by-field merge keeps the original
 * `content` and `details` intact.
 *
 * Limited to execution-failure codes: the adapter's other `details.error` values (`auth_required`, connection
 * states, search/validation feedback, ...) are not failed tool calls, so they get no override.
 */
export function toolErrorOverride(details: unknown): { isError: true } | undefined {
  if (details && typeof details === "object" && "error" in details) {
    const code = (details as { error?: unknown }).error;
    if (code === "tool_error" || code === "call_failed" || code === INPUT_REQUIRED_NEEDS_UI || (typeof code === "string" && SCRIPT_TOOL_FAILURES.has(code))) {
      return { isError: true };
    }
  }
  return undefined;
}
