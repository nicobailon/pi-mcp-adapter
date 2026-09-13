import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import type { McpConfig, ServerEntry } from "./types.ts";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const PLUGIN_MANIFEST_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);
const MCP_CONFIG_FIELDS = new Set(["$schema", "mcpServers"]);
const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const HTTP_FIELDS = new Set(["type", "url", "headers"]);

interface AgentPluginManifest {
  name: string;
}

export interface AgentPluginSummary {
  path: string;
  name?: string;
  serverCount: number;
}

export function loadAgentPluginConfigs(paths: unknown, cwd = process.cwd()): McpConfig {
  const mcpServers: Record<string, ServerEntry> = {};
  for (const pluginPath of getPluginPaths(paths)) {
    const loaded = loadAgentPluginMcpConfig(pluginPath, cwd);
    if (!loaded) continue;
    for (const [serverName, server] of Object.entries(loaded.mcpServers)) {
      if (mcpServers[serverName]) {
        console.warn(`Agent Plugin at ${resolvePluginPath(pluginPath, cwd)} skips duplicate normalized MCP server ${serverName}`);
        continue;
      }
      mcpServers[serverName] = server;
    }
  }
  return { mcpServers };
}

export function getAgentPluginSummaries(paths: unknown, cwd = process.cwd()): AgentPluginSummary[] {
  return getPluginPaths(paths).map(path => {
    const pluginRoot = resolvePluginPath(path, cwd);
    const loaded = loadAgentPluginMcpConfig(path, cwd);
    const manifest = loaded ? readPluginManifest(pluginRoot, false) : null;
    return {
      path: pluginRoot,
      ...(manifest?.name ? { name: manifest.name } : {}),
      serverCount: loaded ? Object.keys(loaded.mcpServers).length : 0,
    };
  });
}

function getPluginPaths(paths: unknown): string[] {
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
}

function loadAgentPluginMcpConfig(path: string, cwd: string): McpConfig | null {
  const pluginRoot = resolvePluginPath(path, cwd);
  const manifest = readPluginManifest(pluginRoot, true);
  if (!manifest) return null;

  const mcpPath = resolve(pluginRoot, "mcp.json");
  if (!existsSync(mcpPath)) return { mcpServers: {} };
  if (!statSync(mcpPath).isFile()) {
    console.warn(`Agent Plugin ${manifest.name} has invalid MCP config: mcp.json is not a regular file`);
    return { mcpServers: {} };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(mcpPath, "utf8"));
  } catch (error) {
    console.warn(`Agent Plugin ${manifest.name} has invalid MCP config: failed to parse mcp.json`, error);
    return { mcpServers: {} };
  }

  return translateAgentPluginMcpConfig(raw, manifest, pluginRoot);
}

function readPluginManifest(pluginRoot: string, report: boolean): AgentPluginManifest | null {
  const manifestPath = resolve(pluginRoot, "plugin.json");
  if (!existsSync(manifestPath)) {
    if (report) console.warn(`Agent Plugin at ${pluginRoot} is invalid: missing plugin.json`);
    return null;
  }
  if (!statSync(manifestPath).isFile()) {
    if (report) console.warn(`Agent Plugin at ${pluginRoot} is invalid: plugin.json is not a regular file`);
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if (report) console.warn(`Agent Plugin at ${pluginRoot} is invalid: failed to parse plugin.json`, error);
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (report) console.warn(`Agent Plugin at ${pluginRoot} is invalid: plugin.json must be an object`);
    return null;
  }

  const manifest = raw as Record<string, unknown>;
  for (const key of Object.keys(manifest)) {
    if (!PLUGIN_MANIFEST_FIELDS.has(key) && report) {
      console.warn(`Agent Plugin at ${pluginRoot} ignores unknown plugin.json field: ${key}`);
    }
  }
  if (manifest.$schema !== PLUGIN_SCHEMA) {
    if (report) console.warn(`Agent Plugin at ${pluginRoot} is invalid: unsupported plugin.json $schema`);
    return null;
  }
  if (typeof manifest.name !== "string" || manifest.name.length < 1 || manifest.name.length > 64 || !PLUGIN_NAME_PATTERN.test(manifest.name)) {
    if (report) console.warn(`Agent Plugin at ${pluginRoot} is invalid: plugin.json name is invalid`);
    return null;
  }
  if (manifest.extensions !== undefined && (!manifest.extensions || typeof manifest.extensions !== "object" || Array.isArray(manifest.extensions))) {
    if (report) console.warn(`Agent Plugin ${manifest.name} ignores non-object plugin.json extensions`);
  }

  return { name: manifest.name };
}

function translateAgentPluginMcpConfig(raw: unknown, manifest: AgentPluginManifest, pluginRoot: string): McpConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`Agent Plugin ${manifest.name} has invalid MCP config: mcp.json must be an object`);
    return { mcpServers: {} };
  }

  const mcpConfig = raw as Record<string, unknown>;
  for (const key of Object.keys(mcpConfig)) {
    if (!MCP_CONFIG_FIELDS.has(key)) {
      console.warn(`Agent Plugin ${manifest.name} has invalid MCP config: unknown top-level field ${key}`);
      return { mcpServers: {} };
    }
  }
  if (mcpConfig.$schema !== MCP_SCHEMA) {
    console.warn(`Agent Plugin ${manifest.name} has invalid MCP config: unsupported mcp.json $schema`);
    return { mcpServers: {} };
  }
  if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== "object" || Array.isArray(mcpConfig.mcpServers)) {
    console.warn(`Agent Plugin ${manifest.name} has invalid MCP config: mcpServers must be an object`);
    return { mcpServers: {} };
  }

  const mcpServers: Record<string, ServerEntry> = {};
  for (const [serverName, entry] of Object.entries(mcpConfig.mcpServers)) {
    const translated = translateAgentPluginServer(manifest, pluginRoot, serverName, entry);
    if (!translated) continue;

    const normalizedName = formatAgentPluginServerName(manifest.name, serverName);
    if (mcpServers[normalizedName]) {
      console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: normalized server name ${normalizedName} already exists`);
      continue;
    }
    mcpServers[normalizedName] = translated;
  }
  return { mcpServers };
}

function translateAgentPluginServer(
  manifest: AgentPluginManifest,
  pluginRoot: string,
  serverName: string,
  entry: unknown,
): ServerEntry | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: entry must be an object`);
    return null;
  }

  const raw = entry as Record<string, unknown>;
  if (raw.type === "stdio") return translateStdioServer(manifest, pluginRoot, serverName, raw);
  if (raw.type === "streamable-http" || raw.type === "sse") return translateHttpServer(manifest, serverName, raw, raw.type);

  console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: unsupported type`);
  return null;
}

function translateStdioServer(
  manifest: AgentPluginManifest,
  pluginRoot: string,
  serverName: string,
  raw: Record<string, unknown>,
): ServerEntry | null {
  for (const key of Object.keys(raw)) {
    if (!STDIO_FIELDS.has(key)) return skipServer(manifest, serverName, `unknown field ${key}`);
  }
  if (typeof raw.command !== "string" || raw.command.length === 0) return skipServer(manifest, serverName, "command must be a non-empty string");
  if (!isBareCommand(raw.command) && !raw.command.startsWith("./")) return skipServer(manifest, serverName, "command must be bare or plugin-relative");

  const args = translateStringArray(raw.args, manifest, serverName, "args");
  if (args === null) return null;
  const env = translateEnv(raw.env, manifest, serverName);
  if (env === null) return null;

  const command = raw.command.startsWith("./") ? resolveContainedPath(pluginRoot, raw.command, pluginRoot) : raw.command;
  if (command === null) return skipServer(manifest, serverName, "command must stay inside the plugin directory");

  const pluginDataDir = getAgentPath("agent-plugin-data", manifest.name);
  const cwd = resolvePluginCwd(raw.cwd, pluginRoot, pluginDataDir);
  if (cwd === null) return skipServer(manifest, serverName, "cwd must be plugin-relative, PLUGIN_ROOT-rooted, or PLUGIN_DATA-rooted");

  return {
    command,
    args: args.map(value => expandPluginPlaceholders(value, pluginRoot, pluginDataDir)),
    env: {
      ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, expandPluginPlaceholders(value, pluginRoot, pluginDataDir)])),
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: pluginDataDir,
    },
    cwd,
    pluginDataDir,
    literalEnv: true,
  };
}

function translateHttpServer(
  manifest: AgentPluginManifest,
  serverName: string,
  raw: Record<string, unknown>,
  type: "streamable-http" | "sse",
): ServerEntry | null {
  for (const key of Object.keys(raw)) {
    if (!HTTP_FIELDS.has(key)) return skipServer(manifest, serverName, `unknown field ${key}`);
  }
  if (typeof raw.url !== "string" || raw.url.length === 0) return skipServer(manifest, serverName, "url must be a non-empty string");
  if (!isValidAgentPluginUrl(raw.url)) return skipServer(manifest, serverName, "url must be an allowed absolute HTTP(S) URL");
  const headers = translateHeaders(raw.headers, manifest, serverName);
  if (headers === null) return null;

  return {
    url: raw.url,
    httpTransport: type,
    ...(headers ? { headers } : {}),
  };
}

function formatAgentPluginServerName(pluginName: string, serverName: string): string {
  const pluginPart = pluginName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "plugin";
  const serverPart = serverName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "server";
  return `${pluginPart}__${serverPart}`;
}

function skipServer(manifest: AgentPluginManifest, serverName: string, reason: string): null {
  console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: ${reason}`);
  return null;
}

function translateStringArray(value: unknown, manifest: AgentPluginManifest, serverName: string, field: string): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: ${field} must be an array of strings`);
    return null;
  }
  return value;
}

function translateEnv(value: unknown, manifest: AgentPluginManifest, serverName: string): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: env must be an object of strings`);
    return null;
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") {
      console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: env must not define ${key}`);
      return null;
    }
    if (typeof entry !== "string") {
      console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: env values must be strings`);
      return null;
    }
    env[key] = entry;
  }
  return env;
}

function translateHeaders(value: unknown, manifest: AgentPluginManifest, serverName: string): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: headers must be an object of strings`);
    return null;
  }
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: header values must be strings`);
      return null;
    }
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) {
      console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: duplicate header ${key}`);
      return null;
    }
    seen.add(normalized);
    headers[key] = entry;
  }
  try {
    new Headers(headers);
  } catch {
    console.warn(`Agent Plugin ${manifest.name} skips invalid MCP server ${serverName}: headers are not valid HTTP fields`);
    return null;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function resolvePluginPath(path: string, cwd: string): string {
  if (path === "~") return resolve(process.env.HOME ?? "", ".");
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? "", path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function isBareCommand(command: string): boolean {
  return !command.includes("/") && !command.includes("\\") && !command.includes("${PLUGIN_ROOT}") && !command.includes("${PLUGIN_DATA}");
}

function resolvePluginCwd(value: unknown, pluginRoot: string, pluginDataDir: string): string | null {
  if (value === undefined) return pluginRoot;
  if (typeof value !== "string") return null;
  if (value.startsWith("./")) return resolveContainedPath(pluginRoot, value, pluginRoot);
  if (value === "${PLUGIN_ROOT}" || value.startsWith("${PLUGIN_ROOT}/")) {
    return resolveContainedPath(pluginRoot, value.replace("${PLUGIN_ROOT}", "."), pluginRoot);
  }
  if (value === "${PLUGIN_DATA}" || value.startsWith("${PLUGIN_DATA}/")) {
    return resolveContainedPath(pluginDataDir, value.replace("${PLUGIN_DATA}", "."), pluginDataDir);
  }
  return null;
}

function resolveContainedPath(root: string, value: string, containmentRoot: string): string | null {
  const resolved = resolve(root, value);
  const rel = relative(containmentRoot, resolved);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel))) return resolved;
  return null;
}

function expandPluginPlaceholders(value: string, pluginRoot: string, pluginDataDir: string): string {
  return value
    .replaceAll("${PLUGIN_ROOT}", pluginRoot)
    .replaceAll("${PLUGIN_DATA}", pluginDataDir);
}

function isValidAgentPluginUrl(value: string): boolean {
  if (value.includes("${") || value.includes("$env:") || value.includes("{env:")) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  return isLoopbackHost(url.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}
