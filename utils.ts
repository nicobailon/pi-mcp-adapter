import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir, platform } from "node:os";

export async function openUrl(pi: ExtensionAPI, url: string, browser?: string): Promise<void> {
  const os = platform();
  let result;

  if (os === "darwin") {
    result = browser ? await pi.exec("open", ["-a", browser, url]) : await pi.exec("open", [url]);
  } else if (os === "win32") {
    result = browser
      ? await pi.exec("cmd", ["/c", "start", "", browser, url])
      : await pi.exec("cmd", ["/c", "start", "", url]);
  } else {
    result = browser ? await pi.exec(browser, [url]) : await pi.exec("xdg-open", [url]);
  }

  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
  }
}

export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array(Math.min(limit, items.length)).fill(null).map(() => worker());
  await Promise.all(workers);
  return results;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}${path.slice(1)}`;
  return path;
}

export function parseConfigFlag(flag: unknown): string[] | undefined {
  if (typeof flag !== "string") return undefined;

  const path = flag.trim();
  if (!path) return undefined;

  return [expandHome(path)];
}

export function getConfigPathsFromArgv(): string[] | undefined {
  const paths: string[] = [];

  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--mcp-config") continue;

    for (let j = i + 1; j < process.argv.length; j++) {
      const value = process.argv[j];
      if (value.startsWith("--")) {
        i = j - 1;
        break;
      }
      paths.push(expandHome(value));
      i = j;
    }
  }

  return paths.length > 0 ? paths : undefined;
}

export function getConfigPathFromArgv(): string | undefined {
  return getConfigPathsFromArgv()?.[0];
}

export function truncateAtWord(text: string, target: number): string {
  if (!text || text.length <= target) return text;

  const truncated = text.slice(0, target);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > target * 0.6) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated + "...";
}

/**
 * Extract the adapter-owned UI stream mode from tool metadata.
 */
export function extractToolUiStreamMode(toolMeta: Record<string, unknown> | undefined): "eager" | "stream-first" | undefined {
  const uiMeta = toolMeta?.ui;
  if (!uiMeta || typeof uiMeta !== "object") return undefined;
  const streamMode = (uiMeta as Record<string, unknown>)["pi-mcp-adapter.streamMode"];
  if (streamMode === "eager" || streamMode === "stream-first") {
    return streamMode;
  }
  return undefined;
}
