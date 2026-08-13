import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

interface McpToolRenderState {
  compactTitle?: string;
}

interface McpToolRenderContext {
  isError: boolean;
  isPartial?: boolean;
  expanded?: boolean;
  state?: McpToolRenderState;
}

export type McpToolResultRendering = "compact" | "boxed";

export interface McpToolRenderOptions {
  resultRendering: McpToolResultRendering;
  collapsedResultLines: 1 | 2 | 3;
}

export interface McpToolRenderSettings {
  toolResultRendering?: unknown;
  collapsedResultLines?: unknown;
}

export interface McpToolResultDisplay {
  lines: string[];
  truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;
const DEFAULT_BOXED_COLLAPSED_LINES = 3;
const DEFAULT_COMPACT_COLLAPSED_LINES = 1;
const DEFAULT_MAX_COLLAPSED_CHARS = 8000;
const COLLAPSED_RENDER_CHAR_SLACK = 8;

class EmptyComponent implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

class CompactMcpToolResult implements Component {
  private rendered: { width: number; lines: string[] } | null = null;

  constructor(
    private readonly title: string,
    private readonly display: McpToolResultDisplay,
    private readonly theme: RenderTheme,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.rendered?.width === safeWidth) return this.rendered.lines;

    const resultLines = this.display.lines.filter((line, index, lines) => {
      return !(this.display.truncated && index === lines.length - 1 && line === "…");
    });
    const lines = resultLines.length > 0 ? resultLines : [""];
    const bodies = lines.map((line, index) => {
      const prefix = index === 0 && this.title ? `${this.theme.fg("toolTitle", this.title)} → ` : "";
      return `${prefix}${this.theme.fg("toolOutput", line)}`;
    });
    const hiddenText = this.display.truncated || bodies.some((body) => visibleWidth(body) > safeWidth);
    const rendered = bodies.map((body, index) => {
      const suffix = hiddenText && index === bodies.length - 1 ? " … (Ctrl+O to expand)" : "";
      if (!suffix) return truncateToWidth(body, safeWidth, "…");
      if (safeWidth >= suffix.length + 20) {
        return `${truncateToWidth(body, safeWidth - suffix.length, "…")}${this.theme.fg("muted", suffix)}`;
      }
      const shortSuffix = " (Ctrl+O)";
      if (safeWidth >= shortSuffix.length + 5) {
        return `${truncateToWidth(body, safeWidth - shortSuffix.length, "…")}${this.theme.fg("muted", shortSuffix)}`;
      }
      return truncateToWidth(this.theme.fg("muted", shortSuffix.trim()), safeWidth, "…");
    });
    this.rendered = { width: safeWidth, lines: rendered };
    return rendered;
  }

  invalidate(): void {
    this.rendered = null;
  }
}

class CollapsibleText implements Component {
  private readonly fullText: Text;
  private readonly footerText: Text;
  private collapsedText: { charBudget: number; fullyIncluded: boolean; text: Text } | null = null;
  private collapsedRender: { width: number; charBudget: number; lines: string[] } | null = null;

  constructor(
    private readonly text: string,
    private readonly expanded: boolean,
    private readonly maxCollapsedLines: number,
    ellipsis: string,
    expandHint: string,
    private readonly preTruncated = false,
  ) {
    this.fullText = new Text(text, 0, 0);
    this.footerText = new Text(`${ellipsis}\n${expandHint}`, 0, 0);
  }

  render(width: number): string[] {
    if (this.expanded) {
      return this.fullText.render(width);
    }

    const safeWidth = Math.max(1, Math.floor(width));
    const charBudget = safeWidth * (this.maxCollapsedLines + 1) * COLLAPSED_RENDER_CHAR_SLACK;
    if (!this.collapsedText || this.collapsedText.charBudget !== charBudget) {
      const prefix = this.text.length > charBudget
        ? this.text.slice(0, charBudget)
        : this.text;
      this.collapsedText = {
        charBudget,
        fullyIncluded: prefix === this.text,
        text: new Text(prefix, 0, 0),
      };
      this.collapsedRender = null;
    }

    const lines = this.collapsedText.text.render(width);
    if (!this.preTruncated && this.collapsedText.fullyIncluded && lines.length <= this.maxCollapsedLines) return lines;
    if (this.collapsedRender?.width === width && this.collapsedRender.charBudget === charBudget) {
      return this.collapsedRender.lines;
    }

    const rendered = [
      ...lines.slice(0, this.maxCollapsedLines),
      ...this.footerText.render(width),
    ];
    this.collapsedRender = { width, charBudget, lines: rendered };
    return rendered;
  }

  invalidate(): void {
    this.fullText.invalidate();
    this.footerText.invalidate();
    this.collapsedText?.text.invalidate();
    this.collapsedRender = null;
  }
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

export function resolveMcpToolRenderOptions(settings?: McpToolRenderSettings): McpToolRenderOptions {
  const resultRendering = settings?.toolResultRendering === "boxed" ? "boxed" : "compact";
  const collapsedLines = settings?.collapsedResultLines;
  const defaultLines = resultRendering === "boxed" ? DEFAULT_BOXED_COLLAPSED_LINES : DEFAULT_COMPACT_COLLAPSED_LINES;
  return {
    resultRendering,
    collapsedResultLines: collapsedLines === 1 || collapsedLines === 2 || collapsedLines === 3 ? collapsedLines : defaultLines,
  };
}

function shouldUseCompactFinalRender(options: McpToolRenderOptions, context?: McpToolRenderContext): boolean {
  return options.resultRendering === "compact"
    && context !== undefined
    && context.isPartial === false
    && context.expanded !== true
    && context.isError !== true;
}

function renderToolCall(
  lines: string[],
  theme: RenderTheme | undefined,
  context: McpToolRenderContext | undefined,
  options: McpToolRenderOptions,
) {
  if (context?.state) context.state.compactTitle = lines[0] ?? "mcp";
  if (shouldUseCompactFinalRender(options, context)) return new EmptyComponent();
  return renderToolCallLines(lines, theme);
}

export function renderMcpProxyToolCall(
  args: McpProxyToolCallInput,
  theme?: RenderTheme,
  context?: McpToolRenderContext,
) {
  return renderToolCall(formatMcpProxyToolCallLines(args), theme, context, resolveMcpToolRenderOptions());
}

export function createMcpProxyToolCallRenderer(options: McpToolRenderOptions) {
  return (args: McpProxyToolCallInput, theme?: RenderTheme, context?: McpToolRenderContext) => {
    return renderToolCall(formatMcpProxyToolCallLines(args), theme, context, options);
  };
}

export function createMcpDirectToolCallRenderer(displayName: string, options = resolveMcpToolRenderOptions()) {
  return (args: Record<string, unknown>, theme?: RenderTheme, context?: McpToolRenderContext) => {
    return renderToolCall(formatMcpDirectToolCallLines(displayName, args), theme, context, options);
  };
}

function blockToLines(block: McpToolContentBlock): string[] {
  if (block.type === "text") {
    return block.text.split("\n");
  }
  return [`[image: ${block.mimeType}]`];
}

function collectCollapsedResultLines(
  content: AgentToolResult<McpToolResultDetails>["content"],
  maxLines: number,
  maxChars: number,
): McpToolResultDisplay {
  if (content.length === 0) return { lines: ["(empty result)"], truncated: false };

  const lines: string[] = [];
  let remainingChars = maxChars;
  let truncated = false;

  const appendLine = (line: string) => {
    if (lines.length >= maxLines || remainingChars <= 0) {
      truncated = true;
      return false;
    }

    if (line.length > remainingChars) {
      lines.push(line.slice(0, remainingChars));
      truncated = true;
      remainingChars = 0;
      return false;
    }

    lines.push(line);
    remainingChars -= line.length + 1;
    return true;
  };

  for (const block of content) {
    if (block.type !== "text") {
      if (!appendLine(`[image: ${block.mimeType}]`)) break;
      continue;
    }

    let start = 0;
    while (start <= block.text.length) {
      const newline = block.text.indexOf("\n", start);
      const line = newline === -1 ? block.text.slice(start) : block.text.slice(start, newline);
      if (!appendLine(line)) break;
      if (newline === -1) break;
      start = newline + 1;
    }

    if (truncated) break;
  }

  if (lines.length === 0) lines.push("");
  if (truncated && lines.length >= maxLines) lines.push("…");
  return { lines, truncated };
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
  maxCollapsedLines = DEFAULT_BOXED_COLLAPSED_LINES,
  maxCollapsedChars = DEFAULT_MAX_COLLAPSED_CHARS,
): McpToolResultDisplay {
  if (!expanded) {
    return collectCollapsedResultLines(result.content, maxCollapsedLines, maxCollapsedChars);
  }

  const allLines = result.content.flatMap(blockToLines);
  const lines = allLines.length > 0 ? allLines : ["(empty result)"];
  return { lines, truncated: false };
}

export function renderMcpToolResult(
  result: AgentToolResult<McpToolResultDetails>,
  options: ToolRenderResultOptions,
  theme?: RenderTheme,
  context?: McpToolRenderContext,
  renderOptions = resolveMcpToolRenderOptions(),
) {
  const activeTheme = theme ?? plainTheme;
  if (options.isPartial) {
    return new Text(activeTheme.fg("warning", "Running MCP tool..."), 0, 0);
  }

  const hasErrorDetails = Boolean(result.details.error);
  const expanded = options.expanded || context?.isError === true || hasErrorDetails;
  if (!expanded && renderOptions.resultRendering === "compact") {
    const display = formatMcpToolResultLines(result, false, renderOptions.collapsedResultLines);
    const title = context?.state?.compactTitle ?? formatMcpToolResultIdentity(result.details) ?? "";
    return new CompactMcpToolResult(title, display, activeTheme);
  }

  const display = formatMcpToolResultLines(result, expanded, renderOptions.collapsedResultLines);
  const identity = formatMcpToolResultIdentity(result.details);
  const output = [
    ...(identity ? [activeTheme.fg("muted", identity)] : []),
    ...display.lines.map((line) => activeTheme.fg("toolOutput", line)),
  ].join("\n");

  return new CollapsibleText(
    output,
    expanded,
    renderOptions.collapsedResultLines + (identity ? 1 : 0),
    activeTheme.fg("muted", "…"),
    activeTheme.fg("muted", "(Ctrl+O to expand)"),
    display.truncated,
  );
}

export function createMcpToolResultRenderer(renderOptions: McpToolRenderOptions) {
  return (
    result: AgentToolResult<McpToolResultDetails>,
    options: ToolRenderResultOptions,
    theme?: RenderTheme,
    context?: McpToolRenderContext,
  ) => renderMcpToolResult(result, options, theme, context, renderOptions);
}
