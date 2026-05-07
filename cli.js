#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();

function expandHome(input) {
  if (input === "~") return HOME;
  if (input.startsWith("~/")) return path.resolve(HOME, input.slice(2));
  return path.resolve(input);
}

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim()
  ? expandHome(process.env.PI_CODING_AGENT_DIR.trim())
  : path.join(HOME, ".pi", "agent");
const PI_CONFIG_PATH = path.join(AGENT_DIR, "mcp.json");
const GENERIC_GLOBAL_CONFIG_PATH = path.join(HOME, ".config", "mcp", "mcp.json");
const PROJECT_CONFIG_PATH = path.resolve(process.cwd(), ".mcp.json");
const PROJECT_PI_CONFIG_PATH = path.resolve(process.cwd(), ".pi", "mcp.json");

const IMPORT_PATHS = {
  cursor: [path.join(HOME, ".cursor", "mcp.json")],
  "claude-code": [
    path.join(HOME, ".claude", "mcp.json"),
    path.join(HOME, ".claude.json"),
    path.join(HOME, ".claude", "claude_desktop_config.json"),
  ],
  "claude-desktop": [path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")],
  codex: [path.join(HOME, ".codex", "config.json")],
  windsurf: [path.join(HOME, ".windsurf", "mcp.json")],
  vscode: [path.resolve(process.cwd(), ".vscode", "mcp.json")],
};

function printHelp(log = console.log) {
  log("pi-mcp-adapter helper\n");
  log("Install the package with:");
  log("  pi install npm:pi-mcp-adapter\n");
  log("Then optionally run:");
  log("  pi-mcp-adapter init       Detect host configs and scaffold Pi imports");
  log("  pi-mcp-adapter init --dry-run");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function loadPiConfig() {
  if (!fs.existsSync(PI_CONFIG_PATH)) {
    return { mcpServers: {} };
  }

  const raw = readJsonFile(PI_CONFIG_PATH);
  const mcpServers = raw.mcpServers ?? raw["mcp-servers"] ?? {};
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    throw new Error(`Invalid MCP config at ${PI_CONFIG_PATH}: expected \"mcpServers\" to be an object`);
  }

  const normalized = { ...raw };
  delete normalized["mcp-servers"];

  const imports = Array.isArray(raw.imports) ? raw.imports.filter((value) => typeof value === "string") : undefined;
  return {
    ...normalized,
    mcpServers,
    imports,
  };
}

function findAvailableImports() {
  const found = [];

  for (const [kind, candidates] of Object.entries(IMPORT_PATHS)) {
    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    if (existing) {
      found.push({ kind, path: existing });
    }
  }

  return found;
}

function printDiscovery(log, imports) {
  log("Config discovery:\n");

  const paths = [
    ["User-global standard MCP", GENERIC_GLOBAL_CONFIG_PATH],
    ["Pi global override", PI_CONFIG_PATH],
    ["Project standard MCP", PROJECT_CONFIG_PATH],
    ["Project Pi override", PROJECT_PI_CONFIG_PATH],
  ];

  for (const [label, filePath] of paths) {
    const prefix = fs.existsSync(filePath) ? "✓" : "-";
    log(`${prefix} ${label}: ${filePath}`);
  }

  log("\nCompatibility imports:\n");
  if (imports.length === 0) {
    log("- No host-specific MCP configs detected");
    return;
  }

  for (const entry of imports) {
    log(`✓ ${entry.kind}: ${entry.path}`);
  }
}

function writePiConfig(config) {
  fs.mkdirSync(path.dirname(PI_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(PI_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

async function runInit(argv, log = console.log) {
  const dryRun = argv.includes("--dry-run");
  const foundImports = findAvailableImports();
  const existingConfig = loadPiConfig();
  const existingImports = new Set(existingConfig.imports ?? []);
  const importsToAdd = foundImports
    .map((entry) => entry.kind)
    .filter((kind) => !existingImports.has(kind));

  printDiscovery(log, foundImports);

  if (importsToAdd.length === 0) {
    log("\nNo Pi config changes needed.");
    log("Standard MCP configs are discovered automatically, and host-specific imports are already configured or unavailable.");
    return 0;
  }

  const nextConfig = {
    ...existingConfig,
    imports: [...existingImports, ...importsToAdd],
    mcpServers: existingConfig.mcpServers ?? {},
  };

  log(`\nDetected host configs to import into Pi: ${importsToAdd.join(", ")}`);

  if (dryRun) {
    log(`Dry run: would update ${PI_CONFIG_PATH}`);
    return 0;
  }

  writePiConfig(nextConfig);
  log(`Updated ${PI_CONFIG_PATH}`);
  log("Pi will now keep reading standard MCP configs automatically, while these imports cover host-specific config formats.");
  return 0;
}

export async function main(argv = process.argv.slice(2), log = console.log, error = console.error) {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(log);
    return 0;
  }

  if (command === "install") {
    error("The custom downloader has been retired.");
    error("Use `pi install npm:pi-mcp-adapter` instead, then optionally run `pi-mcp-adapter init`.");
    return 1;
  }

  if (command === "init") {
    return runInit(rest, log);
  }

  error(`Unknown command: ${command}`);
  printHelp(log);
  return 1;
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(`\nHelper failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
