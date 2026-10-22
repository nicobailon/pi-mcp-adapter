import { describe, it, expect } from "vitest";
import { toolErrorOverride } from "../error-signal.ts";

describe("toolErrorOverride", () => {
  it("flags tool-execution failures", () => {
    expect(toolErrorOverride({ error: "tool_error", server: "x" })).toEqual({ isError: true });
    expect(toolErrorOverride({ mode: "call", error: "call_failed", message: "boom" })).toEqual({ isError: true });
    expect(toolErrorOverride({ mode: "call", error: "input_required_needs_ui", server: "demo" })).toEqual({ isError: true });
  });

  it("flags a script tool that could not run or was refused", () => {
    for (const code of ["codemode_unavailable", "nested_call_failed", "nested_script_tool", "script_file_missing", "script_file_unreadable", "script_file_empty", "script_file_too_large"]) {
      expect(toolErrorOverride({ mode: "script_tool", tool: "close_stale", error: code }), code).toEqual({ isError: true });
    }
    // The MCP hand-off reports a blocked nested call the same way.
    expect(toolErrorOverride({ mode: "call", error: "nested_call_failed", server: "fixture" })).toEqual({ isError: true });
    // An approved script tool save that wrote nothing.
    expect(toolErrorOverride({ mode: "save-script", name: "close_stale", error: "script_save_failed", message: "boom" })).toEqual({ isError: true });
    expect(toolErrorOverride({ mode: "script_tool", tool: "close_stale", calls: [] })).toBeUndefined();
  });

  it("leaves the adapter's other details.error codes as successes (auth, connection, validation, routing)", () => {
    for (const code of ["auth_required", "not_connected", "empty_query", "tool_not_found", "missing_input", "invalid_entry", "code_empty", "code_too_large", "code_invalid", "name_shadowed", "declined", "headless", "name_unavailable", "unsupported_pi"]) {
      expect(toolErrorOverride({ error: code }), code).toBeUndefined();
    }
    expect(toolErrorOverride({ ok: true })).toBeUndefined(); // no error breadcrumb at all
  });

  it("returns only { isError: true } so pi's field-by-field merge keeps content and details", () => {
    expect(Object.keys(toolErrorOverride({ error: "tool_error" }) ?? {})).toEqual(["isError"]);
  });

  it("ignores malformed details (nullish, non-object, non-string error)", () => {
    expect(toolErrorOverride(undefined)).toBeUndefined();
    expect(toolErrorOverride("tool_error")).toBeUndefined();
    expect(toolErrorOverride({ error: 123 })).toBeUndefined();
  });
});
