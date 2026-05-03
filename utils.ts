import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir, platform } from "node:os";
import { join } from "node:path";
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

export function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
}

export function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values) return undefined;

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = interpolateEnvVars(value);
  }
  return resolved;
}

export function resolveBearerToken(
  bearerToken: string | undefined,
  bearerTokenEnv: string | undefined,
): string | undefined {
  const tokenFromField = bearerToken ? interpolateEnvVars(bearerToken) : undefined;
  if (tokenFromField) return tokenFromField;

  if (!bearerTokenEnv) return undefined;
  const envName = interpolateEnvVars(bearerTokenEnv);
  if (!envName) return undefined;

  return process.env[envName];
}

export function resolveConfigPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const resolved = interpolateEnvVars(value);
  if (resolved === "~") return homedir();
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return join(homedir(), resolved.slice(2));
  }
  return resolved;
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
