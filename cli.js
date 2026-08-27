#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import stripJsonComments from "strip-json-comments";

const HOME = os.homedir();

function expandHome(input) {
  if (input === "~") return HOME;
  if (input.startsWith("~/")) return path.resolve(HOME, input.slice(2));
  return path.resolve(input);
}

function readPiConfig() {
  const dir = process.env.PI_PACKAGE_DIR?.trim();
  if (!dir) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(path.resolve(dir), "package.json"), "utf8")).piConfig;
  } catch {
    return undefined;
  }
}

function getConfigDirName() {
  const configDir = readPiConfig()?.configDir;
  return typeof configDir === "string" && configDir.trim() ? configDir.trim() : ".pi";
}

function getAgentDir() {
  const piConfig = readPiConfig();
  const appName = typeof piConfig?.name === "string" && piConfig.name.trim() ? piConfig.name.trim() : "pi";
  const configured = process.env[`${appName.toUpperCase()}_CODING_AGENT_DIR`]?.trim();
  if (configured) return expandHome(configured);
  return path.join(HOME, getConfigDirName(), "agent");
}

const AGENT_DIR = getAgentDir();
const PI_CONFIG_PATH = path.join(AGENT_DIR, "mcp.json");
const GENERIC_GLOBAL_CONFIG_PATH = path.join(HOME, ".config", "mcp", "mcp.json");
const AGENTS_GLOBAL_CONFIG_PATH = path.join(HOME, ".agents", "mcp.json");
const AGENTS_NESTED_GLOBAL_CONFIG_PATH = path.join(HOME, ".agents", "mcp", "mcp.json");
const PROJECT_CONFIG_PATH = path.resolve(process.cwd(), ".mcp.json");
const PROJECT_PI_CONFIG_PATH = path.resolve(process.cwd(), getConfigDirName(), "mcp.json");

const IMPORT_PATHS = {
  cursor: [path.join(HOME, ".cursor", "mcp.json")],
  "claude-code": [
    path.join(HOME, ".claude", "mcp.json"),
    path.join(HOME, ".claude.json"),
    path.join(HOME, ".claude", "claude_desktop_config.json"),
  ],
  "claude-desktop": [path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json")],
  codex: [
    path.join(HOME, ".codex", "config.toml"),
    path.join(HOME, ".codex", "config.json"),
  ],
  opencode: [
    path.join(HOME, ".config", "opencode", "opencode.json"),
    path.resolve(process.cwd(), "opencode.json"),
  ],
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
  log("  pi-mcp-adapter init --discover-host-configs  Opt in to host config fallback discovery");
  log("");
  log("Bearer token storage (servers configured with auth: \"bearer\" and bearerTokenStore: true):");
  log("  pi-mcp-adapter token set <server>     Store a token read from stdin (masked prompt or pipe; never argv)");
  log("  pi-mcp-adapter token status <server>  Report whether a stored token matches the configured URL");
  log("  pi-mcp-adapter token remove <server>  Remove the stored token");
}

function readJsonFile(filePath) {
  return JSON.parse(stripJsonComments(fs.readFileSync(filePath, "utf-8"), { trailingCommas: true }));
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
    ["User-global .agents MCP", AGENTS_GLOBAL_CONFIG_PATH],
    ["User-global .agents nested MCP", AGENTS_NESTED_GLOBAL_CONFIG_PATH],
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
  const discoverHostConfigs = argv.includes("--discover-host-configs");
  const foundImports = findAvailableImports();
  const existingConfig = loadPiConfig();
  const existingImports = new Set(existingConfig.imports ?? []);
  const importsToAdd = foundImports
    .map((entry) => entry.kind)
    .filter((kind) => !existingImports.has(kind));

  printDiscovery(log, foundImports);

  const discoverySettingChanged = discoverHostConfigs && existingConfig.settings?.hostConfigDiscovery !== "on";
  if (importsToAdd.length === 0 && !discoverySettingChanged) {
    log("\nNo Pi config changes needed.");
    log("Standard MCP configs are discovered automatically, and host-specific imports are already configured or unavailable.");
    return 0;
  }

  const nextConfig = {
    ...existingConfig,
    ...(discoverySettingChanged ? { settings: { ...existingConfig.settings, hostConfigDiscovery: "on" } } : {}),
    ...(importsToAdd.length > 0 ? { imports: [...existingImports, ...importsToAdd] } : {}),
    mcpServers: existingConfig.mcpServers ?? {},
  };

  if (importsToAdd.length > 0) {
    log(`\nDetected host configs to import into Pi: ${importsToAdd.join(", ")}`);
  }
  if (discoverySettingChanged) {
    log("Opting in to host-specific fallback discovery (standard and Pi-owned configs still take precedence).");
  }

  if (dryRun) {
    log(`Dry run: would update ${PI_CONFIG_PATH}`);
    return 0;
  }

  writePiConfig(nextConfig);
  log(`Updated ${PI_CONFIG_PATH}`);
  log("Pi will now keep reading standard MCP configs automatically, while these imports cover host-specific config formats.");
  if (discoverySettingChanged) {
    log("Host config discovery is explicit and does not write to or execute commands from external host files.");
  }
  return 0;
}

async function importTokenModules(error) {
  try {
    const [store, config, utils] = await Promise.all([
      import("./dist/mcp-bearer-store.js"),
      import("./dist/config.js"),
      import("./dist/utils.js"),
    ]);
    return { store, config, utils };
  } catch (err) {
    error("Unable to load token command modules.");
    error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function readTokenFromStdin(stdin) {
  if (stdin.isTTY) return readTokenMasked(stdin);
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data.replace(/[\r\n]+$/, "")));
    stdin.on("error", reject);
  });
}

// Raw-mode masked prompt: the token never echoes to the terminal.
function readTokenMasked(stdin) {
  return new Promise((resolve, reject) => {
    process.stderr.write("Enter bearer token (input hidden): ");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let token = "";
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Token entry cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(token);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          token = token.slice(0, -1);
          continue;
        }
        token += char;
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    stdin.on("data", onData);
  });
}

async function runToken(argv, log, error, stdin) {
  const [action, serverName, ...extra] = argv;
  if (!["set", "status", "remove"].includes(action) || !serverName) {
    error("Usage: pi-mcp-adapter token <set|status|remove> <server>");
    error("`token set` reads the token from stdin only. Never pass the token as an argument.");
    return 1;
  }
  if (extra.length > 0) {
    error("Unexpected extra arguments. The token must not be passed on the command line; pipe it on stdin or use the interactive prompt.");
    return 1;
  }

  const modules = await importTokenModules(error);
  if (!modules) return 1;

  // Argv-derived text is sanitized before terminal output, and the resolved
  // URL is never printed: it can embed userinfo or interpolated secrets.
  const safeName = modules.utils.sanitizeTerminalText(serverName);
  const definition = modules.config.loadMcpConfig(undefined, process.cwd()).mcpServers[serverName];
  if (!definition) {
    error(`Server "${safeName}" not found in the effective MCP config.`);
    return 1;
  }
  if (definition.auth !== "bearer" || definition.bearerTokenStore !== true) {
    error(`Server "${safeName}" is not configured for bearerTokenStore. Set "auth": "bearer" and "bearerTokenStore": true.`);
    return 1;
  }
  // resolveServerUrl embeds the interpolated URL in its exceptions, so catch
  // and redact: the URL can carry userinfo or interpolated secrets.
  let serverUrl;
  try {
    serverUrl = modules.utils.resolveServerUrl(definition);
  } catch {
    error(`Server "${safeName}" has an invalid or unresolvable URL. Fix the server's url in the MCP config and retry.`);
    return 1;
  }
  if (!serverUrl) {
    error(`Server "${safeName}" has no URL configured.`);
    return 1;
  }

  if (action === "set") {
    const token = await readTokenFromStdin(stdin);
    if (!token) {
      error("No token provided on stdin.");
      return 1;
    }
    try {
      modules.store.saveBearerTokenForUrl(serverName, token, serverUrl);
    } catch (err) {
      error(modules.utils.sanitizeTerminalText(err instanceof Error ? err.message : String(err)));
      return 1;
    }
    log(`Bearer token stored for "${safeName}" and bound to the configured server URL.`);
    if (definition.bearerToken !== undefined || definition.bearerTokenEnv !== undefined) {
      log("Note: this server also configures bearerToken or bearerTokenEnv, which take precedence over the stored token.");
    }
    return 0;
  }

  if (action === "status") {
    const status = modules.store.inspectBearerTokenForUrl(serverName, serverUrl);
    if (status.status === "present") {
      log(`Bearer token is stored for "${safeName}".`);
      return 0;
    }
    if (status.status === "url-mismatch") {
      log(`Bearer token is stored for "${safeName}", but its URL does not match the current server URL. Run \`pi-mcp-adapter token set ${safeName}\` to rebind it.`);
      return 1;
    }
    if (status.status === "unavailable") {
      error(status.message);
      return 1;
    }
    log(`No bearer token is stored for "${safeName}".`);
    return 1;
  }

  try {
    modules.store.removeBearerToken(serverName);
  } catch (err) {
    error(modules.utils.sanitizeTerminalText(err instanceof Error ? err.message : String(err)));
    return 1;
  }
  log(`Bearer token removed for "${safeName}".`);
  return 0;
}

export async function main(argv = process.argv.slice(2), log = console.log, error = console.error, stdin = process.stdin) {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp(log);
    return 0;
  }

  if (command === "token") {
    return runToken(rest, log, error, stdin);
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

const resolvedEntrypoint = process.argv[1] ? fs.realpathSync(process.argv[1]) : undefined;
const isEntrypoint = resolvedEntrypoint && import.meta.url === pathToFileURL(resolvedEntrypoint).href;

if (isEntrypoint) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(`\nHelper failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
