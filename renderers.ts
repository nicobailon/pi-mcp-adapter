/**
 * TUI renderers for MCP tools — gives them the same collapsible
 * header + result UI that built-in Pi tools have.
 *
 * Collapsed: first N lines preview + "... (N more lines, tab to expand)"
 * Expanded: full output
 */
import type { AgentToolResult, ToolRenderContext, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { keyHint, Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Text } from "@mariozechner/pi-tui";

const PREVIEW_LINES = 5;

export function createMcpRenderers(displayName: string) {
  return {
    renderCall(args: Record<string, unknown>, theme: Theme, context: ToolRenderContext): Component {
      const text: Text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);

      let content = theme.fg("toolTitle", theme.bold(displayName));
      const summary = compactArgs(args);
      if (summary) content += " " + theme.fg("muted", summary);
      text.setText(content);
      return text;
    },

    renderResult(
      result: AgentToolResult,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: ToolRenderContext,
    ): Component {
      const text: Text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);

      if (options.isPartial) {
        text.setText(theme.fg("dim", "running…"));
        return text;
      }

      const output = resultText(result);
      if (!output) {
        text.setText("");
        return text;
      }

      const lines = output.split("\n");
      const maxLines = options.expanded ? lines.length : PREVIEW_LINES;
      const displayLines = lines.slice(0, maxLines);
      const remaining = lines.length - maxLines;
      const color = context.isError ? "error" : "toolOutput";

      let content = "\n" + displayLines
        .map((line: string) => theme.fg(color, line))
        .join("\n");

      if (remaining > 0) {
        content += "\n" + theme.fg("muted", `... (${remaining} more lines,`)
          + " " + keyHint("app.tools.expand", "to expand") + ")";
      }

      text.setText(content);
      return text;
    },
  };
}

function compactArgs(args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === "string" && val.length > 0) {
      return `${key}=${trunc(val, 70)}`;
    }
    if (Array.isArray(val) && val.length > 0) {
      if (val.length === 1) return `${key}=${trunc(String(val[0]), 70)}`;
      return `${key}: ${val.length} items`;
    }
  }
  return "";
}

function resultText(result: AgentToolResult): string {
  if (!result?.content) return "";
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => ("text" in c ? c.text : "") ?? "")
    .join("\n");
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
