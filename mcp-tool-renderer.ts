import { keyHint, type AgentToolResult, type Theme } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth } from "@mariozechner/pi-tui";

const COLLAPSED_RESULT_LINES = 10;
const TRUNCATED_SUFFIX = "...";

type SummaryKind = "direct" | "proxy";

export class McpCallComponent extends Text {
  private args: Record<string, unknown>;

  constructor(
    private titleText: string,
    args: Record<string, unknown> | undefined,
    private expanded: boolean,
    private theme: Theme,
    private summaryKind: SummaryKind,
  ) {
    super("", 0, 0);
    this.args = args ?? {};
  }

  override render(width: number): string[] {
    const title = this.theme.fg("toolTitle", this.theme.bold(this.titleText));
    if (this.expanded) {
      this.setText(`${title}\n\n${this.theme.fg("toolOutput", JSON.stringify(this.args ?? {}, null, 2))}`);
    } else {
      let summary = JSON.stringify(this.args) ?? "{}";
      if (this.summaryKind === "proxy") {
        // Keep this in the same order as the proxy mcp tool dispatch in index.ts.
        // These are not arbitrary MCP argument names; they are this adapter's proxy modes.
        if (this.args.action === "ui-messages") summary = "ui-messages";
        else if (this.args.tool) summary = `tool ${this.args.tool}`;
        else if (this.args.connect) summary = `connect ${this.args.connect}`;
        else if (this.args.describe) summary = `describe ${this.args.describe}`;
        else if (this.args.search) summary = `search ${JSON.stringify(this.args.search)}`;
        else if (this.args.server) summary = `server ${this.args.server}`;
        else summary = "status";
      }
      const separator = summary ? " " : "";
      const summaryWidth = Math.max(0, width - visibleWidth(title) - visibleWidth(separator));
      this.setText(`${title}${separator}${this.theme.fg("dim", truncateVisible(summary, summaryWidth).text)}`);
    }
    return super.render(width);
  }
}

export class McpResultComponent extends Text {
  private output: string;
  private isError: boolean;

  constructor(
    result: AgentToolResult<unknown>,
    private expanded: boolean,
    contextIsError: boolean,
    private theme: Theme,
  ) {
    super("", 0, 0);
    this.output = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .filter(Boolean)
      .join("\n");
    this.isError = contextIsError || !!(result.details as { error?: unknown } | undefined)?.error;
  }

  override render(width: number): string[] {
    // Do not parse or unwrap JSON-looking text here. Some MCP servers put stdout/stderr
    // inside a JSON string, but treating tool text as data changes the renderer from
    // display code into guesswork. Keep that tradeoff explicit: show returned text as text.
    const normalized = this.output.replace(/\r\n/g, "\n").replace(/\r/g, "").trimEnd();
    let output = normalized || "(empty result)";
    if (normalized && !this.expanded) {
      const logicalLines = normalized.split("\n");
      const truncatedLines = logicalLines
        .slice(0, COLLAPSED_RESULT_LINES)
        .map((line) => truncateVisible(line, Math.max(0, width)));
      const lines = truncatedLines.map((line) => line.text);
      const skippedCount = logicalLines.length - truncatedLines.length;

      if (skippedCount > 0 || truncatedLines.some((line) => line.truncated)) {
        const hidden = skippedCount > 0
          ? `${skippedCount} more line${skippedCount === 1 ? "" : "s"}`
          : "more text";
        output = [
          ...lines,
          `... (${hidden}, ${keyHint("app.tools.expand", "to expand")})`,
        ].join("\n");
      } else {
        output = lines.join("\n");
      }
    }

    const outputColor = this.isError ? "error" : "toolOutput";
    this.setText(`\n${this.theme.fg(outputColor, output)}`);
    return super.render(width);
  }
}

function truncateVisible(value: string, maxWidth: number): { text: string; truncated: boolean } {
  if (visibleWidth(value) <= maxWidth) return { text: value, truncated: false };

  const suffixWidth = visibleWidth(TRUNCATED_SUFFIX);
  if (maxWidth <= suffixWidth) {
    return { text: TRUNCATED_SUFFIX.slice(0, Math.max(0, maxWidth)), truncated: true };
  }

  const targetWidth = maxWidth - suffixWidth;
  let current = "";
  for (const char of value) {
    if (visibleWidth(current + char) > targetWidth) break;
    current += char;
  }
  return { text: `${current}${TRUNCATED_SUFFIX}`, truncated: true };
}
