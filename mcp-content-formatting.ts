import type { ContentBlock } from "./types.js";

const TERMINAL_SEQUENCE_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;
const SAFE_MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;
const DEFAULT_IMAGE_MIME_TYPE = "image/*";

/**
 * Format byte counts in the compact style used in Pi tool output notices.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format image content as metadata so terminal and model-facing text do not copy base64 payloads.
 */
export function formatImagePlaceholder(block: ContentBlock): string {
  const data = "data" in block && typeof block.data === "string" ? block.data : "";
  const mimeType = "mimeType" in block && typeof block.mimeType === "string" ? sanitizeMimeType(block.mimeType) : DEFAULT_IMAGE_MIME_TYPE;
  return `[Image content: ${mimeType}, ${formatSize(Buffer.byteLength(data, "utf-8"))} base64 payload omitted]`;
}

/**
 * Keep only short MIME labels that cannot carry terminal control sequences or unbounded metadata.
 */
export function sanitizeMimeType(value: string, fallback = DEFAULT_IMAGE_MIME_TYPE): string {
  if (hasTerminalSequence(value)) {
    return fallback;
  }

  const normalized = sanitizeMetadataText(value).trim();
  if (!SAFE_MIME_TYPE_PATTERN.test(normalized)) {
    return fallback;
  }
  return normalized;
}

/**
 * Reject MIME labels that contained terminal escape sequences before sanitization.
 */
function hasTerminalSequence(text: string): boolean {
  TERMINAL_SEQUENCE_PATTERN.lastIndex = 0;
  return TERMINAL_SEQUENCE_PATTERN.test(text);
}

/**
 * Remove terminal control sequences from metadata before it can reach text output or details.
 */
function sanitizeMetadataText(text: string): string {
  return Array.from(text.replace(TERMINAL_SEQUENCE_PATTERN, "").replace(/\r/g, ""))
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) {
        return false;
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
