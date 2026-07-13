import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type McpToolResultDetails = Record<string, unknown> & { error?: unknown };
type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

interface RenderTheme {
  fg: (name: string, text: string) => string;
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
const DEFAULT_MAX_COLLAPSED_LINE_CHARS = 500;

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

function renderToolCallLines(lines: string[], theme: RenderTheme) {
  const [title = "mcp", ...rest] = lines;
  const styledTitle = theme.fg("toolTitle", theme.bold ? theme.bold(title) : title);
  const styledRest = rest.map(line => theme.fg("muted", line));
  return new Text([styledTitle, ...styledRest].join("\n"), 0, 0);
}

export function renderMcpProxyToolCall(args: McpProxyToolCallInput, theme: RenderTheme) {
  return renderToolCallLines(formatMcpProxyToolCallLines(args), theme);
}

export function createMcpDirectToolCallRenderer(displayName: string) {
  return (args: Record<string, unknown>, theme: RenderTheme) => {
    return renderToolCallLines(formatMcpDirectToolCallLines(displayName, args), theme);
  };
}

function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  return [`[image: ${block.mimeType}]`];
}

export function formatMcpToolResultLines(
  result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
  expanded: boolean,
  maxCollapsedLines = 3,
  maxCollapsedLineChars = DEFAULT_MAX_COLLAPSED_LINE_CHARS,
): McpToolResultDisplay {
  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];

  if (expanded) {
    return { lines, truncated: false };
  }

  const collapsedLines = lines.slice(0, maxCollapsedLines);
  const hasLongLine = collapsedLines.some(line => line.length > maxCollapsedLineChars);
  const hasMoreLines = lines.length > maxCollapsedLines;
  if (!hasLongLine && !hasMoreLines) {
    return { lines, truncated: false };
  }

  return {
    lines: [
      ...collapsedLines.map(line => truncateText(line, maxCollapsedLineChars)),
      ...(hasMoreLines ? ["…"] : []),
    ],
    truncated: true,
  };
}

export function renderMcpToolResult(
  result: AgentToolResult<McpToolResultDetails>,
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context?: McpToolRenderContext,
) {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "Running MCP tool..."), 0, 0);
  }

  const hasErrorDetails = Boolean(result.details.error);
  const display = formatMcpToolResultLines(result, options.expanded || context?.isError === true || hasErrorDetails);
  const output = display.lines
    .map((line) => line === "…" ? theme.fg("muted", line) : theme.fg("toolOutput", line))
    .join("\n");
  const hint = display.truncated && !options.expanded
    ? `\n${theme.fg("muted", "(Ctrl+O to expand)")}`
    : "";

  return new Text(`${output}${hint}`, 0, 0);
}
