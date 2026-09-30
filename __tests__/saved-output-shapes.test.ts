import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMcp, updateMetadataCache, updateServerMetadata } from "../init.ts";
import { computeServerHash, getMetadataCachePath, loadMetadataCache, saveMetadataCache } from "../metadata-cache.ts";
import { executeCall, executeDescribe } from "../proxy-modes.ts";

const definition = { command: "node", args: ["demo-server"] };
const tool = { name: "list", description: "List things", inputSchema: { type: "object" } };
const result = { content: [], structuredContent: { id: "secret-id", title: "Private title" } };
const describeText = (state: any) => executeDescribe(state, "demo_list").content[0]!.text;

function sessionState(tools: object[], scriptTool: boolean, toolListHints?: { cacheScope: "private" }) {
  const connection = { status: "connected", tools, toolListHints, resources: [], client: { callTool: vi.fn(async () => result) } };
  return {
    config: { mcpServers: { demo: definition } },
    manager: {
      getConnection: () => connection,
      touch() {}, incrementInFlight() {}, decrementInFlight() {}, getRequestOptions() {},
    },
    toolMetadata: new Map([["demo", [{ name: "demo_list", originalName: "list", description: "List things", inputSchema: { type: "object" } }]]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    scriptTool,
  } as any;
}

describe("saved output shapes", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-mcp-saved-shapes-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    saveMetadataCache({ version: 1, servers: { demo: { configHash: computeServerHash(definition), tools: [tool], resources: [], cachedAt: Date.now() } } });
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives a script session's shape to the next session before the tool is called", async () => {
    await executeCall(sessionState([tool], false), "demo_list", {});
    expect(loadMetadataCache()!.servers.demo!.outputShapes).toBeUndefined();

    await executeCall(sessionState([tool], true), "demo_list", {});
    expect(JSON.stringify(loadMetadataCache())).not.toMatch(/secret-id|Private title/);

    const next = await initializeMcp({ getFlag: vi.fn() } as any, {
      cwd: dir, hasUI: false, mode: "print", signal: new AbortController().signal,
    } as any, undefined, { config: { mcpServers: { demo: definition } } });
    try {
      expect(describeText(next)).toContain("Observed output (structuredContent, from earlier calls, not a contract):\n{ id: string; title: string; }");
    } finally {
      await next.owner.stop("test cleanup");
    }
  });

  it("ties each session's shape to the tool definition that session sees", async () => {
    const changedTool = { ...tool, description: "List things, now paginated" };
    const reconnect = (session: any, tools: object[]) => {
      session.manager.getConnection("demo").tools = tools;
      updateServerMetadata(session, "demo");
      updateMetadataCache(session, "demo");
    };
    const state = sessionState([tool], true);
    await executeCall(state, "demo_list", {});
    const other = sessionState([tool], true);
    updateMetadataCache(other, "demo");
    expect(describeText(other)).toContain("{ id: string; title: string; }");

    // Another session sees a changed definition; this session's own connection is unchanged.
    reconnect(other, [changedTool]);
    expect(describeText(other)).not.toContain("Observed output");
    updateMetadataCache(state, "demo");
    expect(describeText(state)).toContain("{ id: string; title: string; }");

    // This session then reconnects to the changed definition the other session already cached.
    updateMetadataCache(other, "demo");
    reconnect(state, [changedTool]);
    expect(describeText(state)).not.toContain("Observed output");
    expect(loadMetadataCache()!.servers.demo!.outputShapes).toBeUndefined();
  });

  it("keeps no shapes from a private tool listing for other sessions", async () => {
    const noSavedShape = () => expect(loadMetadataCache()!.servers.demo!.outputShapes).toBeUndefined();
    // The cached entry is public, as another session with a public listing would write it.
    const privateSession = sessionState([tool], true, { cacheScope: "private" });
    await executeCall(privateSession, "demo_list", {});
    noSavedShape();

    // The private shape stays private after the listing turns public, even when a new field changes it.
    privateSession.manager.getConnection("demo").toolListHints = undefined;
    privateSession.manager.getConnection("demo").client.callTool.mockResolvedValueOnce({
      content: [], structuredContent: { ...result.structuredContent, owner: "Private owner" },
    });
    await executeCall(privateSession, "demo_list", {});
    noSavedShape();

    // A listing that turns private while the call runs counts as private.
    const flipping = sessionState([tool], true);
    const connection = flipping.manager.getConnection("demo");
    connection.client.callTool.mockImplementationOnce(async () => {
      connection.toolListHints = { cacheScope: "private" };
      return result;
    });
    await executeCall(flipping, "demo_list", {});
    noSavedShape();

    // A shape saved while the listing was public is not handed on once the listing is private.
    await executeCall(sessionState([tool], true), "demo_list", {});
    expect(loadMetadataCache()!.servers.demo!.outputShapes).toBeDefined();
    saveMetadataCache({ version: 1, servers: { demo: { ...loadMetadataCache()!.servers.demo!, cacheScope: "private" } } });
    const other = sessionState([tool], true);
    updateMetadataCache(other, "demo");
    expect(describeText(other)).not.toContain("Observed output");
  });

  it("ignores a malformed saved shape instead of failing startup", async () => {
    // Written as text: JSON.stringify overflows the stack at this depth on Node 22, while JSON.parse does not.
    const shape = '{"anyOf":[{"type":"string"},'.repeat(20_000) + '{"type":"number"}' + "]}".repeat(20_000);
    const entry = loadMetadataCache()!.servers.demo!;
    const cache = JSON.stringify({ version: 1, servers: { demo: { ...entry, outputShapes: { list: { source: "structuredContent", shape: "SHAPE" } } } } });
    writeFileSync(getMetadataCachePath(), cache.replace('"SHAPE"', shape));

    const next = await initializeMcp({ getFlag: vi.fn() } as any, {
      cwd: dir, hasUI: false, mode: "print", signal: new AbortController().signal,
    } as any, undefined, { config: { mcpServers: { demo: definition } } });
    try {
      expect(describeText(next)).not.toContain("Observed output");
    } finally {
      await next.owner.stop("test cleanup");
    }
  });
});
