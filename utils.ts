import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { platform } from "node:os";
import type { McpConfig } from "./types.js";

async function execOpen(pi: ExtensionAPI, target: string, browser?: string) {
  const os = platform();

  if (os === "darwin") {
    return browser ? pi.exec("open", ["-a", browser, target]) : pi.exec("open", [target]);
  }
  if (os === "win32") {
    return browser
      ? pi.exec("cmd", ["/c", "start", "", browser, target])
      : pi.exec("cmd", ["/c", "start", "", target]);
  }
  return browser ? pi.exec(browser, [target]) : pi.exec("xdg-open", [target]);
}

export async function openUrl(pi: ExtensionAPI, url: string, browser?: string): Promise<void> {
  const result = await execOpen(pi, url, browser);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
  }
}

export async function openPath(pi: ExtensionAPI, targetPath: string): Promise<void> {
  const result = await execOpen(pi, targetPath);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to open path (exit code ${result.code})`);
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

export function getConfigPathFromArgv(): string | undefined {
  const idx = process.argv.indexOf("--mcp-config");
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
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

export function formatAuthRequiredMessage(
  config: Pick<McpConfig, "settings">,
  serverName: string,
  defaultMessage: string,
): string {
  const template = config.settings?.authRequiredMessage;
  return template ? template.replaceAll("${server}", serverName) : defaultMessage;
}

export function getToolRequestTimeoutMs(config: McpConfig | undefined, serverName: string): number | undefined {
  const serverTimeout = config?.mcpServers[serverName]?.toolTimeoutMs;
  if (typeof serverTimeout === "number") return serverTimeout;

  const globalTimeout = config?.settings?.toolTimeoutMs;
  return typeof globalTimeout === "number" ? globalTimeout : undefined;
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
