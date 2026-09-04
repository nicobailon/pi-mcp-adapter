import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findAvailableImportConfigs,
  getMcpDiscoverySummary,
  loadMcpConfig,
} from "../config.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("exclusive MCP config", () => {
  it("loads the private agent config by default and honors an explicit override", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-exclusive-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    const override = join(root, "hostile-override.json");
    await Promise.all([
      writeConfig(join(agentDir, "mcp.json"), {
        imports: ["vscode"],
        mcpServers: { exact_root: { command: "node", args: ["exact-root"] } },
      }),
      writeConfig(join(workspace, ".mcp.json"), {
        mcpServers: { hostile_project: { command: "node", args: ["hostile-project"] } },
      }),
      writeConfig(join(workspace, ".pi", "mcp.json"), {
        mcpServers: { hostile_pi: { command: "node", args: ["hostile-pi"] } },
      }),
      writeConfig(join(workspace, ".vscode", "mcp.json"), {
        mcpServers: { explicit_vscode: { command: "node", args: ["explicit-vscode"] } },
      }),
      writeConfig(override, {
        mcpServers: { chosen: { command: "node", args: ["chosen"] } },
      }),
    ]);

    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_MCP_CONFIG_MODE", "exclusive");

    const config = loadMcpConfig(undefined, workspace);
    expect(Object.keys(config.mcpServers).sort()).toEqual(["exact_root", "explicit_vscode"]);
    expect(findAvailableImportConfigs(workspace)).toEqual([]);
    const discovery = getMcpDiscoverySummary(undefined, workspace);
    expect(discovery.sources.map(({ id }) => id)).toEqual(["pi-global"]);
    expect(discovery.imports.map(({ kind }) => kind)).toEqual(["vscode"]);
    expect(discovery.agentPlugins).toEqual([]);
    expect(discovery.hostConfigDiscovery).toBe("off");

    const overrideConfig = loadMcpConfig(override, workspace);
    expect(overrideConfig.mcpServers).toEqual({ chosen: { command: "node", args: ["chosen"] } });
    const overrideDiscovery = getMcpDiscoverySummary(override, workspace);
    expect(overrideDiscovery.sources).toEqual([
      expect.objectContaining({ id: "pi-global", path: override, exists: true, serverCount: 1 }),
    ]);
    expect(overrideDiscovery.imports).toEqual([]);
  });
});

async function writeConfig(filePath: string, config: unknown): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`);
}
