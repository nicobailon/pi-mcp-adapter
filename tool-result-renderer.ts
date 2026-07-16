import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type McpToolResultDetails = Record<string, unknown> & { error?: unknown };
type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

interface RenderTheme {
  /** Colorize text using a named semantic color (e.g. "toolTitle", "muted", "warning"). */
  fg: (name: string, text: string) => string;
  /** Optional bold wrapper — applied to the title line. */
  bold?: (text: string) => string;
}

export interface McpProxyToolCallInput {
  tool?: string;
  args?: string;
  connect?: string;
  describe?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
}

interface McpToolRenderContext {
  isError: boolean;
}

export interface McpToolResultDisplay {
  lines: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;

// Plain pass-through theme used as default when no theme is provided.
// theme parameters are optional across all render functions to support
// callers that don't depend on TUI styling (e.g. tests, headless mode).
const plainTheme: RenderTheme = { fg: (_name: string, text: string) => text };

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatJsonish(value: unknown, maxChars: number): string {
  if (typeof value === "string") {
    try {
      return truncateText(JSON.stringify(JSON.parse(value), null, 2), maxChars);
    } catch {
      return truncateText(value, maxChars);
    }
  }

  try {
    return truncateText(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return truncateText(String(value), maxChars);
  }
}

function hasUsefulObjectContent(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

export function formatMcpProxyToolCallLines(
  args: McpProxyToolCallInput,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (args.action === "ui-messages") return [`mcp ${args.action}`];

  if (args.tool) {
    const target = args.server ? `${args.tool} @ ${args.server}` : args.tool;
    const lines = [`mcp call ${target}`];
    if (args.args) lines.push(formatJsonish(args.args, maxInputChars));
    return lines;
  }

  if (args.connect) return [`mcp connect ${args.connect}`];
  if (args.describe) return [`mcp describe ${args.describe}`];

  if (args.search) {
    let line = `mcp search ${args.search}`;
    if (args.server) line += ` @ ${args.server}`;
    if (args.regex === true) line += " (regex)";
    if (args.includeSchemas === false) line += " (schemas hidden)";
    return [line];
  }

  if (args.server) return [`mcp list ${args.server}`];
  if (args.action) return [`mcp ${args.action}`];

  return ["mcp status"];
}

export function formatMcpDirectToolCallLines(
  displayName: string,
  args: Record<string, unknown>,
  maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
  if (!hasUsefulObjectContent(args)) return [displayName];
  return [displayName, formatJsonish(args, maxInputChars)];
}

/** Shared rendering core for tool call display — styles the title and detail lines. */
function renderToolCallLines(lines: string[], theme?: RenderTheme) {
  const activeTheme = theme ?? plainTheme;
  const [title = "mcp", ...rest] = lines;
  const styledTitle = activeTheme.fg("toolTitle", activeTheme.bold ? activeTheme.bold(title) : title);
  const styledRest = rest.map(line => activeTheme.fg("muted", line));
  return new Text([styledTitle, ...styledRest].join("\n"), 0, 0);
}

export function renderMcpProxyToolCall(args: McpProxyToolCallInput, theme?: RenderTheme) {
  return renderToolCallLines(formatMcpProxyToolCallLines(args), theme);
}

export function createMcpDirectToolCallRenderer(displayName: string) {
  return (args: Record<string, unknown>, theme?: RenderTheme) => {
    return renderToolCallLines(formatMcpDirectToolCallLines(displayName, args), theme);
  };
}

/** Convert MCP content blocks (text or image) into display lines. */
function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  return [`[image: ${block.mimeType}]`];
}

/** Format MCP content blocks into display lines, collapsing long output when not expanded. */
export function formatMcpToolResultLines(
  result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
  expanded: boolean,
  maxCollapsedLines = 3,
): McpToolResultDisplay {
  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];

  if (expanded || lines.length <= maxCollapsedLines) {
    return { lines, truncated: false };
  }

  return {
    lines: [...lines.slice(0, maxCollapsedLines), "…"],
    truncated: true,
  };
}

export function renderMcpToolResult(
  result: AgentToolResult<McpToolResultDetails>,
  options: ToolRenderResultOptions,
  theme?: RenderTheme,
  context?: McpToolRenderContext,
) {
  const activeTheme = theme ?? plainTheme;

  // Stream partial → show a simple "running" indicator.
  if (options.isPartial) {
    return new Text(activeTheme.fg("warning", "Running MCP tool..."), 0, 0);
  }

  // Auto-expand the result when the tool reported an error or the caller
  // signals an error context, so the user can see failure details immediately.
  const hasErrorDetails = Boolean(result.details.error);
  const display = formatMcpToolResultLines(result, options.expanded || context?.isError === true || hasErrorDetails);
  const output = display.lines
    .map((line) => line === "…" ? activeTheme.fg("muted", line) : activeTheme.fg("toolOutput", line))
    .join("\n");
  const hint = display.truncated && !options.expanded
    ? `\n${activeTheme.fg("muted", "(Ctrl+O to expand)")}`
    : "";

  return new Text(`${output}${hint}`, 0, 0);
}
