// config.ts - Config loading with import support
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import stripJsonComments from "strip-json-comments";
import { getAgentPath, getConfigDirName } from "./agent-dir.ts";
import { getAgentPluginSummaries, loadAgentPluginConfigs, type AgentPluginSummary } from "./agent-plugin-loader.ts";
import { isServerDisabled, type HostConfigDiscovery, type McpConfig, type ServerEntry, type McpSettings, type ImportKind, type ServerProvenance } from "./types.ts";
import { toStringRecord } from "./utils.ts";

const GENERIC_GLOBAL_CONFIG_PATH = join(homedir(), ".config", "mcp", "mcp.json");
const AGENTS_GLOBAL_CONFIG_PATHS = [
  join(homedir(), ".agents", "mcp.json"),
  join(homedir(), ".agents", "mcp", "mcp.json"),
] as const;
const PROJECT_CONFIG_NAME = ".mcp.json";
const PROJECT_PI_CONFIG_NAME = "mcp.json";
const REPOPROMPT_BINARY_CANDIDATES = [
  join(homedir(), "RepoPrompt", "repoprompt_cli"),
  "/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp",
];

export interface KnownServerPreset {
  id: string;
  name: string;
  summary: string;
  entry: ServerEntry;
}

export const KNOWN_SERVER_PRESETS: readonly KnownServerPreset[] = [
  {
    id: "deepwiki",
    name: "DeepWiki",
    summary: "Ask questions about public GitHub repositories.",
    entry: { url: "https://mcp.deepwiki.com/mcp", protocolVersion: "auto" },
  },
  {
    id: "context7",
    name: "Context7",
    summary: "Look up current library documentation and examples.",
    entry: { url: "https://mcp.context7.com/mcp", protocolVersion: "auto" },
  },
  {
    id: "notion",
    name: "Notion",
    summary: "Search and work with your Notion workspace.",
    entry: { url: "https://mcp.notion.com/mcp", auth: "oauth", protocolVersion: "auto" },
  },
  {
    id: "github",
    name: "GitHub",
    summary: "Work with GitHub through your Copilot account.",
    entry: { url: "https://api.githubcopilot.com/mcp", auth: "oauth", protocolVersion: "auto" },
  },
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    summary: "Inspect and automate a local Chrome browser.",
    entry: { command: "npx", args: ["-y", "chrome-devtools-mcp@1.6.0"] },
  },
];

const IMPORT_PATHS: Record<ImportKind, string[]> = {
  cursor: [join(homedir(), ".cursor", "mcp.json")],
  "claude-code": [
    join(homedir(), ".claude", "mcp.json"),
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude", "claude_desktop_config.json"),
  ],
  "claude-desktop": [join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
  codex: [
    join(homedir(), ".codex", "config.toml"),
    join(homedir(), ".codex", "config.json"),
  ],
  opencode: [
    join(homedir(), ".config", "opencode", "opencode.json"),
    "./opencode.json",
  ],
  windsurf: [join(homedir(), ".windsurf", "mcp.json")],
  vscode: [".vscode/mcp.json"],
};

interface ConfigSourceSpec {
  id: "shared-global" | "agents-global" | "agents-nested-global" | "pi-global" | "shared-project" | "pi-project";
  label: string;
  readPath: string;
  writePath: string;
  kind: "user" | "project" | "import";
  importKind?: string;
  shared: boolean;
  scope: "global" | "project";
}

export interface ConfigDiscoveryPath {
  label: string;
  path: string;
  exists: boolean;
}

export interface DiscoveredImportConfig {
  kind: ImportKind;
  path: string;
}

export interface ConfigDiscoverySource extends ConfigDiscoveryPath {
  id: ConfigSourceSpec["id"];
  scope: ConfigSourceSpec["scope"];
  kind: "shared" | "pi";
  serverCount: number;
}

export interface ImportConfigSummary extends DiscoveredImportConfig {
  serverCount: number;
}

export interface HostConfigSummary extends ImportConfigSummary {
  active: boolean;
}

export interface McpConfigConflict {
  serverName: string;
  sources: Array<{ kind: "shared" | "pi" | "host"; path: string }>;
  winner: { kind: "shared" | "pi" | "host"; path: string };
}

export interface RepoPromptDiscovery {
  configured: boolean;
  configuredPath?: string;
  executablePath?: string;
  targetPath?: string;
  serverName?: string;
  entry?: ServerEntry;
}

export interface McpDiscoverySummary {
  sources: ConfigDiscoverySource[];
  imports: ImportConfigSummary[];
  hostConfigs: HostConfigSummary[];
  hostConfigDiscovery: HostConfigDiscovery;
  agentPlugins: AgentPluginSummary[];
  conflicts: McpConfigConflict[];
  hasAnyConfig: boolean;
  hasAnyDetectedPaths: boolean;
  hasSharedServers: boolean;
  hasPiOwnedServers: boolean;
  totalServerCount: number;
  fingerprint: string;
  repoPrompt: RepoPromptDiscovery;
}

export interface McpStandardConfigSummary {
  sources: ConfigDiscoverySource[];
  hasSharedServers: boolean;
  fingerprint: string;
}

export interface ConfigWritePreview {
  path: string;
  existed: boolean;
  changed: boolean;
  beforeText: string;
  afterText: string;
  diffText: string;
}

export function getPiGlobalConfigPath(overridePath?: string): string {
  return overridePath ? resolve(overridePath) : getAgentPath("mcp.json");
}

export function getGenericGlobalConfigPath(): string {
  return GENERIC_GLOBAL_CONFIG_PATH;
}

export function getProjectConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, PROJECT_CONFIG_NAME);
}

export function getProjectPiConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, getConfigDirName(), PROJECT_PI_CONFIG_NAME);
}

export function getConfigDiscoveryPaths(overridePath?: string, cwd = process.cwd()): ConfigDiscoveryPath[] {
  return getConfigSources(overridePath, cwd).map((source) => ({
    label: source.label,
    path: source.readPath,
    exists: existsSync(source.readPath),
  }));
}

export function findAvailableImportConfigs(cwd = process.cwd()): DiscoveredImportConfig[] {
  const discovered: DiscoveredImportConfig[] = [];

  for (const importKind of Object.keys(IMPORT_PATHS) as ImportKind[]) {
    const importPath = resolveImportPath(importKind, cwd);
    if (importPath) {
      discovered.push({ kind: importKind, path: importPath });
    }
  }

  return discovered;
}

function getConfigSourceSummaries(sourceSpecs: ConfigSourceSpec[]): ConfigDiscoverySource[] {
  return sourceSpecs.map((source) => {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    return {
      id: source.id,
      label: source.label,
      path: source.readPath,
      exists: existsSync(source.readPath),
      scope: source.scope,
      kind: source.shared ? "shared" : "pi",
      serverCount: loaded ? Object.keys(loaded.mcpServers).length : 0,
    } satisfies ConfigDiscoverySource;
  });
}

export function getMcpStandardConfigSummary(overridePath?: string, cwd = process.cwd()): McpStandardConfigSummary {
  const sources = getConfigSourceSummaries(getConfigSources(overridePath, cwd));
  return {
    sources,
    hasSharedServers: sources.some((source) => source.kind === "shared" && source.serverCount > 0),
    fingerprint: JSON.stringify({ sources: sources.map((source) => [source.id, source.exists, source.serverCount]) }),
  };
}

export function getMcpDiscoverySummary(
  overridePath?: string,
  cwd = process.cwd(),
  options: { includeHostConfigs?: boolean } = {},
): McpDiscoverySummary {
  const sourceSpecs = getConfigSources(overridePath, cwd);
  const sources = getConfigSourceSummaries(sourceSpecs);
  const includeHostConfigs = options.includeHostConfigs !== false;

  const imports = includeHostConfigs
    ? (Object.keys(IMPORT_PATHS) as ImportKind[])
      .map((kind) => {
        const imported = loadImportedConfig(kind, cwd, `Failed to inspect imported MCP config from ${kind}:`);
        if (!imported) return null;
        return {
          kind,
          path: imported.path,
          serverCount: Object.keys(extractServers(imported.value, kind)).length,
        } satisfies ImportConfigSummary;
      })
      .filter((value): value is ImportConfigSummary => value !== null)
    : [];
  const hostConfigDiscovery = getConfiguredHostConfigDiscovery(overridePath, cwd);
  const hostConfigs = imports.map((entry) => ({ ...entry, active: hostConfigDiscovery === "on" }));
  const settings = getMergedSettings(overridePath, cwd);
  const agentPlugins = getAgentPluginSummaries(settings?.agentPluginPaths, cwd);
  const totalServerCount = sources.reduce((sum, source) => sum + source.serverCount, 0) + agentPlugins.reduce((sum, plugin) => sum + plugin.serverCount, 0);
  const hasSharedServers = sources.some((source) => source.kind === "shared" && source.serverCount > 0) || agentPlugins.some(plugin => plugin.serverCount > 0);
  const hasPiOwnedServers = sources.some((source) => source.kind === "pi" && source.serverCount > 0);
  const hasAnyDetectedPaths = sources.some((source) => source.exists) || imports.length > 0 || agentPlugins.length > 0;
  const hasAnyConfig = totalServerCount > 0 || imports.some((entry) => entry.serverCount > 0) || hasAnyDetectedPaths;

  const summaryWithoutRepoPrompt = {
    sources,
    imports,
    hostConfigs,
    hostConfigDiscovery,
    agentPlugins,
    conflicts: getConfigConflicts(sourceSpecs, imports, cwd),
    hasAnyConfig,
    hasAnyDetectedPaths,
    hasSharedServers,
    hasPiOwnedServers,
    totalServerCount,
  };

  const fingerprint = JSON.stringify({
    sources: sources.map((source) => [source.id, source.exists, source.serverCount]),
    imports: imports.map((entry) => [entry.kind, entry.path, entry.serverCount]),
    agentPlugins: agentPlugins.map((entry) => [entry.path, entry.name, entry.serverCount]),
    hostConfigDiscovery,
    conflicts: summaryWithoutRepoPrompt.conflicts,
  });

  return {
    ...summaryWithoutRepoPrompt,
    fingerprint,
    repoPrompt: detectRepoPrompt(summaryWithoutRepoPrompt, cwd),
  };
}

export function cloneMcpConfig(config: McpConfig): McpConfig {
  return structuredClone(config);
}

export function loadMcpConfig(overridePath?: string, cwd = process.cwd()): McpConfig {
  const sourceSpecs = getConfigSources(overridePath, cwd);
  const hostConfigDiscovery = getConfiguredHostConfigDiscovery(overridePath, cwd);
  // Host files are a lower-precedence fallback. This ordering means an opt-in
  // discovery cannot override a shared or Pi-owned definition, and all normal
  // URL-bound credential stripping remains in mergeServerMaps.
  let config: McpConfig = hostConfigDiscovery === "on"
    ? loadDiscoveredHostConfigs(cwd)
    : { mcpServers: {} };

  for (const source of sourceSpecs) {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (!loaded) continue;
    config = mergeConfigs(config, expandImports(loaded, cwd));
  }

  const pluginConfig = loadAgentPluginConfigs(config.settings?.agentPluginPaths, cwd);
  return mergeConfigs(pluginConfig, config);
}

function getMergedSettings(overridePath?: string, cwd = process.cwd()): McpSettings | undefined {
  let settings: McpSettings | undefined;
  for (const source of getConfigSources(overridePath, cwd)) {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (loaded?.settings) settings = { ...settings, ...loaded.settings };
  }
  return settings;
}

function getConfiguredHostConfigDiscovery(overridePath?: string, cwd = process.cwd()): HostConfigDiscovery {
  let configured: HostConfigDiscovery = "off";
  const settings = getMergedSettings(overridePath, cwd);
  const value = settings?.hostConfigDiscovery;
  if (value === "off" || value === "prompt" || value === "on") configured = value;
  return configured;
}

function loadDiscoveredHostConfigs(cwd: string): McpConfig {
  let config: McpConfig = { mcpServers: {} };
  for (const importKind of Object.keys(IMPORT_PATHS) as ImportKind[]) {
    const imported = loadImportedConfig(importKind, cwd, `Failed to discover imported MCP config from ${importKind}:`);
    if (!imported) continue;
    config = mergeConfigs(config, {
      mcpServers: extractServers(imported.value, importKind),
    });
  }
  return config;
}

function getConfigConflicts(
  sourceSpecs: ConfigSourceSpec[],
  imports: ImportConfigSummary[],
  cwd: string,
): McpConfigConflict[] {
  const seen = new Map<string, Array<{ kind: "shared" | "pi" | "host"; path: string }>>();
  const record = (name: string, source: { kind: "shared" | "pi" | "host"; path: string }): void => {
    const entries = seen.get(name) ?? [];
    if (!entries.some((entry) => entry.kind === source.kind && entry.path === source.path)) entries.push(source);
    seen.set(name, entries);
  };

  // Host candidates are listed first because, when enabled, they are the
  // lowest-precedence fallback. The fixed IMPORT_PATHS order is deterministic.
  for (const entry of imports) {
    const imported = loadImportedConfig(entry.kind, cwd, `Failed to inspect imported MCP config from ${entry.kind}:`);
    if (!imported) continue;
    for (const name of Object.keys(extractServers(imported.value, entry.kind))) {
      record(name, { kind: "host", path: imported.path });
    }
  }
  for (const source of sourceSpecs) {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (!loaded) continue;
    if (loaded.imports?.length) {
      for (const importKind of loaded.imports) {
        const imported = loadImportedConfig(importKind, cwd, `Failed to inspect imported MCP config from ${importKind}:`);
        if (!imported) continue;
        for (const name of Object.keys(extractServers(imported.value, importKind))) {
          record(name, { kind: "host", path: imported.path });
        }
      }
    }
    for (const name of Object.keys(loaded.mcpServers)) {
      record(name, {
        kind: source.shared ? "shared" : "pi",
        path: source.readPath,
      });
    }
  }

  return [...seen.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([serverName, sources]) => ({ serverName, sources, winner: sources[sources.length - 1]! }))
    .sort((left, right) => left.serverName.localeCompare(right.serverName));
}

function getConfigSources(overridePath?: string, cwd = process.cwd()): ConfigSourceSpec[] {
  const userPath = getPiGlobalConfigPath(overridePath);
  const projectPath = getProjectConfigPath(cwd);
  const projectPiPath = getProjectPiConfigPath(cwd);
  const sources: ConfigSourceSpec[] = [];

  if (GENERIC_GLOBAL_CONFIG_PATH !== userPath) {
    sources.push({
      id: "shared-global",
      label: "user-global standard MCP",
      readPath: GENERIC_GLOBAL_CONFIG_PATH,
      writePath: userPath,
      kind: "import",
      importKind: "global MCP config",
      shared: true,
      scope: "global",
    });
  }

  for (const [index, agentsPath] of AGENTS_GLOBAL_CONFIG_PATHS.entries()) {
    if (agentsPath === userPath || agentsPath === GENERIC_GLOBAL_CONFIG_PATH) continue;
    sources.push({
      id: index === 0 ? "agents-global" : "agents-nested-global",
      label: index === 0 ? "user-global .agents MCP" : "user-global .agents nested MCP",
      readPath: agentsPath,
      writePath: userPath,
      kind: "import",
      importKind: index === 0 ? ".agents MCP config" : ".agents/mcp MCP config",
      shared: true,
      scope: "global",
    });
  }

  sources.push({
    id: "pi-global",
    label: "Pi global override",
    readPath: userPath,
    writePath: userPath,
    kind: "user",
    shared: false,
    scope: "global",
  });

  if (projectPath !== userPath) {
    sources.push({
      id: "shared-project",
      label: "project standard MCP",
      readPath: projectPath,
      writePath: projectPath,
      kind: "project",
      shared: true,
      scope: "project",
    });
  }

  if (projectPiPath !== userPath && projectPiPath !== projectPath) {
    sources.push({
      id: "pi-project",
      label: "project Pi override",
      readPath: projectPiPath,
      writePath: projectPiPath,
      kind: "project",
      shared: false,
      scope: "project",
    });
  }

  return sources;
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
  const imports = mergeImports(base.imports, next.imports);
  const settings = next.settings ? { ...base.settings, ...next.settings } : base.settings;
  return {
    mcpServers: mergeServerMaps(base.mcpServers, next.mcpServers),
    ...(imports !== undefined ? { imports } : {}),
    ...(settings !== undefined ? { settings } : {}),
  };
}

// Credential-bearing fields whose value is bound to a specific server `url`.
// When a higher-precedence config source repoints an existing server at a
// different url, these MUST NOT be inherited from the lower-precedence entry —
// otherwise the original endpoint's credentials would be shipped to the new
// url. See the SECURITY note in mergeServerMaps.
const URL_BOUND_AUTH_FIELDS = ["headers", "bearerToken", "bearerTokenEnv", "requestHeadersCommand"] as const;

function mergeServerMaps(
  base: Record<string, ServerEntry>,
  next: Record<string, ServerEntry>,
): Record<string, ServerEntry> {
  const merged = { ...base };
  for (const [name, definition] of Object.entries(next)) {
    const existing = merged[name];
    // SECURITY (credential/url binding): the merge is per-field, so a
    // higher-precedence source that supplies only a new `url` for an existing
    // server would otherwise retain the lower-precedence entry's auth material
    // (Authorization header, bearer token, OAuth config) and send it to the new
    // url — a credential-exfiltration vector when the higher-precedence source
    // is less trusted than the one that first defined the server. Bind auth to
    // the url that supplied it: when the url changes, drop inherited auth
    // material before merging. Auth explicitly re-supplied by `definition` still
    // applies (it is spread last). Behaviour is unchanged when the url is
    // identical or the override omits `url` (partial overrides still inherit).
    let baseEntry: ServerEntry = existing ?? {};
    if (existing && typeof definition.socket === "string") {
      baseEntry = { ...existing };
      for (const field of [
        "command", "args", "env", "cwd", "url", "headers", "auth",
        "bearerToken", "bearerTokenEnv", "oauth",
      ] as const) {
        delete baseEntry[field];
      }
    } else if (existing?.socket && (typeof definition.command === "string" || typeof definition.url === "string")) {
      baseEntry = { ...existing };
      delete baseEntry.socket;
    }
    if (existing && typeof definition.url === "string" && definition.url !== existing.url) {
      if (baseEntry === existing) baseEntry = { ...existing };
      for (const field of URL_BOUND_AUTH_FIELDS) {
        delete baseEntry[field];
      }
      if (baseEntry.oauth !== false) {
        delete baseEntry.oauth;
      }
    }
    merged[name] = { ...baseEntry, ...definition };
  }
  return merged;
}

function mergeImports(left: ImportKind[] | undefined, right: ImportKind[] | undefined): ImportKind[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  if (merged.length === 0) return undefined;
  return [...new Set(merged)];
}

function expandImports(config: McpConfig, cwd = process.cwd()): McpConfig {
  if (!config.imports?.length) return config;

  const importedServers: Record<string, ServerEntry> = {};
  for (const importKind of config.imports) {
    const imported = loadImportedConfig(importKind, cwd, `Failed to import MCP config from ${importKind}:`);
    if (!imported) continue;

    const servers = extractServers(imported.value, importKind);
    for (const [name, definition] of Object.entries(servers)) {
      if (!importedServers[name]) {
        importedServers[name] = definition;
      }
    }
  }

  return {
    imports: config.imports,
    ...(config.settings !== undefined ? { settings: config.settings } : {}),
    mcpServers: mergeServerMaps(importedServers, config.mcpServers),
  };
}

function resolveImportCandidates(importKind: ImportKind, cwd: string): string[] {
  return (IMPORT_PATHS[importKind] ?? []).map((candidate) => {
    if (importKind === "opencode" && candidate === "./opencode.json") {
      const start = resolve(cwd);
      let gitRoot: string | undefined;
      let current = start;
      while (true) {
        if (existsSync(join(current, ".git"))) {
          gitRoot = current;
          break;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }

      if (!gitRoot) return join(start, "opencode.json");
      current = start;
      while (true) {
        const projectConfig = join(current, "opencode.json");
        if (existsSync(projectConfig) || current === gitRoot) return projectConfig;
        current = dirname(current);
      }
    }
    return candidate.startsWith(".") ? resolve(cwd, candidate) : candidate;
  });
}

function parseJsonConfig(raw: string): unknown {
  return JSON.parse(stripJsonComments(raw, { trailingCommas: true }));
}

function readImportedConfig(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  return path.endsWith(".toml") ? parseToml(raw) : parseJsonConfig(raw);
}

function loadImportedConfig(
  importKind: ImportKind,
  cwd: string,
  warningPrefix: string,
): { path: string; value: unknown } | null {
  if (importKind === "opencode") {
    let merged: Record<string, unknown> = {};
    let highestPrecedencePath: string | undefined;

    for (const path of resolveImportCandidates(importKind, cwd)) {
      if (!existsSync(path)) continue;

      try {
        const value = readImportedConfig(path);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          merged = mergeOpenCodeConfigs(merged, value as Record<string, unknown>);
          highestPrecedencePath = path;
        }
      } catch (error) {
        console.warn(warningPrefix, error);
      }
    }

    return highestPrecedencePath ? { path: highestPrecedencePath, value: merged } : null;
  }

  for (const path of resolveImportCandidates(importKind, cwd)) {
    if (!existsSync(path)) continue;

    try {
      return { path, value: readImportedConfig(path) };
    } catch (error) {
      console.warn(warningPrefix, error);
    }
  }

  return null;
}

function resolveImportPath(importKind: ImportKind, cwd = process.cwd()): string | null {
  return loadImportedConfig(importKind, cwd, `Failed to discover imported MCP config from ${importKind}:`)?.path ?? null;
}

function readValidatedConfig(path: string, label: string): McpConfig | null {
  if (!existsSync(path)) return null;

  try {
    return validateConfig(parseJsonConfig(readFileSync(path, "utf-8")));
  } catch (error) {
    console.warn(`Failed to load ${label}:`, error);
    return null;
  }
}

function validateConfig(raw: unknown): McpConfig {
  if (!isRecord(raw)) {
    return { mcpServers: {} };
  }

  return {
    mcpServers: toServerEntries(raw.mcpServers ?? raw["mcp-servers"]),
    ...(Array.isArray(raw.imports) ? { imports: raw.imports as ImportKind[] } : {}),
    ...(raw.settings !== undefined ? { settings: raw.settings as McpSettings } : {}),
  };
}

function toServerEntries(servers: unknown): Record<string, ServerEntry> {
  if (!isRecord(servers)) return {};
  const entries: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (isServerEntry(entry)) entries[name] = entry;
  }
  return entries;
}

function isServerEntry(value: unknown): value is ServerEntry {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeOpenCodeConfigs(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const baseMcp = base.mcp;
  const nextMcp = next.mcp;
  const mergedMcp: Record<string, unknown> = {
    ...(baseMcp && typeof baseMcp === "object" && !Array.isArray(baseMcp) ? baseMcp : {}),
  };

  if (nextMcp && typeof nextMcp === "object" && !Array.isArray(nextMcp)) {
    for (const [name, nextEntry] of Object.entries(nextMcp)) {
      const baseEntry = mergedMcp[name];
      if (
        baseEntry && typeof baseEntry === "object" && !Array.isArray(baseEntry)
        && nextEntry && typeof nextEntry === "object" && !Array.isArray(nextEntry)
      ) {
        const safeBase = { ...(baseEntry as Record<string, unknown>) };
        const override = nextEntry as Record<string, unknown>;
        if (typeof override.type === "string" && override.type !== safeBase.type) {
          for (const field of ["command", "environment", "cwd", "url", "headers", "oauth"]) delete safeBase[field];
        }
        if (typeof override.url === "string" && override.url !== safeBase.url) {
          delete safeBase.headers;
          delete safeBase.oauth;
        }
        if (Array.isArray(override.command)) {
          const baseCommand = safeBase.command;
          const commandChanged = !Array.isArray(baseCommand)
            || override.command.length !== baseCommand.length
            || override.command.some((value, index) => value !== baseCommand[index]);
          if (commandChanged) {
            delete safeBase.environment;
            delete safeBase.cwd;
          }
        }

        const mergedEntry = { ...safeBase, ...override };
        for (const field of ["environment", "headers", "oauth"]) {
          const baseField = safeBase[field];
          const nextField = override[field];
          if (
            baseField && typeof baseField === "object" && !Array.isArray(baseField)
            && nextField && typeof nextField === "object" && !Array.isArray(nextField)
          ) {
            mergedEntry[field] = { ...(baseField as Record<string, unknown>), ...(nextField as Record<string, unknown>) };
          }
        }
        mergedMcp[name] = mergedEntry;
      } else {
        mergedMcp[name] = nextEntry;
      }
    }
  }

  return { ...base, ...next, mcp: mergedMcp };
}

function extractServers(config: unknown, kind: ImportKind): Record<string, ServerEntry> {
  if (!config || typeof config !== "object") return {};

  const obj = config as Record<string, unknown>;

  let servers: unknown;
  switch (kind) {
    case "claude-desktop":
    case "claude-code":
      servers = obj.mcpServers;
      break;
    case "codex":
      servers = obj.mcp_servers ?? obj.mcpServers;
      break;
    case "cursor":
    case "windsurf":
    case "vscode":
      servers = obj.mcpServers ?? obj["mcp-servers"];
      break;
    case "opencode":
      servers = obj.mcp;
      break;
    default:
      return {};
  }

  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return {};
  }

  const mappedServers: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (kind === "opencode") {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const raw = entry as Record<string, unknown>;
      if (raw.enabled === false) continue;

      if (raw.type === "local" && Array.isArray(raw.command) && raw.command.length > 0 && raw.command.every((value): value is string => typeof value === "string")) {
        const env = toStringRecord(raw.environment);
        const command = raw.command[0];
        if (command === undefined) continue;
        const mapped: ServerEntry = {
          command,
          args: raw.command.slice(1),
          ...(env ? { env } : {}),
          ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
        };
        mappedServers[name] = mapped;
        continue;
      }

      if (raw.type === "remote" && typeof raw.url === "string") {
        const headers = toStringRecord(raw.headers);
        const mapped: ServerEntry = {
          url: raw.url,
          ...(headers ? { headers } : {}),
        };
        if (raw.oauth === false) {
          mapped.oauth = false;
        } else if (raw.oauth && typeof raw.oauth === "object" && !Array.isArray(raw.oauth)) {
          const oauth = raw.oauth as Record<string, unknown>;
          mapped.auth = "oauth";
          mapped.oauth = {
            ...(typeof oauth.clientId === "string" ? { clientId: oauth.clientId } : {}),
            ...(typeof oauth.clientSecret === "string" ? { clientSecret: oauth.clientSecret } : {}),
            ...(typeof oauth.scope === "string" ? { scope: oauth.scope } : {}),
            ...(typeof oauth.skipIssuerMetadataValidation === "boolean"
              ? { skipIssuerMetadataValidation: oauth.skipIssuerMetadataValidation }
              : {}),
          };
        }
        mappedServers[name] = mapped;
      }
      continue;
    }

    if (!isRecord(entry)) continue;
    if (kind !== "codex") {
      mappedServers[name] = entry;
      continue;
    }

    const mapped = { ...entry };
    const bearerTokenEnv = mapped.bearer_token_env_var;
    const httpHeaders = mapped.http_headers;
    const envHttpHeaders = mapped.env_http_headers;

    if (typeof bearerTokenEnv === "string") {
      mapped.bearerTokenEnv = bearerTokenEnv;
      if (mapped.auth === undefined) mapped.auth = "bearer";
    }
    if (httpHeaders && typeof httpHeaders === "object" && !Array.isArray(httpHeaders)) {
      mapped.headers = { ...(mapped.headers as Record<string, string> | undefined), ...(httpHeaders as Record<string, string>) };
    }
    if (envHttpHeaders && typeof envHttpHeaders === "object" && !Array.isArray(envHttpHeaders)) {
      const headers = { ...(mapped.headers as Record<string, string> | undefined) };
      for (const [header, envVar] of Object.entries(envHttpHeaders)) {
        if (typeof envVar === "string" && headers[header] === undefined) headers[header] = `$env:${envVar}`;
      }
      mapped.headers = headers;
    }

    delete mapped.bearer_token_env_var;
    delete mapped.http_headers;
    delete mapped.env_http_headers;
    mappedServers[name] = mapped as ServerEntry;
  }

  return mappedServers;
}

function serializeRawConfig(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

function buildUnifiedDiff(beforeText: string, afterText: string): string {
  if (beforeText === afterText) return "(no changes)";

  const before = beforeText.split("\n");
  const after = afterText.split("\n");
  const rows = before.length;
  const cols = after.length;
  const lcs = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const row = lcs[i];
      const nextRow = lcs[i + 1];
      if (!row || !nextRow) continue;
      row[j] = before[i] === after[j]
        ? (nextRow[j + 1] ?? 0) + 1
        : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const lines: string[] = ["--- before", "+++ after"];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    if (i < rows && j < cols && before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i++;
      j++;
      continue;
    }
    if (j < cols && (i === rows || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      lines.push(`+ ${after[j]}`);
      j++;
      continue;
    }
    if (i < rows) {
      lines.push(`- ${before[i]}`);
      i++;
    }
  }

  return lines.join("\n");
}

function buildConfigWritePreview(filePath: string, nextRaw: Record<string, unknown>): ConfigWritePreview {
  const existed = existsSync(filePath);
  const beforeRaw = readRawConfigObject(filePath);
  const beforeText = existed ? serializeRawConfig(beforeRaw) : "";
  const afterText = serializeRawConfig(nextRaw);
  return {
    path: filePath,
    existed,
    changed: beforeText !== afterText,
    beforeText,
    afterText,
    diffText: buildUnifiedDiff(beforeText, afterText),
  };
}

function readRawConfigObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};

  try {
    const raw = parseJsonConfig(readFileSync(filePath, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeRawConfigObject(filePath: string, raw: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, filePath);
}

function getServersObject(raw: Record<string, unknown>): Record<string, ServerEntry> {
  const existing = raw.mcpServers ?? raw["mcp-servers"] ?? {};
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return {};
  }
  return existing as Record<string, ServerEntry>;
}

function setServersObject(raw: Record<string, unknown>, servers: Record<string, ServerEntry>): void {
  delete raw["mcp-servers"];
  raw.mcpServers = servers;
}

export interface ServerDisabledOverrideResult {
  path: string;
  changed: boolean;
}

/**
 * Persist only the disabled field in the project Pi layer. Enabling writes an
 * explicit false only when a lower-precedence source is itself disabled; this
 * writer never copies a server definition or its credentials into the file.
 */
export function writeProjectServerDisabledOverride(
  overridePath: string | undefined,
  cwd: string,
  serverName: string,
  disabled: boolean,
): ServerDisabledOverrideResult {
  const filePath = getProjectPiConfigPath(cwd);
  let raw: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const parsed = parseJsonConfig(readFileSync(filePath, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("root value must be an object");
      }
      raw = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Failed to read project MCP override at ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  const serverKey = raw.mcpServers !== undefined ? "mcpServers" : raw["mcp-servers"] !== undefined ? "mcp-servers" : "mcpServers";
  const rawServers = raw[serverKey];
  if (rawServers !== undefined && (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers))) {
    throw new Error(`Failed to update project MCP override at ${filePath}: ${serverKey} must be an object`);
  }
  const servers = (rawServers ?? {}) as Record<string, unknown>;
  const previous = servers[serverName];
  if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous))) {
    throw new Error(`Failed to update project MCP override at ${filePath}: server "${serverName}" must be an object`);
  }
  const existing = previous as Record<string, unknown> | undefined;

  let next: Record<string, unknown>;
  if (disabled) {
    next = { ...existing, disabled: true };
  } else {
    next = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => key !== "disabled"));
    let lowerConfig: McpConfig = { mcpServers: {} };
    for (const source of getConfigSources(overridePath, cwd)) {
      if (source.readPath === filePath) continue;
      const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
      if (loaded) lowerConfig = mergeConfigs(lowerConfig, expandImports(loaded, cwd));
    }
    if (raw.imports !== undefined) {
      if (!Array.isArray(raw.imports) || raw.imports.some((kind) => typeof kind !== "string" || !Object.hasOwn(IMPORT_PATHS, kind))) {
        throw new Error(`Failed to update project MCP override at ${filePath}: imports contains an unsupported config kind`);
      }
      lowerConfig = mergeConfigs(lowerConfig, expandImports({ mcpServers: {}, imports: raw.imports as ImportKind[] }, cwd));
    }
    if (isServerDisabled(lowerConfig.mcpServers[serverName])) next.disabled = false;
  }

  if ((!existing && Object.keys(next).length === 0) || JSON.stringify(existing) === JSON.stringify(next)) {
    return { path: filePath, changed: false };
  }
  if (Object.keys(next).length === 0) delete servers[serverName];
  else servers[serverName] = next;

  raw[serverKey] = servers;
  writeRawConfigObject(filePath, raw);
  return { path: filePath, changed: true };
}

function isRepoPromptServer(name: string, entry: ServerEntry): boolean {
  const normalizedName = name.toLowerCase();
  if (normalizedName.includes("repoprompt") || normalizedName === "rp") {
    return true;
  }

  const command = entry.command?.toLowerCase() ?? "";
  if (command.includes("repoprompt") || command.includes("rp-mcp") || command.endsWith("repoprompt_cli")) {
    return true;
  }

  return (entry.args ?? []).some((arg) => typeof arg === "string" && arg.toLowerCase().includes("repoprompt"));
}

function findProjectRoot(cwd = process.cwd()): string | null {
  let current = resolve(cwd);
  while (true) {
    if (
      existsSync(join(current, ".git"))
      || existsSync(join(current, "package.json"))
      || existsSync(join(current, PROJECT_CONFIG_NAME))
      || existsSync(join(current, ".pi"))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function buildRepoPromptEntry(executablePath: string): ServerEntry {
  return {
    command: executablePath,
    args: [],
    lifecycle: "lazy",
  };
}

function detectRepoPrompt(summary: Omit<McpDiscoverySummary, "fingerprint" | "repoPrompt">, cwd = process.cwd()): RepoPromptDiscovery {
  for (const source of summary.sources) {
    if (source.kind !== "shared" || source.serverCount === 0) continue;
    const config = readValidatedConfig(source.path, `MCP config from ${source.path}`);
    if (!config) continue;
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (isRepoPromptServer(name, entry)) {
        return { configured: true, configuredPath: source.path };
      }
    }
  }

  const executablePath = REPOPROMPT_BINARY_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!executablePath) {
    return { configured: false };
  }

  const projectRoot = findProjectRoot(cwd);
  const targetPath = projectRoot ? join(projectRoot, PROJECT_CONFIG_NAME) : GENERIC_GLOBAL_CONFIG_PATH;
  return {
    configured: false,
    executablePath,
    targetPath,
    serverName: "repoprompt",
    entry: buildRepoPromptEntry(executablePath),
  };
}

export function previewCompatibilityImports(importKinds: ImportKind[], overridePath?: string): ConfigWritePreview {
  const targetPath = getPiGlobalConfigPath(overridePath);
  const raw = readRawConfigObject(targetPath);
  const currentImports = Array.isArray(raw.imports) ? raw.imports.filter((value): value is ImportKind => typeof value === "string") : [];
  const merged = [...new Set([...currentImports, ...importKinds])];
  const nextRaw = { ...raw, imports: merged };
  setServersObject(nextRaw, getServersObject(nextRaw));
  return buildConfigWritePreview(targetPath, nextRaw);
}

export function ensureCompatibilityImports(importKinds: ImportKind[], overridePath?: string): { path: string; added: ImportKind[] } {
  const targetPath = getPiGlobalConfigPath(overridePath);
  const raw = readRawConfigObject(targetPath);
  const currentImports = Array.isArray(raw.imports) ? raw.imports.filter((value): value is ImportKind => typeof value === "string") : [];
  const merged = [...new Set([...currentImports, ...importKinds])];
  const added = merged.filter((kind) => !currentImports.includes(kind));
  if (added.length === 0) {
    return { path: targetPath, added: [] };
  }

  raw.imports = merged;
  const servers = getServersObject(raw);
  setServersObject(raw, servers);
  writeRawConfigObject(targetPath, raw);
  return { path: targetPath, added };
}

export function buildStarterProjectConfig(): McpConfig {
  return {
    mcpServers: {},
  };
}

export function previewStarterProjectConfig(cwd = process.cwd()): ConfigWritePreview {
  const targetPath = getProjectConfigPath(cwd);
  const nextRaw = { mcpServers: buildStarterProjectConfig().mcpServers };
  return buildConfigWritePreview(targetPath, nextRaw);
}

export function writeStarterProjectConfig(cwd = process.cwd()): string {
  const targetPath = getProjectConfigPath(cwd);
  const raw = { mcpServers: buildStarterProjectConfig().mcpServers };
  writeRawConfigObject(targetPath, raw);
  return targetPath;
}

export function previewSharedServerEntry(filePath: string, serverName: string, entry: ServerEntry): ConfigWritePreview {
  const raw = readRawConfigObject(filePath);
  const nextRaw = { ...raw };
  const servers = getServersObject(nextRaw);
  servers[serverName] = entry;
  setServersObject(nextRaw, servers);
  return buildConfigWritePreview(filePath, nextRaw);
}

export function writeSharedServerEntry(filePath: string, serverName: string, entry: ServerEntry): string {
  const raw = readRawConfigObject(filePath);
  const servers = getServersObject(raw);
  servers[serverName] = entry;
  setServersObject(raw, servers);
  writeRawConfigObject(filePath, raw);
  return filePath;
}

export function getServerProvenance(overridePath?: string, cwd = process.cwd()): Map<string, ServerProvenance> {
  const provenance = new Map<string, ServerProvenance>();
  const userPath = getPiGlobalConfigPath(overridePath);

  if (getConfiguredHostConfigDiscovery(overridePath, cwd) === "on") {
    for (const importKind of Object.keys(IMPORT_PATHS) as ImportKind[]) {
      const imported = loadImportedConfig(importKind, cwd, `Failed to inspect imported MCP config from ${importKind}:`);
      if (!imported) continue;
      for (const name of Object.keys(extractServers(imported.value, importKind))) {
        // Keep writes inside Pi-owned storage even though the source is external.
        // Later import kinds win in the same deterministic order as loadDiscoveredHostConfigs.
        provenance.set(name, { path: userPath, kind: "import", importKind });
      }
    }
  }

  for (const source of getConfigSources(overridePath, cwd)) {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (!loaded) continue;

    if (loaded.imports?.length) {
      for (const importKind of loaded.imports) {
        const imported = loadImportedConfig(importKind, cwd, `Failed to inspect imported MCP config from ${importKind}:`);
        if (!imported) continue;

        const servers = extractServers(imported.value, importKind);
        for (const name of Object.keys(servers)) {
          if (!provenance.has(name)) {
            provenance.set(name, { path: userPath, kind: "import", importKind });
          }
        }
      }
    }

    for (const name of Object.keys(loaded.mcpServers)) {
      provenance.set(name, {
        path: source.writePath,
        kind: source.kind,
        ...(source.importKind !== undefined ? { importKind: source.importKind } : {}),
      });
    }
  }

  return provenance;
}

export function writeDirectToolsConfig(
  changes: Map<string, true | string[] | false>,
  provenance: Map<string, ServerProvenance>,
  fullConfig: McpConfig,
): void {
  const byPath = new Map<string, { name: string; value: true | string[] | false; prov: ServerProvenance }[]>();

  for (const [serverName, value] of changes) {
    const prov = provenance.get(serverName);
    if (!prov) continue;

    const targetPath = prov.path;

    if (!byPath.has(targetPath)) byPath.set(targetPath, []);
    byPath.get(targetPath)!.push({ name: serverName, value, prov });
  }

  for (const [filePath, entries] of byPath) {
    const raw = readRawConfigObject(filePath);
    const servers = getServersObject(raw);

    for (const { name, value, prov } of entries) {
      if (prov.kind === "import") {
        const fullDef = fullConfig.mcpServers[name];
        if (fullDef) {
          servers[name] = { ...fullDef, directTools: value };
        }
      } else if (servers[name]) {
        servers[name] = { ...servers[name], directTools: value };
      }
    }

    setServersObject(raw, servers);
    writeRawConfigObject(filePath, raw);
  }
}

export function resolveConfiguredOAuthDir(raw: unknown, cwd = process.cwd()): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new Error("settings.oauthDir must be a string");
  }

  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return resolve(cwd, trimmed);
}
