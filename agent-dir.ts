import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    return join(homedir(), ".pi", "agent");
  }
  if (configured === "~") {
    return homedir();
  }
  if (configured.startsWith("~/")) {
    return resolve(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

export function getAgentPath(...segments: string[]): string {
  return join(getAgentDir(), ...segments);
}

/**
 * What the host calls itself.
 *
 * pi supports rebranding through `piConfig.name` in the package.json that its
 * `getPackageDir()` resolves, and distributions built on pi (arc, tau, …) point
 * `PI_PACKAGE_DIR` at their own manifest. Read that manifest directly rather
 * than importing pi: this package deliberately depends on pi-ai and pi-tui
 * only, and `getAgentDir()` above reads its env var the same self-contained way.
 *
 * Falls back to "pi", which is what pi's own APP_NAME resolves to.
 */
function readPiConfig(): { name?: unknown; clientUri?: unknown } | undefined {
  const dir = process.env.PI_PACKAGE_DIR?.trim()
  if (!dir) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(resolve(dir), "package.json"), "utf8")) as {
      piConfig?: { name?: unknown; clientUri?: unknown }
    }
    return manifest.piConfig
  } catch {
    return undefined
  }
}

export function getAppName(): string {
  const name = readPiConfig()?.name
  return typeof name === "string" && name.trim() ? name.trim() : "pi"
}

/**
 * Home page the host declares for itself, via `piConfig.clientUri` in the same
 * manifest that carries `piConfig.name`. Only the distribution knows its own
 * URL, so this is the one place it can come from without guessing.
 */
export function getAppClientUri(): string | undefined {
  const uri = readPiConfig()?.clientUri
  return typeof uri === "string" && uri.trim() ? uri.trim() : undefined
}
