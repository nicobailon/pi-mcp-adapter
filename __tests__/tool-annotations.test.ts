import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMetadataCache, reconstructToolMetadata, saveMetadataCache, serializeTools } from "../metadata-cache.ts";
import { buildToolMetadata } from "../tool-metadata.ts";
import { executeDescribe } from "../proxy-modes.ts";
import { runMcpScript } from "../mcp-code.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { McpTool } from "../types.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-mcp-annotations-"));
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

it("keeps declared tool hints through a cache reload and shows them only in describe", async () => {
  const definition = { command: "unused" };
  const tools = [
    {
      name: "drop", inputSchema: { type: "object" },
      annotations: { title: "Drop\ntable", readOnlyHint: false, destructiveHint: true, idempotentHint: "yes" },
    },
    { name: "list", inputSchema: { type: "object" } },
  ] as McpTool[];
  const fresh = buildToolMetadata(tools, [], definition, "demo", "server").metadata;
  saveMetadataCache({ version: 1, servers: { demo: { configHash: "hash", tools: serializeTools(tools), resources: [], cachedAt: Date.now() } } });
  const cached = reconstructToolMetadata("demo", loadMetadataCache()!.servers.demo!, "server", definition);
  expect(cached).toEqual(fresh);

  const state = {
    manager: new McpServerManager(),
    config: { settings: {}, mcpServers: { demo: definition } },
    toolMetadata: new Map([["demo", cached]]), failureTracker: new Map(),
  } as McpExtensionState;
  const describeText = (name: string) => (executeDescribe(state, name).content[0] as { text: string }).text;
  expect(describeText("demo_drop")).toContain('Hints: not read-only, destructive, title "Drop\\ntable"\n');
  expect(describeText("demo_list")).not.toContain("Hints:");

  const scriptDescribe = async (path: string) => {
    const result = await runMcpScript(state, `return await tools.describe({ path: "${path}" });`);
    return JSON.parse(result.content.filter(block => block.type === "text").at(-1)!.text);
  };
  expect((await scriptDescribe("demo_drop")).annotations).toEqual({ title: "Drop\ntable", readOnlyHint: false, destructiveHint: true });
  expect(await scriptDescribe("demo_list")).not.toHaveProperty("annotations");
});
