import { keyHint, type AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

type RenderOptions = { expanded: boolean };
type RenderContext = {
  lastComponent?: Text;
  expanded?: boolean;
  isError?: boolean;
};

type RenderTheme = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

const COLLAPSED_RESULT_LINES = 10;
const COLLAPSED_LINE_CHARS = 240;
const COLLAPSED_SUMMARY_CHARS = 80;

export function summarizeDirectMcpCall(args: unknown): string {
  const a = isRecord(args) ? args : {};
  for (const key of ["objective", "query", "url", "command"] as const) {
    const value = a[key];
    if (typeof value === "string" && value) return truncateChars(value, COLLAPSED_SUMMARY_CHARS);
  }
  return truncateChars(JSON.stringify(args ?? {}), COLLAPSED_SUMMARY_CHARS);
}

export function formatMcpResultPreview(output: string, expanded: boolean): string {
  const normalized = normalizeMcpResultText(output).replace(/\r\n/g, "\n").replace(/\r/g, "").trimEnd();
  if (!normalized) return "(empty result)";
  if (expanded) return normalized;

  const lines = normalized.split("\n");
  const displayLines = lines.slice(0, COLLAPSED_RESULT_LINES).map((line) => truncateChars(line, COLLAPSED_LINE_CHARS));
  const remainingLines = lines.length - displayLines.length;
  const preview = displayLines.join("\n");
  const remainingChars = Math.max(0, normalized.length - preview.length);
  if (remainingLines <= 0 && remainingChars <= 0) return preview;

  const hidden = remainingLines > 0
    ? `${remainingLines} more line${remainingLines === 1 ? "" : "s"}`
    : `${remainingChars} more char${remainingChars === 1 ? "" : "s"}`;
  return [
    preview,
    `... (${hidden}, ${keyHint("app.tools.expand", "to expand")})`,
  ].join("\n");
}

export function normalizeMcpResultText(output: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (!isRecord(parsed)) return output;

  const stdout = typeof parsed.stdout === "string" ? parsed.stdout.trimEnd() : "";
  const stderr = typeof parsed.stderr === "string" ? parsed.stderr.trimEnd() : "";
  if (!stdout && !stderr) return output;

  if (stdout && stderr) return `${stdout}\n\nstderr:\n${stderr}`;
  return stdout || stderr;
}

export function extractToolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image") return `[image: ${block.mimeType ?? "unknown"}]`;
      return `[${(block as { type?: string }).type ?? "content"}]`;
    })
    .filter(Boolean)
    .join("\n");
}

export function createMcpCallRenderer(titleText: string, summarize: (args: unknown) => string) {
  return (args: unknown, theme: RenderTheme, context: RenderContext) => {
    const text = context.lastComponent ?? new Text("", 0, 0);
    const title = theme.fg("toolTitle", theme.bold(titleText));
    if (context.expanded) {
      text.setText(`${title}\n\n${theme.fg("toolOutput", JSON.stringify(args ?? {}, null, 2))}`);
    } else {
      text.setText(`${title} ${theme.fg("dim", summarize(args))}`);
    }
    return text;
  };
}

export function renderMcpResult(result: AgentToolResult<unknown>, options: RenderOptions, theme: RenderTheme, context: RenderContext) {
  const text = context.lastComponent ?? new Text("", 0, 0);
  const output = formatMcpResultPreview(extractToolResultText(result), options.expanded);
  const styled = (context.isError || (result.details as { error?: unknown } | undefined)?.error)
    ? theme.fg("error", output)
    : theme.fg("toolOutput", output);
  text.setText(`\n${styled}`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

