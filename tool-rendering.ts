import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ToolRenderContext, ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { formatImagePlaceholder } from "./mcp-content-formatting.js";

type RenderTheme = {
  fg(color: string, text: string): string;
};

type RenderComponent = {
  render(width: number): string[];
  invalidate(): void;
};

const COLLAPSED_RESULT_PREVIEW_LINES = 10;
const DEFAULT_EXPAND_KEY = "ctrl+o";
const KEYBINDINGS_PATH = join(homedir(), ".pi", "agent", "keybindings.json");
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const TERMINAL_SEQUENCE_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;

/**
 * Cache keybinding text after the first read so terminal rendering does not block on filesystem access.
 */
const configuredKeyTextCache = new Map<string, string>();

/**
 * Render MCP tool results with the same collapsed shape as standard Pi text tools.
 */
export function renderMcpResult(
  result: AgentToolResult<Record<string, unknown>>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  _context: ToolRenderContext,
): RenderComponent {
  if (options.isPartial) {
    return new StaticText(theme.fg("warning", "MCP tool is running..."));
  }

  const output = getTextOutput(result);
  if (!output) {
    return new StaticText(theme.fg("muted", "(empty result)"));
  }

  return new McpResultPreview(output, options.expanded, theme);
}

/**
 * Convert MCP content blocks to safe terminal text without copying binary payloads.
 */
function getTextOutput(result: AgentToolResult<Record<string, unknown>>): string {
  return result.content.map(formatContentBlock).join("\n");
}

/**
 * Keep text blocks verbatim and show metadata for image blocks so non-text results are not hidden.
 */
function formatContentBlock(block: AgentToolResult<Record<string, unknown>>["content"][number]): string {
  if (block.type === "text") {
    return sanitizeTerminalText(block.text);
  }

  return formatImagePlaceholder(block);
}

/**
 * Remove terminal control sequences from external MCP text before TUI rendering.
 */
function sanitizeTerminalText(text: string): string {
  return Array.from(text.replace(TERMINAL_SEQUENCE_PATTERN, "").replace(/\r/g, ""))
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) {
        return false;
      }
      if (code === 0x09 || code === 0x0a) {
        return true;
      }
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
        return false;
      }
      if (code >= 0xfff9 && code <= 0xfffb) {
        return false;
      }
      return true;
    })
    .join("");
}

/**
 * Render the first lines and put the expansion hint after the preview, matching Pi's standard read renderer.
 */
class McpResultPreview implements RenderComponent {
  constructor(
    private readonly output: string,
    private readonly expanded: boolean,
    private readonly theme: RenderTheme,
  ) {}

  render(width: number): string[] {
    const lines = trimTrailingEmptyLines(this.output.split("\n"));
    const maxLines = this.expanded ? lines.length : COLLAPSED_RESULT_PREVIEW_LINES;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    const rendered = ["", ...displayLines.map((line) => truncateLine(this.theme.fg("toolOutput", replaceTabs(line)), width))];

    if (remaining > 0) {
      rendered.push(truncateLine(formatRemainingLinesHint(remaining, this.theme), width));
    }

    return rendered;
  }

  invalidate(): void {}
}

/**
 * Render fixed text as a Pi-compatible component without importing Pi TUI at runtime.
 */
class StaticText implements RenderComponent {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return this.text.split("\n").map((line) => truncateLine(line, width));
  }

  invalidate(): void {}
}

/**
 * Format the same expansion hint as standard Pi text-tool renderers.
 */
function formatRemainingLinesHint(remaining: number, theme: RenderTheme): string {
  return `${theme.fg("muted", `... (${remaining} more lines,`)} ${getPiKeyHint("app.tools.expand", "to expand", theme)})`;
}

/**
 * Use Pi's configured keybinding text when the adapter runs inside Pi.
 */
function getPiKeyHint(keybinding: string, description: string, theme: RenderTheme): string {
  return theme.fg("dim", getConfiguredKeyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

/**
 * Read Pi's user keybinding override once and fall back to Pi's default expand key.
 */
function getConfiguredKeyText(keybinding: string): string {
  const cached = configuredKeyTextCache.get(keybinding);
  if (cached) {
    return cached;
  }

  const keyText = readConfiguredKeyText(keybinding);
  configuredKeyTextCache.set(keybinding, keyText);
  return keyText;
}

/**
 * Resolve a keybinding from Pi's config file without throwing during terminal rendering.
 */
function readConfiguredKeyText(keybinding: string): string {
  try {
    if (!existsSync(KEYBINDINGS_PATH)) {
      return DEFAULT_EXPAND_KEY;
    }

    const parsed = JSON.parse(readFileSync(KEYBINDINGS_PATH, "utf-8")) as Record<string, unknown>;
    const value = parsed[keybinding];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (Array.isArray(value)) {
      const keys = value.filter((item): item is string => typeof item === "string" && item.length > 0);
      if (keys.length > 0) {
        return keys.join("/");
      }
    }
  } catch {
    return DEFAULT_EXPAND_KEY;
  }

  return DEFAULT_EXPAND_KEY;
}

/**
 * Remove empty lines from the end of output before calculating the collapsed preview.
 */
function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}

/**
 * Match Pi text tool rendering by replacing tabs before terminal output.
 */
function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

/**
 * Truncate a line to terminal width without splitting ANSI escape sequences.
 */
function truncateLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) {
    return line;
  }

  const ellipsis = "...";
  return takeVisibleWidth(line, Math.max(0, width - ellipsis.length)) + ellipsis;
}

/**
 * Return the prefix that fits into the requested terminal width.
 */
function takeVisibleWidth(text: string, width: number): string {
  let result = "";
  let visible = 0;

  for (let index = 0; index < text.length && visible < width;) {
    const ansi = text.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
    if (ansi) {
      result += ansi[0];
      index += ansi[0].length;
      continue;
    }

    result += text[index];
    visible += 1;
    index += 1;
  }

  return result;
}

/**
 * Count printable characters; ANSI color sequences do not occupy terminal columns.
 */
function visibleWidth(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}
