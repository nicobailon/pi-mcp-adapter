import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMetadataCache, reconstructToolMetadata, saveMetadataCache, serializeTools } from "../metadata-cache.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { runMcpScript } from "../mcp-code.ts";
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
      const result = await runMcpScript(state, 'return await tools.describe({ path: "demo_info" });');
      const text = result.content.filter(block => block.type === "text").at(-1)!;
      const descriptor = JSON.parse(text.text);
      expect(descriptor).toEqual({
        path: "demo_info", name: "info", server: "demo", inputTypeScript: "{}",
        ...(outputSchema !== undefined ? { outputSchema, outputSchemaTarget: "data.structuredContent" } : {}),
      });
    }
  });
});
