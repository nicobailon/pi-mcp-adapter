import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

type McpToolResultDetails = Record<string, unknown> & { error?: unknown };
type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

interface RenderTheme {
  fg: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

const plainTheme: RenderTheme = { fg: (_name, text) => text };

export interface McpProxyToolCallInput {
  tool?: string;
  args?: string | Record<string, unknown>;
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
const DEFAULT_MAX_COLLAPSED_LINES = 3;
/**
 * Collapsed TUI rows only need enough source text to fill a few visual lines.
 * Capping here keeps ICU/grapheme wrapping off multi-10KB MCP dumps on every
 * keystroke invalidate (Pi rebuilds tool rows on each composer render).
 */
const COLLAPSED_RENDER_CHAR_SLACK = 8;

class CollapsibleText implements Component {
  constructor(
    private readonly text: string,
    private readonly expanded: boolean,
    private readonly maxCollapsedLines: number,
    private readonly ellipsis: string,
    private readonly expandHint: string,
  ) {}

  render(width: number): string[] {
    if (this.expanded) {
      return new Text(this.text, 0, 0).render(width);
    }

    // Only wrap a prefix large enough to fill the collapsed viewport. Full-text
    // wrap of large MCP results dominates the main-thread sample (Intl.Segmenter).
    // Multi-line dumps are already truncated by formatMcpToolResultLines.
    const safeWidth = Math.max(1, Math.floor(width));
    const charBudget = safeWidth * (this.maxCollapsedLines + 1) * COLLAPSED_RENDER_CHAR_SLACK;
    const prefix = this.text.length > charBudget
      ? this.text.slice(0, charBudget)
      : this.text;
    const fullyIncluded = prefix === this.text;

    const lines = new Text(prefix, 0, 0).render(width);
    if (fullyIncluded && lines.length <= this.maxCollapsedLines) return lines;

    return [
      ...lines.slice(0, this.maxCollapsedLines),
      ...new Text(`${this.ellipsis}\n${this.expandHint}`, 0, 0).render(width),
    ];
  }

  invalidate(): void {}
}

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

function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  return [`[image: ${block.mimeType}]`];
}

export function formatMcpToolResultIdentity(details: McpToolResultDetails | undefined): string | null {
  if (details?.mode !== "call") return null;
  const server = typeof details.server === "string"
    ? details.server
    : typeof details.hintServer === "string"
      ? details.hintServer
      : null;
  if (!server) return null;
  if (typeof details.tool === "string") return `MCP ${server}/${details.tool}`;
  if (typeof details.resourceUri === "string") return `MCP ${server} resource ${details.resourceUri}`;
  if (typeof details.requestedTool === "string") return `MCP ${server}/${details.requestedTool}`;
  return null;
}

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
  if (options.isPartial) {
    return new Text(activeTheme.fg("warning", "Running MCP tool..."), 0, 0);
  }

  const hasErrorDetails = Boolean(result.details.error);
  const expanded = options.expanded || context?.isError === true || hasErrorDetails;
  // Keep logical collapse for multi-line dumps; CollapsibleText still handles
  // single-line visual wrap without scanning the full body when collapsed.
  const display = formatMcpToolResultLines(result, expanded);
  const identity = formatMcpToolResultIdentity(result.details);
  const output = [
    ...(identity ? [activeTheme.fg("muted", identity)] : []),
    ...display.lines.map((line) => activeTheme.fg("toolOutput", line)),
  ].join("\n");

  return new CollapsibleText(
    output,
    expanded,
    DEFAULT_MAX_COLLAPSED_LINES + (identity ? 1 : 0),
    activeTheme.fg("muted", "…"),
    activeTheme.fg("muted", "(Ctrl+O to expand)"),
  );
}
