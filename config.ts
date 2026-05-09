// config.ts - Config loading with import support
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentPath } from "./agent-dir.js";
import type { McpConfig, ServerEntry, McpSettings, ImportKind, ServerProvenance } from "./types.js";

const GENERIC_GLOBAL_CONFIG_PATH = join(homedir(), ".config", "mcp", "mcp.json");
const PROJECT_CONFIG_NAME = ".mcp.json";
const PROJECT_PI_CONFIG_NAME = ".pi/mcp.json";
const REPOPROMPT_BINARY_CANDIDATES = [
  join(homedir(), "RepoPrompt", "repoprompt_cli"),
  "/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp",
];

const IMPORT_PATHS: Record<ImportKind, string[]> = {
  cursor: [join(homedir(), ".cursor", "mcp.json")],
  "claude-code": [
    join(homedir(), ".claude", "mcp.json"),
    join(homedir(), ".claude.json"),
    join(homedir(), ".claude", "claude_desktop_config.json"),
  ],
  "claude-desktop": [join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
  codex: [join(homedir(), ".codex", "config.json")],
  windsurf: [join(homedir(), ".windsurf", "mcp.json")],
  vscode: [".vscode/mcp.json"],
};

interface ConfigSourceSpec {
  id: "shared-global" | "pi-global" | "shared-project" | "pi-project";
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
  hasAnyConfig: boolean;
  hasAnyDetectedPaths: boolean;
  hasSharedServers: boolean;
  hasPiOwnedServers: boolean;
  totalServerCount: number;
  fingerprint: string;
  repoPrompt: RepoPromptDiscovery;
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
  return resolve(cwd, PROJECT_PI_CONFIG_NAME);
}

export function getConfigDiscoveryPaths(overridePath?: string): ConfigDiscoveryPath[] {
  return getConfigSources(overridePath).map((source) => ({
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

export function getMcpDiscoverySummary(overridePath?: string, cwd = process.cwd()): McpDiscoverySummary {
  const sources = getConfigSources(overridePath, cwd).map((source) => {
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

  const imports = (Object.keys(IMPORT_PATHS) as ImportKind[])
    .map((kind) => {
      const path = resolveImportPath(kind, cwd);
      if (!path) return null;
      return {
        kind,
        path,
        serverCount: getImportServerCount(kind, path),
      } satisfies ImportConfigSummary;
    })
    .filter((value): value is ImportConfigSummary => value !== null);

  const totalServerCount = sources.reduce((sum, source) => sum + source.serverCount, 0);
  const hasSharedServers = sources.some((source) => source.kind === "shared" && source.serverCount > 0);
  const hasPiOwnedServers = sources.some((source) => source.kind === "pi" && source.serverCount > 0);
  const hasAnyDetectedPaths = sources.some((source) => source.exists) || imports.length > 0;
  const hasAnyConfig = totalServerCount > 0 || imports.some((entry) => entry.serverCount > 0) || hasAnyDetectedPaths;

  const summaryWithoutRepoPrompt = {
    sources,
    imports,
    hasAnyConfig,
    hasAnyDetectedPaths,
    hasSharedServers,
    hasPiOwnedServers,
    totalServerCount,
  };

  const fingerprint = JSON.stringify({
    sources: sources.map((source) => [source.id, source.exists, source.serverCount]),
    imports: imports.map((entry) => [entry.kind, entry.path, entry.serverCount]),
  });

  return {
    ...summaryWithoutRepoPrompt,
    fingerprint,
    repoPrompt: detectRepoPrompt(summaryWithoutRepoPrompt, cwd),
  };
}

export function loadMcpConfig(overridePath?: string): McpConfig {
  let config: McpConfig = { mcpServers: {} };

  for (const source of getConfigSources(overridePath)) {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (!loaded) continue;
    config = mergeConfigs(config, expandImports(loaded));
  }

  return config;
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
  return {
    mcpServers: { ...base.mcpServers, ...next.mcpServers },
    imports: mergeImports(base.imports, next.imports),
    settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
  };
}

function mergeImports(left: ImportKind[] | undefined, right: ImportKind[] | undefined): ImportKind[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  if (merged.length === 0) return undefined;
  return [...new Set(merged)];
}

function expandImports(config: McpConfig): McpConfig {
  if (!config.imports?.length) return config;

  const importedServers: Record<string, ServerEntry> = {};
  for (const importKind of config.imports) {
    const importPath = resolveImportPath(importKind);
    if (!importPath) continue;

    try {
      const imported = JSON.parse(readFileSync(importPath, "utf-8"));
      const servers = extractServers(imported, importKind);
      for (const [name, definition] of Object.entries(servers)) {
        if (!importedServers[name]) {
          importedServers[name] = definition;
        }
      }
    } catch (error) {
      console.warn(`Failed to import MCP config from ${importKind}:`, error);
    }
  }

  return {
    imports: config.imports,
    settings: config.settings,
    mcpServers: { ...importedServers, ...config.mcpServers },
  };
}

function resolveImportPath(importKind: ImportKind, cwd = process.cwd()): string | null {
  const candidates = IMPORT_PATHS[importKind] ?? [];
  for (const candidate of candidates) {
    const fullPath = candidate.startsWith(".") ? resolve(cwd, candidate) : candidate;
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

function getImportServerCount(importKind: ImportKind, path: string): number {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return Object.keys(extractServers(raw, importKind)).length;
  } catch {
    return 0;
  }
}

function readValidatedConfig(path: string, label: string): McpConfig | null {
  if (!existsSync(path)) return null;

  try {
    return validateConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch (error) {
    console.warn(`Failed to load ${label}:`, error);
    return null;
  }
}

function validateConfig(raw: unknown): McpConfig {
  if (!raw || typeof raw !== "object") {
    return { mcpServers: {} };
  }

  const obj = raw as Record<string, unknown>;
  const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};

  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { mcpServers: {} };
  }

  return {
    mcpServers: servers as Record<string, ServerEntry>,
    imports: Array.isArray(obj.imports) ? (obj.imports as ImportKind[]) : undefined,
    settings: obj.settings as McpSettings | undefined,
  };
}

function extractServers(config: unknown, kind: ImportKind): Record<string, ServerEntry> {
  if (!config || typeof config !== "object") return {};

  const obj = config as Record<string, unknown>;

  let servers: unknown;
  switch (kind) {
    case "claude-desktop":
    case "claude-code":
    case "codex":
      servers = obj.mcpServers;
      break;
    case "cursor":
    case "windsurf":
    case "vscode":
      servers = obj.mcpServers ?? obj["mcp-servers"];
      break;
    default:
      return {};
  }

  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return {};
  }

  return servers as Record<string, ServerEntry>;
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
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
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
    if (j < cols && (i === rows || lcs[i][j + 1] >= lcs[i + 1][j])) {
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
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
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

export function getServerProvenance(overridePath?: string): Map<string, ServerProvenance> {
  const provenance = new Map<string, ServerProvenance>();
  const userPath = getPiGlobalConfigPath(overridePath);

  for (const source of getConfigSources(overridePath)) {
    const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
    if (!loaded) continue;

    if (loaded.imports?.length) {
      for (const importKind of loaded.imports) {
        const importPath = resolveImportPath(importKind);
        if (!importPath) continue;

        try {
          const imported = JSON.parse(readFileSync(importPath, "utf-8"));
          const servers = extractServers(imported, importKind);
          for (const name of Object.keys(servers)) {
            if (!provenance.has(name)) {
              provenance.set(name, { path: userPath, kind: "import", importKind });
            }
          }
        } catch {}
      }
    }

    for (const name of Object.keys(loaded.mcpServers)) {
      provenance.set(name, {
        path: source.writePath,
        kind: source.kind,
        importKind: source.importKind,
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
