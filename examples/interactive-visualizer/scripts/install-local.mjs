import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distServer = path.join(root, "dist", "server.js");
const configPath = path.join(getAgentDir(), "mcp.json");
const serverName = "interactive-visualizer";

function isInstalledExample(entry) {
  return !!entry
    && entry.command === process.execPath
    && Array.isArray(entry.args)
    && entry.args[0] === distServer;
}

async function loadConfig() {
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { mcpServers: {} };
    }
    throw error;
  }
}

const config = await loadConfig();
config.mcpServers = config.mcpServers ?? {};
const existing = config.mcpServers[serverName];

if (existing && !isInstalledExample(existing)) {
  console.error(`Refusing to overwrite existing ${serverName} entry in ${configPath} because it does not match this local example install.`);
  process.exit(1);
}

config.mcpServers[serverName] = {
  command: process.execPath,
  args: [distServer],
  lifecycle: "lazy",
};

await mkdir(path.dirname(configPath), { recursive: true });
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
console.log(`Installed ${serverName} at ${configPath}`);
