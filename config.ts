// config.ts - Config loading with import support and extension providers
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import type { McpConfig, ServerEntry, McpSettings, ImportKind, ServerProvenance } from "./types.js";
import {
  MCP_COLLECT_SERVERS_EVENT,
  type CollectMcpServersEvent,
  type McpServerContribution,
} from "./providers.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "mcp.json");
const PROJECT_CONFIG_NAME = ".pi/mcp.json";

// Import source paths for other tools
const IMPORT_PATHS: Record<ImportKind, string> = {
  "cursor": join(homedir(), ".cursor", "mcp.json"),
  "claude-code": join(homedir(), ".claude", "claude_desktop_config.json"),
  "claude-desktop": join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  "codex": join(homedir(), ".codex", "config.json"),
  "windsurf": join(homedir(), ".windsurf", "mcp.json"),
  "vscode": ".vscode/mcp.json", // Relative to project
};

export interface ResolvedMcpConfig {
  config: McpConfig;
  provenance: Map<string, ServerProvenance>;
}

export function getMcpConfigPath(overridePath?: string): string {
  return overridePath ? resolve(overridePath) : DEFAULT_CONFIG_PATH;
}

function mergeServerMaps(
  base: Record<string, ServerEntry>,
  incoming: Record<string, ServerEntry>,
): Record<string, ServerEntry> {
  const merged = { ...base };
  for (const [name, definition] of Object.entries(incoming)) {
    const existing = merged[name];
    merged[name] = existing ? { ...existing, ...definition } : definition;
  }
  return merged;
}

function mergeConfigs(base: McpConfig, incoming: McpConfig): McpConfig {
  return {
    mcpServers: mergeServerMaps(base.mcpServers, incoming.mcpServers),
    imports: incoming.imports ?? base.imports,
    settings: incoming.settings ? { ...base.settings, ...incoming.settings } : base.settings,
  };
}

function readValidatedConfig(path: string): McpConfig {
  if (!existsSync(path)) return { mcpServers: {} };

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return validateConfig(raw);
  } catch (error) {
    console.warn(`Failed to load MCP config from ${path}:`, error);
    return { mcpServers: {} };
  }
}

export function loadMcpConfig(overridePath?: string): McpConfig {
  const configPath = getMcpConfigPath(overridePath);
  const userConfig = readValidatedConfig(configPath);

  let config: McpConfig = { mcpServers: {} };

  // Process imports from other tools first.
  if (userConfig.imports?.length) {
    for (const importKind of userConfig.imports) {
      const importPath = IMPORT_PATHS[importKind];
      if (!importPath) continue;

      const fullPath = importPath.startsWith(".")
        ? resolve(process.cwd(), importPath)
        : importPath;

      if (!existsSync(fullPath)) continue;

      try {
        const imported = JSON.parse(readFileSync(fullPath, "utf-8"));
        const servers = extractServers(imported, importKind);
        config.mcpServers = mergeServerMaps(config.mcpServers, servers);
      } catch (error) {
        console.warn(`Failed to import MCP config from ${importKind}:`, error);
      }
    }
  }

  // User config overrides imported defaults.
  config = mergeConfigs(config, userConfig);

  // Project config overrides everything.
  const projectPath = resolve(process.cwd(), PROJECT_CONFIG_NAME);
  if (existsSync(projectPath) && projectPath !== configPath) {
    try {
      const projectConfig = validateConfig(JSON.parse(readFileSync(projectPath, "utf-8")));
      config = mergeConfigs(config, projectConfig);
    } catch (error) {
      console.warn("Failed to load project MCP config:", error);
    }
  }

  return config;
}

function validateConfig(raw: unknown): McpConfig {
  if (!raw || typeof raw !== "object") {
    return { mcpServers: {} };
  }

  const obj = raw as Record<string, unknown>;
  const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};

  // Must be a plain object, not an array or null
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return { mcpServers: {} };
  }

  return {
    mcpServers: servers as Record<string, ServerEntry>,
    imports: Array.isArray(obj.imports) ? obj.imports as ImportKind[] : undefined,
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

export function getServerProvenance(overridePath?: string): Map<string, ServerProvenance> {
  const provenance = new Map<string, ServerProvenance>();
  const userPath = getMcpConfigPath(overridePath);

  const userConfig = readValidatedConfig(userPath);

  if (userConfig.imports?.length) {
    for (const importKind of userConfig.imports) {
      const importPath = IMPORT_PATHS[importKind];
      if (!importPath) continue;
      const fullPath = importPath.startsWith(".")
        ? resolve(process.cwd(), importPath)
        : importPath;
      if (!existsSync(fullPath)) continue;
      try {
        const imported = JSON.parse(readFileSync(fullPath, "utf-8"));
        const servers = extractServers(imported, importKind);
        for (const name of Object.keys(servers)) {
          provenance.set(name, { path: userPath, kind: "import", importKind });
        }
      } catch {}
    }
  }

  for (const name of Object.keys(userConfig.mcpServers)) {
    provenance.set(name, { path: userPath, kind: "user" });
  }

  const projectPath = resolve(process.cwd(), PROJECT_CONFIG_NAME);
  if (existsSync(projectPath) && projectPath !== userPath) {
    try {
      const projectConfig = validateConfig(JSON.parse(readFileSync(projectPath, "utf-8")));
      for (const name of Object.keys(projectConfig.mcpServers)) {
        provenance.set(name, { path: projectPath, kind: "project" });
      }
    } catch {}
  }

  return provenance;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeContribution(
  contribution: McpServerContribution,
): McpServerContribution | null {
  if (!contribution || typeof contribution.source !== "string" || !contribution.source.trim()) {
    return null;
  }
  if (!isPlainObject(contribution.servers)) {
    console.warn(`MCP: provider "${contribution.source}" contributed invalid servers payload; skipping`);
    return null;
  }

  const servers: Record<string, ServerEntry> = {};
  for (const [name, definition] of Object.entries(contribution.servers)) {
    if (!isPlainObject(definition)) {
      console.warn(`MCP: provider "${contribution.source}" contributed invalid server "${name}"; skipping`);
      continue;
    }
    servers[name] = definition as ServerEntry;
  }

  return {
    source: contribution.source,
    priority: contribution.priority ?? 0,
    servers,
  };
}

export function collectExtensionServerContributions(
  pi: Pick<ExtensionAPI, "events">,
): McpServerContribution[] {
  const collected: Array<McpServerContribution & { __index: number }> = [];
  const event: CollectMcpServersEvent = {
    add(input) {
      const items = Array.isArray(input) ? input : [input];
      for (const item of items) {
        const normalized = normalizeContribution(item);
        if (!normalized) continue;
        collected.push({ ...normalized, __index: collected.length });
      }
    },
  };

  pi.events.emit(MCP_COLLECT_SERVERS_EVENT, event);

  return collected
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.__index - b.__index)
    .map(({ __index, ...item }) => item);
}

export function resolveMcpConfig(
  pi: Pick<ExtensionAPI, "events">,
  overridePath?: string,
): ResolvedMcpConfig {
  const userPath = getMcpConfigPath(overridePath);
  const fileConfig = loadMcpConfig(overridePath);
  const fileProvenance = getServerProvenance(overridePath);
  const provenance = new Map<string, ServerProvenance>();

  let config: McpConfig = { mcpServers: {} };

  for (const contribution of collectExtensionServerContributions(pi)) {
    for (const [name, definition] of Object.entries(contribution.servers)) {
      if (config.mcpServers[name]) {
        console.warn(
          `MCP: duplicate extension server "${name}" from "${contribution.source}" overrides previous provider definition`,
        );
      }
      config.mcpServers = mergeServerMaps(config.mcpServers, { [name]: definition });
      provenance.set(name, {
        path: userPath,
        kind: "extension",
        extensionSource: contribution.source,
      });
    }
  }

  config = mergeConfigs(config, fileConfig);

  for (const [name, prov] of fileProvenance) {
    provenance.set(name, prov);
  }

  return { config, provenance };
}

export function writeDirectToolsConfig(
  changes: Map<string, true | string[] | false>,
  provenance: Map<string, ServerProvenance>,
  fullConfig: McpConfig,
): void {
  const byPath = new Map<string, { name: string; value: true | string[] | false; prov: ServerProvenance }[]>();

  for (const [serverName, value] of changes) {
    const prov = provenance.get(serverName);
    if (!prov?.path) continue;

    const targetPath = prov.path;

    if (!byPath.has(targetPath)) byPath.set(targetPath, []);
    byPath.get(targetPath)!.push({ name: serverName, value, prov });
  }

  for (const [filePath, entries] of byPath) {
    let raw: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      try {
        raw = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {}
    }
    if (!raw || typeof raw !== "object") raw = {};

    const servers = (raw.mcpServers ?? raw["mcp-servers"] ?? {}) as Record<string, ServerEntry>;
    if (typeof servers !== "object" || Array.isArray(servers)) continue;

    for (const { name, value, prov } of entries) {
      if (prov.kind === "import" || prov.kind === "extension") {
        const fullDef = fullConfig.mcpServers[name];
        if (fullDef) {
          servers[name] = { ...fullDef, directTools: value };
        }
      } else if (servers[name]) {
        servers[name] = { ...servers[name], directTools: value };
      }
    }

    const key = raw["mcp-servers"] && !raw.mcpServers ? "mcp-servers" : "mcpServers";
    raw[key] = servers;

    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, filePath);
  }
}
