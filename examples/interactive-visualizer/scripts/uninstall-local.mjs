import { readFile, writeFile } from "node:fs/promises";
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

try {
  const raw = await readFile(configPath, "utf-8");
  const config = JSON.parse(raw);
  const entry = config?.mcpServers?.[serverName];

  if (!entry) {
    console.log(`${serverName} is not installed in ${configPath}`);
  } else if (!isInstalledExample(entry)) {
    console.log(`Left ${serverName} unchanged because the existing entry does not match this local example install.`);
  } else {
    delete config.mcpServers[serverName];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    console.log(`Removed ${serverName} from ${configPath}`);
  }
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    console.log(`No MCP config found at ${configPath}`);
  } else {
    throw error;
  }
}
