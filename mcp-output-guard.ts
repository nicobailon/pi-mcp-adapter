import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock } from "./types.js";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const NOTICE_SEPARATOR = "\n\n";
const MIN_PREVIEW_BYTES = 8 * 1024;
const MIN_PREVIEW_LINES = 100;
const TRUNCATED_SUFFIX_NOTICE = "\n[Additional generated text truncated to keep the response within Pi limits.]";

export interface McpOutputGuardDetails {
  truncated: boolean;
  fullOutputPath?: string;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  writeError?: string;
}

interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
}

interface OutputStats {
  lines: number;
  bytes: number;
  hasOversizedPayload: boolean;
}

interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
  forceTruncated?: boolean;
}

interface GuardOptions {
  prefix?: string;
  suffix?: string;
}

export interface McpOutputGuardResult {
  content: ContentBlock[];
  details?: McpOutputGuardDetails;
}

/**
 * Bounds model-facing MCP output and writes the full text representation to a temp file when it exceeds Pi's standard limits.
 */
export async function guardMcpOutput(content: ContentBlock[], options: GuardOptions = {}): Promise<McpOutputGuardResult> {
  const textOutput = serializeContent(content);
  const prefix = options.prefix ?? "";
  const suffix = options.suffix ?? "";
  const rawStats = getRawStats(content);
  const composedText = `${prefix}${textOutput}${suffix}`;
  const composedStats = getTextStats(composedText);
  const shouldTruncate = rawStats.lines > DEFAULT_MAX_LINES
    || rawStats.bytes > DEFAULT_MAX_BYTES
    || rawStats.hasOversizedPayload
    || composedStats.lines > DEFAULT_MAX_LINES
    || composedStats.bytes > DEFAULT_MAX_BYTES;
  const initialTruncation = truncateTail(textOutput, { forceTruncated: shouldTruncate });
  if (!initialTruncation.truncated) {
    if (prefix || suffix) {
      return { content: [{ type: "text", text: composedText }] };
    }
    return { content };
  }

  let fullOutputPath: string | undefined;
  let writeError: string | undefined;
  try {
    fullOutputPath = getTempFilePath();
    await writeFile(fullOutputPath, textOutput, { encoding: "utf-8", mode: 0o600 });
  } catch (error) {
    fullOutputPath = undefined;
    writeError = error instanceof Error ? error.message : String(error);
  }

  const bounded = buildBoundedOutput(textOutput, fullOutputPath, writeError, shouldTruncate, prefix, suffix);
  return {
    content: [{ type: "text", text: bounded.text }],
    details: {
      truncated: true,
      fullOutputPath,
      totalLines: Math.max(rawStats.lines, bounded.truncation.totalLines),
      totalBytes: Math.max(rawStats.bytes, bounded.truncation.totalBytes),
      outputLines: bounded.truncation.outputLines,
      outputBytes: bounded.truncation.outputBytes,
      writeError,
    },
  };
}

/**
 * Converts Pi content blocks to the text form stored in the full-output file.
 */
function serializeContent(content: ContentBlock[]): string {
  return content.map(serializeBlock).join("\n");
}

/**
 * Keeps text content verbatim and replaces binary image payloads with metadata that does not copy base64 data.
 */
function serializeBlock(block: ContentBlock): string {
  if (block.type === "text") {
    return block.text;
  }

  const byteLength = Buffer.byteLength(block.data ?? "", "utf-8");
  return `[Image content: ${block.mimeType ?? "image/*"}, ${formatSize(byteLength)} base64 payload omitted]`;
}

/**
 * Measures the payload size that would otherwise be returned to the model or stored in details.
 */
function getRawStats(content: ContentBlock[]): OutputStats {
  let bytes = 0;
  let lines = 1;
  let hasOversizedPayload = false;

  for (const [index, block] of content.entries()) {
    if (index > 0) {
      bytes += 1;
      lines += 1;
    }

    if (block.type === "text") {
      bytes += Buffer.byteLength(block.text, "utf-8");
      lines += block.text.split("\n").length - 1;
      continue;
    }

    const payloadBytes = Buffer.byteLength(block.data ?? "", "utf-8");
    bytes += payloadBytes;
    if (payloadBytes > DEFAULT_MAX_BYTES) {
      hasOversizedPayload = true;
    }
  }

  return { bytes, lines, hasOversizedPayload };
}

/**
 * Measures text by UTF-8 bytes and lines.
 */
function getTextStats(text: string): { bytes: number; lines: number } {
  return { bytes: Buffer.byteLength(text, "utf-8"), lines: text.split("\n").length };
}

/**
 * Creates an unpredictable temp file path that follows Pi's file-backed-output convention.
 */
function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `pi-mcp-${id}.log`);
}

/**
 * Builds a final model-facing response that includes caller text and the truncation notice inside the output budget.
 */
function buildBoundedOutput(
  content: string,
  fullOutputPath: string | undefined,
  writeError: string | undefined,
  forceTruncated: boolean,
  prefix: string,
  suffix: string,
): { text: string; truncation: TruncationResult } {
  let boundedSuffix = suffix;
  let truncation = truncateTail(content, { forceTruncated });
  let notice = formatTruncationNotice(truncation, fullOutputPath, writeError);

  for (let attempt = 0; attempt < 6; attempt++) {
    boundedSuffix = boundSuffix(suffix, prefix, notice);
    const reservedText = `${prefix}${boundedSuffix}${NOTICE_SEPARATOR}${notice}`;
    const reservedBytes = Buffer.byteLength(reservedText, "utf-8");
    const reservedLines = countNewlines(reservedText);
    truncation = truncateTail(content, {
      maxBytes: Math.max(0, DEFAULT_MAX_BYTES - reservedBytes),
      maxLines: Math.max(0, DEFAULT_MAX_LINES - reservedLines),
      forceTruncated,
    });
    const nextNotice = formatTruncationNotice(truncation, fullOutputPath, writeError);
    if (nextNotice === notice) {
      break;
    }
    notice = nextNotice;
  }

  const text = `${prefix}${truncation.content || "(no output)"}${boundedSuffix}${NOTICE_SEPARATOR}${notice}`;
  return { text: enforceFinalLimit(text), truncation };
}

/**
 * Bounds caller-added suffix text while preserving its beginning, where schema headings and UI messages are introduced.
 */
function boundSuffix(suffix: string, prefix: string, notice: string): string {
  if (!suffix) {
    return "";
  }

  const fixedBytes = Buffer.byteLength(`${prefix}${NOTICE_SEPARATOR}${notice}`, "utf-8");
  const fixedLines = countNewlines(`${prefix}${NOTICE_SEPARATOR}${notice}`) + 1;
  const maxBytes = Math.max(0, DEFAULT_MAX_BYTES - fixedBytes - MIN_PREVIEW_BYTES - Buffer.byteLength(TRUNCATED_SUFFIX_NOTICE, "utf-8"));
  const maxLines = Math.max(0, DEFAULT_MAX_LINES - fixedLines - MIN_PREVIEW_LINES - countNewlines(TRUNCATED_SUFFIX_NOTICE));
  return truncateHeadWithNotice(suffix, maxBytes, maxLines);
}

/**
 * Keeps the start of generated suffix text and marks when the rest was removed for the output budget.
 */
function truncateHeadWithNotice(text: string, maxBytes: number, maxLines: number): string {
  const stats = getTextStats(text);
  if (stats.bytes <= maxBytes && stats.lines <= maxLines) {
    return text;
  }

  const availableBytes = Math.max(0, maxBytes);
  const availableLines = Math.max(0, maxLines);
  const lines = text.split("\n");
  const output: string[] = [];
  let bytes = 0;

  for (const [index, line] of lines.entries()) {
    if (output.length >= availableLines) {
      break;
    }
    const lineBytes = Buffer.byteLength(line, "utf-8") + (index > 0 ? 1 : 0);
    if (bytes + lineBytes > availableBytes) {
      break;
    }
    output.push(line);
    bytes += lineBytes;
  }

  return `${output.join("\n")}${TRUNCATED_SUFFIX_NOTICE}`;
}

/**
 * Truncates text from the tail by line count and byte count, matching Pi's bash output behavior.
 */
function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (!options.forceTruncated && totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
    };
  }

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;

  for (let index = lines.length - 1; index >= 0 && outputLines.length < maxLines; index--) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLines.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLines.length === 0 && maxBytes > 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLines.unshift(truncatedLine);
        outputBytes = Buffer.byteLength(truncatedLine, "utf-8");
        lastLinePartial = true;
      }
      break;
    }

    outputLines.unshift(line);
    outputBytes += lineBytes;
  }

  if (outputLines.length >= maxLines && outputBytes <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLines.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
    lastLinePartial,
  };
}

/**
 * Keeps the end of a UTF-8 string without cutting a multibyte character in the middle.
 */
function truncateStringToBytesFromEnd(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf-8");
  if (buffer.length <= maxBytes) {
    return value;
  }

  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start++;
  }

  return buffer.subarray(start).toString("utf-8");
}

/**
 * Enforces the final hard limit if dynamic path length or suffix truncation still leaves a few extra bytes.
 */
function enforceFinalLimit(text: string): string {
  const stats = getTextStats(text);
  if (stats.bytes <= DEFAULT_MAX_BYTES && stats.lines <= DEFAULT_MAX_LINES) {
    return text;
  }

  return truncateTail(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, forceTruncated: true }).content;
}

/**
 * Counts newline characters because final line count equals preview lines plus inserted newline count.
 */
function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

/**
 * Formats the model-facing notice that tells the user where to read the full MCP output.
 */
function formatTruncationNotice(truncation: TruncationResult, fullOutputPath: string | undefined, writeError: string | undefined): string {
  if (!fullOutputPath) {
    return `[Output truncated. Full output could not be saved: ${writeError ?? "unknown error"}]`;
  }

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    const readHint = `\n[Read first bytes: bash head -c ${DEFAULT_MAX_BYTES} ${fullOutputPath}]`;
    return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}. Full output: ${fullOutputPath}]${readHint}`;
  }
  if (truncation.truncatedBy === "lines") {
    return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  }
  return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
}

/**
 * Formats byte counts in the same compact style as Pi's standard tools.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
