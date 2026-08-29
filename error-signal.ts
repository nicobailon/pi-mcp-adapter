import { INPUT_REQUIRED_NEEDS_UI } from "./errors.ts";

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
    if (code === "tool_error" || code === "call_failed" || code === INPUT_REQUIRED_NEEDS_UI) {
      return { isError: true };
    }
  }
  if (details && typeof details === "object" && (details as { mode?: unknown }).mode === "script") {
    const calls = (details as { calls?: unknown }).calls;
    if (Array.isArray(calls) && calls.some((call) => (
      !!call && typeof call === "object" && (call as { error?: unknown }).error === INPUT_REQUIRED_NEEDS_UI
    ))) {
      return { isError: true };
    }
  }
  return undefined;
}
