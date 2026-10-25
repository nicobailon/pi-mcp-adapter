import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "./agent-dir.ts";

const NAME = "pi-mcp-adapter";
const CHANGELOG_URL = "https://github.com/nicobailon/pi-mcp-adapter/blob/main/CHANGELOG.md";

// major.minor.patch as one comparable number; undefined for anything else.
const versionNumber = (version: unknown) => typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)
  ? version.split(".").reduce((total, part) => total * 1e6 + Number(part), 0)
  : undefined;

export async function showUpgradeNotice(
  ctx: { hasUI: boolean; ui: { notify(message: string, type: "info"): void } },
  stateDir = join(getAgentDir(), NAME),
  changelogPath = fileURLToPath(new URL("./CHANGELOG.md", import.meta.url)),
  version: string = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")).version,
): Promise<void> {
  if (!ctx.hasUI) return;
  const statePath = join(stateDir, "last-seen-version.json");
  const lastSeen = await readFile(statePath, "utf-8").then((raw) => JSON.parse(raw).version).catch(() => undefined);
  const previous = versionNumber(lastSeen);
  const current = versionNumber(version);
  if (current === undefined || previous === current) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify({ version }));
  } catch {
    // Read-only installs cannot record the seen version. Without it the notice would repeat on every start, so skip it.
    return;
  }
  if (previous === undefined || previous > current) return;

  const bullets = (await readFile(changelogPath, "utf-8")).split(/^## /m).flatMap((section) => {
    const released = versionNumber(/^\[([^\]]+)\]/.exec(section)?.[1]);
    if (released === undefined || released <= previous || released > current) return [];
    const highlights = section.split(/^### /m).find((part) => part.startsWith("Highlights")) ?? "";
    return (highlights.match(/^- .*/gm) ?? []).map((bullet) => bullet.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim());
  });
  ctx.ui.notify([
    `${NAME} updated from ${lastSeen} to ${version}`,
    ...bullets.slice(0, 5),
    ...(bullets.length > 5 ? [`...and ${bullets.length - 5} more`] : []),
    `Changelog: ${CHANGELOG_URL}`,
  ].join("\n"), "info");
}
