import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMetadataCache, reconstructToolMetadata, saveMetadataCache, serializeTools } from "../metadata-cache.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { executeDescribe } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { McpTool, ServerCacheEntry } from "../types.ts";

describe("cached output schema discovery", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-cache-output-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("describes old, newly advertised, changed, and removed schemas after cache reload", async () => {
    const definition = { command: "unused" };
    const schemas: Array<McpTool["outputSchema"]> = [
      undefined,
      { type: "object", properties: { hostname: { type: "string" } }, required: ["hostname"] },
      { type: "object", allOf: [{ properties: { totalBytes: { type: "number" } } }] },
      undefined,
    ];
    for (const outputSchema of schemas) {
      const tools: McpTool[] = [{
        name: "info", inputSchema: { type: "object" },
        ...(outputSchema !== undefined ? { outputSchema } : {}),
      }];
      const fresh = buildToolMetadata(tools, [], definition, "demo", "server").metadata;
      const entry: ServerCacheEntry = {
        configHash: "hash", tools: serializeTools(tools), resources: [], cachedAt: Date.now(),
      };
      saveMetadataCache({ version: 1, servers: { demo: entry } });
      const loaded = loadMetadataCache()!.servers.demo!;
      const cached = reconstructToolMetadata("demo", loaded, "server", definition);
      expect(cached).toEqual(fresh);
      const state = {
        manager: new McpServerManager(),
        config: { settings: {}, mcpServers: { demo: definition } },
        toolMetadata: new Map([["demo", cached]]), failureTracker: new Map(),
      } as McpExtensionState;
      const result = executeDescribe(state, "demo_info");
      expect(result.content[0]!.text).toContain("Server: demo\n");
      expect(result.content[0]!.text).toContain("\nShape:\n{}");
      expect(result.details.server).toBe("demo");
      expect(result.details.tool).toMatchObject({ name: "demo_info", originalName: "info", inputSchema: { type: "object" } });
      if (outputSchema === undefined) expect(result.details.tool).not.toHaveProperty("outputSchema");
      else expect(result.details.tool.outputSchema).toEqual(outputSchema);
    }
  });
});
