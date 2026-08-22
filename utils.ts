import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import type { McpConfig, ServerEntry } from "./types.ts";

async function execOpen(pi: ExtensionAPI, target: string, browser?: string, signal?: AbortSignal) {
  const os = platform();

  if (os === "darwin") {
    if (browser) {
      // An absolute executable path (e.g. from $BROWSER) names a launcher
      // binary. App bundles still go through `open -a`, which handles them.
      return isAbsolute(browser) && extname(browser).toLowerCase() !== ".app"
        ? pi.exec(browser, [target], signal ? { signal } : {})
        : pi.exec("open", ["-a", browser, target], signal ? { signal } : {});
    }
    return pi.exec("open", [target], signal ? { signal } : {});
  }
  if (os === "win32") {
    return browser
      ? pi.exec("cmd", ["/c", "start", "", browser, target], signal ? { signal } : {})
      : pi.exec("cmd", ["/c", "start", "", target], signal ? { signal } : {});
  }
  return browser
    ? pi.exec(browser, [target], signal ? { signal } : {})
    : pi.exec("xdg-open", [target], signal ? { signal } : {});
}

export async function openUrl(pi: ExtensionAPI, url: string, browser?: string, signal?: AbortSignal): Promise<void> {
  const result = await execOpen(pi, url, browser, signal);
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
  const iterator = items.entries();

  async function worker() {
    while (true) {
      const next = iterator.next();
      if (next.done) return;
      const [index, item] = next.value;
      results[index] = await fn(item);
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

export function interpolateEnvVars(value: string): string;
export function interpolateEnvVars(value: string, environment: NodeJS.ProcessEnv): string;
export function interpolateEnvVars(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name) => environment[name] ?? "")
    .replace(/\$env:(\w+)/g, (_, name) => environment[name] ?? "")
    .replace(/\{env:(\w+)\}/g, (_, name) => environment[name] ?? "");
}

function getMissingEnvVars(value: string, environment: NodeJS.ProcessEnv): string[] {
  const missing = new Set<string>();
  for (const match of value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name && environment[name] === undefined) {
      missing.add(name);
    }
  }
  return [...missing];
}

export function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function interpolateSecretExpression(value: string, environment: NodeJS.ProcessEnv): string {
  if (value.startsWith("!!")) return interpolateEnvVars(value.slice(1), environment);
  return value.startsWith("!") ? value : interpolateEnvVars(value, environment);
}

export function interpolateEnvRecord(values: Record<string, string> | undefined, environment: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (!values) return undefined;

  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    interpolateSecretExpression(value, environment),
  ]));
}

const COMMAND_SECRET_TIMEOUT_MS = 10_000;
const COMMAND_SECRET_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Resolve a secret value, executing only a single leading `!` command marker. */
export function resolveCommandSecret(value: string, context: string): string;
export function resolveCommandSecret(value: undefined, context: string): undefined;
export function resolveCommandSecret(value: string | undefined, context: string): string | undefined;
export function resolveCommandSecret(value: string | undefined, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("!!")) return interpolateEnvVars(value.slice(1));
  if (!value.startsWith("!")) return interpolateEnvVars(value);

  const result = spawnSync(value.slice(1), {
    shell: true,
    encoding: "utf8",
    timeout: COMMAND_SECRET_TIMEOUT_MS,
    maxBuffer: COMMAND_SECRET_MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const reason = code === "ETIMEDOUT"
      ? "command timed out after 10 seconds"
      : code === "ENOBUFS"
        ? "command output exceeded 1 MiB"
        : "command failed to start";
    throw new Error(`Failed to resolve ${context}: ${reason}`);
  }
  if (result.status !== 0) {
    throw new Error(`Failed to resolve ${context}: command exited with code ${result.status ?? "unknown"}`);
  }

  const resolved = result.stdout.trim();
  if (!resolved) throw new Error(`Failed to resolve ${context}: command returned empty output`);
  return resolved;
}

/** Resolve command markers in a configured record without mutating the input. */
export function resolveCommandSecretsRecord(
  values: Record<string, string> | undefined,
  context: (key: string) => string,
): Record<string, string> | undefined {
  if (!values) return undefined;

  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    resolveCommandSecret(value, context(key)),
  ]));
}

export function resolveServerUrl(definition: Pick<ServerEntry, "url">, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (definition.url == null) return undefined;
  if (typeof definition.url !== "string") {
    throw new Error("MCP server URL must be a string");
  }

  const missing = getMissingEnvVars(definition.url, environment);
  if (missing.length > 0) {
    throw new Error(`Missing environment variable${missing.length === 1 ? "" : "s"} in MCP server URL: ${missing.join(", ")}`);
  }

  const resolved = interpolateEnvVars(definition.url, environment);
  try {
    new URL(resolved);
  } catch (error) {
    throw new Error(`Invalid MCP server URL after environment interpolation: ${resolved}`, { cause: error });
  }
  return resolved;
}

export function resolveConfigPath(value: string | undefined, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (value === undefined) return undefined;

  const resolved = interpolateEnvVars(value, environment);
  if (resolved === "~") return homedir();
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return join(homedir(), resolved.slice(2));
  }
  return resolved;
}

export function resolveBearerToken(definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (definition.bearerToken !== undefined) {
    return interpolateSecretExpression(definition.bearerToken, environment);
  }
  return definition.bearerTokenEnv ? environment[definition.bearerTokenEnv] : undefined;
}

/** Remove OSC control strings, including payloads that have no terminator. */
export function stripOscSequences(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const isEscOsc = text.charCodeAt(index) === 0x1b && text[index + 1] === "]";
    const isC1Osc = text.charCodeAt(index) === 0x9d;
    if (!isEscOsc && !isC1Osc) {
      result += text[index++];
      continue;
    }

    index += isEscOsc ? 2 : 1;
    while (index < text.length) {
      const code = text.charCodeAt(index++);
      if (code === 0x07 || code === 0x9c) break;
      if (code === 0x1b && text[index] === "\\") {
        index++;
        break;
      }
    }
  }
  return result;
}

export function sanitizeTerminalText(text: string): string {
  return stripOscSequences(text)
    .replace(/(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatTerminalError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const collect = (value: unknown) => {
    if (seen.has(value)) return;
    if ((typeof value === "object" && value !== null) || typeof value === "function") seen.add(value);

    if (value instanceof AggregateError) {
      const countBefore = messages.length;
      for (const nested of value.errors) collect(nested);
      if (value.cause !== undefined) collect(value.cause);
      if (messages.length === countBefore && value.message) messages.push(value.message);
      return;
    }
    if (value instanceof Error) {
      if (value.message) messages.push(value.message);
      if (value.cause !== undefined) collect(value.cause);
      return;
    }
    messages.push(String(value));
  };

  collect(error);
  return sanitizeTerminalText([...new Set(messages)].join(": "));
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

export function normalizeDirectToolInputSchema(schema: unknown): Record<string, unknown> {
  const inputSchema = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : { type: "object", properties: {} };
  const { $schema, additionalProperties, ...normalized } = inputSchema;
  return normalized;
}

export function normalizeToolArguments(
  value: unknown,
  context = "tool arguments",
): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {};

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `${context}: invalid args JSON (${error instanceof SyntaxError ? error.message : String(error)}); ` +
        `pass args as a JSON object, or as a valid JSON string encoding one`,
        { cause: error },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `${context}: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
      );
    }
    return parsed as Record<string, unknown>;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${context}: expected a JSON object, got ${Array.isArray(value) ? "array" : typeof value}`,
    );
  }

  assertJsonSerializable(value, context);
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${context}: value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function assertJsonSerializable(value: unknown, context: string, path = ""): void {
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${context}: value at ${path || "root"} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJsonSerializable(item, context, `${path}[${index}]`);
    return;
  }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error(`${context}: value at ${path || "root"} is not a plain JSON object`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${context}: value at ${path || "root"} has symbol keys`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonSerializable(item, context, path ? `${path}.${key}` : key);
    }
    return;
  }
  throw new Error(`${context}: value at ${path || "root"} is not JSON-serializable`);
}

export function formatAuthRequiredMessage(
  config: Pick<McpConfig, "settings">,
  serverName: string,
  defaultMessage: string,
): string {
  const template = config.settings?.authRequiredMessage;
  return template ? template.replaceAll("${server}", serverName) : defaultMessage;
}

export function formatMcpStatus(config: Pick<McpConfig, "settings">, message: string): string | undefined {
  if (config.settings?.mcpFooterStatus === "off") return undefined;
  return `${config.settings?.showStatusIcon === false ? "MCP: " : "🔌 MCP: "}${message}`;
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
