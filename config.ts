// config.ts - Config loading with import support
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, parse } from "node:path";
import type { McpConfig, ServerEntry, McpSettings, ImportKind, ServerProvenance } from "./types.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "mcp.json");
const PROJECT_LOCAL_CONFIGS: Array<{ kind: ImportKind | "pi" | "generic"; path: string }> = [
  { kind: "generic", path: ".mcp.json" },
  { kind: "pi", path: ".pi/mcp.json" },
  { kind: "cursor", path: ".cursor/mcp.json" },
  { kind: "windsurf", path: ".windsurf/mcp.json" },
  { kind: "vscode", path: ".vscode/mcp.json" },
  { kind: "claude-code", path: ".claude/mcp.json" },
  { kind: "codex", path: ".codex/config.json" },
];

// Import source paths for other tools
const IMPORT_PATHS: Record<ImportKind, string> = {
  "cursor": join(homedir(), ".cursor", "mcp.json"),
  "claude-code": join(homedir(), ".claude", "claude_desktop_config.json"),
  "claude-desktop": join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
  "codex": join(homedir(), ".codex", "config.json"),
  "windsurf": join(homedir(), ".windsurf", "mcp.json"),
  "vscode": ".vscode/mcp.json", // Relative to project
};

export function loadMcpConfig(overridePath?: string): McpConfig {
  const configPath = overridePath ? resolve(overridePath) : DEFAULT_CONFIG_PATH;
  
  // Load base config
  let config: McpConfig = { mcpServers: {} };
  
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      config = validateConfig(raw);
    } catch (error) {
      console.warn(`Failed to load MCP config from ${configPath}:`, error);
    }
  }
  
  // Process imports from other tools
  if (config.imports?.length) {
    for (const importKind of config.imports) {
      const importPath = IMPORT_PATHS[importKind];
      if (!importPath) continue;
      
      const fullPath = importPath.startsWith(".") 
        ? resolve(process.cwd(), importPath) 
        : importPath;
      
      if (!existsSync(fullPath)) continue;
      
      try {
        const imported = JSON.parse(readFileSync(fullPath, "utf-8"));
        const servers = extractServers(imported, importKind);
        
        // Merge - local config takes precedence over imports
        for (const [name, def] of Object.entries(servers)) {
          if (!config.mcpServers[name]) {
            config.mcpServers[name] = def;
          }
        }
      } catch (error) {
        console.warn(`Failed to import MCP config from ${importKind}:`, error);
      }
    }
  }
  
  // Check for project-local configs (skip files already used as the main config)
  for (const projectConfig of findProjectLocalConfigs(process.cwd())) {
    if (projectConfig.path === configPath) continue;

    try {
      const projectRaw = JSON.parse(readFileSync(projectConfig.path, "utf-8"));
      const validated = validateProjectConfig(projectRaw, projectConfig.kind);

      // Project config overrides everything. Later entries are closer to cwd and win.
      config.mcpServers = { ...config.mcpServers, ...validated.mcpServers };
      if (validated.settings) {
        config.settings = { ...config.settings, ...validated.settings };
      }
    } catch (error) {
      console.warn(`Failed to load project MCP config from ${projectConfig.path}:`, error);
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

function validateProjectConfig(raw: unknown, kind: ImportKind | "pi" | "generic"): McpConfig {
  if (kind === "pi" || kind === "generic") {
    return validateConfig(raw);
  }

  return { mcpServers: extractServers(raw, kind) };
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

function findProjectLocalConfigs(startDir: string): Array<{ kind: ImportKind | "pi" | "generic"; path: string }> {
  const roots: string[] = [];
  let current = resolve(startDir);

  while (true) {
    roots.push(current);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }

  const discovered: Array<{ kind: ImportKind | "pi" | "generic"; path: string }> = [];
  for (const root of roots.reverse()) {
    for (const config of PROJECT_LOCAL_CONFIGS) {
      const fullPath = resolve(root, config.path);
      if (existsSync(fullPath)) {
        discovered.push({ kind: config.kind, path: fullPath });
      }
    }
  }

  return discovered;
}

export function getServerProvenance(overridePath?: string): Map<string, ServerProvenance> {
  const provenance = new Map<string, ServerProvenance>();
  const userPath = overridePath ? resolve(overridePath) : DEFAULT_CONFIG_PATH;

  let userConfig: McpConfig = { mcpServers: {} };
  if (existsSync(userPath)) {
    try {
      userConfig = validateConfig(JSON.parse(readFileSync(userPath, "utf-8")));
    } catch {}
  }
  for (const name of Object.keys(userConfig.mcpServers)) {
    provenance.set(name, { path: userPath, kind: "user" });
  }

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
          if (!provenance.has(name)) {
            provenance.set(name, { path: userPath, kind: "import", importKind });
          }
        }
      } catch {}
    }
  }

  for (const projectConfig of findProjectLocalConfigs(process.cwd())) {
    if (projectConfig.path === userPath) continue;

    try {
      const validated = validateProjectConfig(JSON.parse(readFileSync(projectConfig.path, "utf-8")), projectConfig.kind);
      for (const name of Object.keys(validated.mcpServers)) {
        provenance.set(name, { path: projectConfig.path, kind: "project" });
      }
    } catch {}
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
      if (prov.kind === "import") {
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
