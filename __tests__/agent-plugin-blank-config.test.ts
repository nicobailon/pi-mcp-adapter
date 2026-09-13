import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentPluginSummaries, loadAgentPluginConfigs } from "../agent-plugin-loader.ts";

describe("agent plugins with blank JSON files", () => {
  let root = "";

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
    vi.restoreAllMocks();
  });

  function writePlugin(mcpJson: string, pluginJson?: string): string {
    root = mkdtempSync(join(tmpdir(), "pi-mcp-blank-"));
    writeFileSync(
      join(root, "plugin.json"),
      pluginJson ??
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "demo",
        }),
    );
    writeFileSync(join(root, "mcp.json"), mcpJson);
    return root;
  }

  it("treats a blank mcp.json as no servers without warning", () => {
    const dir = writePlugin("");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadAgentPluginConfigs([dir])).toEqual({ mcpServers: {} });
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a blank plugin.json as invalid without throwing", () => {
    const dir = writePlugin("", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadAgentPluginConfigs([dir])).toEqual({ mcpServers: {} });
    expect(getAgentPluginSummaries([dir])[0]?.serverCount).toBe(0);
  });
});
