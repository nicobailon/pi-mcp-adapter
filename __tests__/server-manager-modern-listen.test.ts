import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateMetadataCache, updateServerMetadata } from "../init.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";

const fixture = fileURLToPath(new URL("./fixtures/modern-listen-server.mjs", import.meta.url));
const managers: McpServerManager[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for modern listen fixture");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function control(connection: Awaited<ReturnType<McpServerManager["connect"]>>, action: string) {
  return connection.client.callTool({ name: "fixture_control", arguments: { action } });
}

function report(result: Awaited<ReturnType<typeof control>>): { listenCount: number; filter: Record<string, unknown> } {
  const text = result.content?.find(block => block.type === "text")?.text;
  if (!text) throw new Error("Fixture report was missing text");
  return JSON.parse(text) as { listenCount: number; filter: Record<string, unknown> };
}

afterEach(async () => {
  await Promise.all(managers.map(manager => manager.closeAll()));
  managers.length = 0;
  vi.restoreAllMocks();
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("McpServerManager modern subscriptions/listen", () => {
  it("publishes tools, prompts, and resources list changes to metadata and disk cache", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-listen-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const definition = {
      command: process.execPath,
      args: [fixture],
      protocolVersion: "2026-07-28" as const,
    };
    const state = {
      manager,
      config: { mcpServers: { modern: definition } },
      toolMetadata: new Map(),
      resourceCounts: new Map(),
      promptMetadata: new Map(),
      promptMetadataLive: new Set(),
      serverInstructions: new Map(),
    } as any;
    const reasons: string[] = [];
    manager.setMetadataListChangedListener((serverName, reason) => {
      reasons.push(reason);
      updateServerMetadata(state, serverName);
      updateMetadataCache(state, serverName, { preserveEmptyResources: false });
    });

    try {
      const connection = await manager.connect("modern", definition);
      expect(connection.listenState).toBe("active");
      expect(connection.listenFilter).toEqual({
        toolsListChanged: true,
        promptsListChanged: true,
        resourcesListChanged: true,
      });

      await control(connection, "mutate");
      await waitFor(() => reasons.length === 3);

      expect(connection.tools.map(tool => tool.name)).toContain("updated_tool");
      expect(connection.prompts.map(prompt => prompt.name)).toEqual(["updated_prompt"]);
      expect(connection.resources.map(resource => resource.uri)).toEqual(["ui://fixture/updated"]);
      expect(state.toolMetadata.get("modern").map((tool: { originalName: string }) => tool.originalName))
        .toContain("updated_tool");
      expect(reasons).toEqual(expect.arrayContaining([
        "tools-list-changed",
        "prompts-list-changed",
        "resources-list-changed",
      ]));

      const cache = JSON.parse(readFileSync(join(agentDir, "mcp-cache.json"), "utf8"));
      expect(cache.servers.modern.tools.map((tool: { name: string }) => tool.name)).toContain("updated_tool");
      expect(cache.servers.modern.prompts).toEqual([{ name: "updated_prompt" }]);
      expect(cache.servers.modern.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ uri: "ui://fixture/updated" }),
      ]));
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 5_000);

  it("marks only a remote listen close as dropped and repairs once at the next activity boundary", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const connection = await manager.connect("modern", {
      command: process.execPath,
      args: [fixture],
      protocolVersion: "2026-07-28",
    });

    expect(report(await control(connection, "report")).listenCount).toBe(1);
    await control(connection, "drop");
    await waitFor(() => connection.listenState === "dropped");
    expect(connection.status).toBe("connected");

    await Promise.all([
      manager.ensureListen("modern", connection),
      manager.ensureListen("modern", connection),
      manager.ensureListen("modern", connection),
    ]);
    expect(connection.listenState).toBe("active");
    expect(report(await control(connection, "report")).listenCount).toBe(2);
  }, 5_000);

  it("reconciles catalog changes missed while the listen was dropped", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const state = {
      manager,
      config: { mcpServers: { modern: { command: process.execPath, args: [fixture], protocolVersion: "2026-07-28" } } },
      toolMetadata: new Map(),
      resourceCounts: new Map(),
      promptMetadata: new Map(),
      promptMetadataLive: new Set(),
      serverInstructions: new Map(),
    } as any;
    const reasons: string[] = [];
    manager.setMetadataListChangedListener((serverName, reason) => {
      reasons.push(reason);
      updateServerMetadata(state, serverName);
    });
    const connection = await manager.connect("modern", state.config.mcpServers.modern);
    updateServerMetadata(state, "modern");
    expect(state.toolMetadata.get("modern").map((tool: { originalName: string }) => tool.originalName)).not.toContain("updated_tool");

    await control(connection, "drop");
    await waitFor(() => connection.listenState === "dropped");
    await control(connection, "mutate-silent");
    await manager.ensureListen("modern", connection);

    expect(connection.listenState).toBe("active");
    expect(connection.tools.map(tool => tool.name)).toContain("updated_tool");
    expect(connection.prompts.map(prompt => prompt.name)).toEqual(["updated_prompt"]);
    expect(connection.resources.map(resource => resource.uri)).toEqual(["ui://fixture/updated"]);
    expect(state.toolMetadata.get("modern").map((tool: { originalName: string }) => tool.originalName)).toContain("updated_tool");
    expect(reasons).toContain("listen-recovered");
  }, 5_000);

  it("keeps the recovered listen active when optional catalog confirmation fails", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const definition = { command: process.execPath, args: [fixture], protocolVersion: "2026-07-28" as const };
    const state = {
      manager,
      config: { mcpServers: { modern: definition } },
      toolMetadata: new Map(),
      resourceCounts: new Map(),
      promptMetadata: new Map(),
      promptMetadataLive: new Set(),
      serverInstructions: new Map(),
    } as any;
    manager.setMetadataListChangedListener((serverName) => updateServerMetadata(state, serverName));
    const connection = await manager.connect("modern", definition);
    updateServerMetadata(state, "modern");

    await control(connection, "drop");
    await waitFor(() => connection.listenState === "dropped");
    await control(connection, "mutate-silent");
    await control(connection, "fail-next-optional-lists");
    await manager.ensureListen("modern", connection);

    expect(connection.listenState).toBe("active");
    expect(connection.listenCatalogStale).toBe(true);
    expect(report(await control(connection, "report")).listenCount).toBe(2);
    expect(connection.tools.map(tool => tool.name)).toContain("updated_tool");
    expect(connection.prompts.map(prompt => prompt.name)).toEqual(["initial_prompt"]);
    expect(connection.resources.map(resource => resource.uri)).toEqual(["ui://fixture/initial"]);

    connection.listenRetryAfter = Date.now() - 1;
    await manager.ensureListen("modern", connection);
    expect(connection.listenState).toBe("active");
    expect(connection.listenCatalogStale).toBeUndefined();
    expect(report(await control(connection, "report")).listenCount).toBe(2);
    expect(connection.prompts.map(prompt => prompt.name)).toEqual(["updated_prompt"]);
    expect(connection.resources.map(resource => resource.uri)).toEqual(["ui://fixture/updated"]);
  }, 5_000);

  it("repairs before returning tool_not_found for a stale server-scoped catalog", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const definition = { command: process.execPath, args: [fixture], protocolVersion: "2026-07-28" as const };
    const state = {
      manager,
      config: { settings: { toolPrefix: "server" }, mcpServers: { modern: definition } },
      toolMetadata: new Map(),
      resourceCounts: new Map(),
      promptMetadata: new Map(),
      promptMetadataLive: new Set(),
      serverInstructions: new Map(),
      failureTracker: new Map(),
    } as any;
    const connection = await manager.connect("modern", definition);
    updateServerMetadata(state, "modern");

    await control(connection, "drop");
    await waitFor(() => connection.listenState === "dropped");
    await control(connection, "mutate-silent");
    const result = await executeCall(state, "updated_tool", {}, "modern");

    expect(result.details).toMatchObject({ mode: "call", server: "modern", tool: "updated_tool" });
    expect(result.details).not.toMatchObject({ error: "tool_not_found" });
  }, 5_000);

  it("refreshes a resource read after a dropped listen could have missed an update", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const connection = await manager.connect("modern", {
      command: process.execPath,
      args: [fixture],
      protocolVersion: "2026-07-28",
    });

    const first = await manager.readResource("modern", "ui://fixture/initial");
    expect(first.contents?.[0]?.text).toBe("<p>revision 0</p>");
    await control(connection, "drop");
    await waitFor(() => connection.listenState === "dropped");
    await control(connection, "mutate-silent");

    const second = await manager.readResource("modern", "ui://fixture/initial");
    expect(second.contents?.[0]?.text).toBe("<p>revision 1</p>");
  }, 5_000);

  it("bounds a failed repair and suppresses another attempt during cooldown", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(100);
    const connection = await manager.connect("modern", {
      command: process.execPath,
      args: [fixture],
      protocolVersion: "2026-07-28",
    });

    await control(connection, "drop-ignore-next");
    await waitFor(() => connection.listenState === "dropped");
    await expect(Promise.race([
      manager.ensureListen("modern", connection),
      new Promise((_, reject) => setTimeout(() => reject(new Error("repair did not finish")), 1_000)),
    ])).resolves.toBeUndefined();
    expect(connection.listenState).toBe("dropped");
    expect(report(await control(connection, "report")).listenCount).toBe(2);

    await manager.ensureListen("modern", connection);
    expect(report(await control(connection, "report")).listenCount).toBe(2);
  }, 5_000);

  it("does not loop when the server honors only part of a requested filter", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const connection = await manager.connect("modern", {
      command: process.execPath,
      args: [fixture],
      protocolVersion: "2026-07-28",
    });

    await control(connection, "narrow-next-listen");
    await manager.prepareResourceUse("modern", "ui://fixture/recent", connection);
    expect(connection.listenSubscription?.honoredFilter).toEqual({ toolsListChanged: true });
    expect(report(await control(connection, "report")).listenCount).toBe(2);

    await manager.ensureListen("modern", connection);
    expect(report(await control(connection, "report")).listenCount).toBe(2);
  }, 5_000);

  it.each(["local", "graceful"] as const)("does not retry a %s listen close", async cause => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const connection = await manager.connect(`modern-${cause}`, {
      command: process.execPath,
      args: [fixture],
      protocolVersion: "2026-07-28",
    });

    if (cause === "local") await connection.listenSubscription?.close();
    else await control(connection, "graceful");
    await waitFor(() => connection.listenState === "not-listening");

    await manager.ensureListen(`modern-${cause}`, connection);
    expect(connection.listenState).toBe("not-listening");
    expect(report(await control(connection, "report")).listenCount).toBe(1);
  }, 5_000);

  it("subscribes only to recent/open resource URIs and signals matching open sessions", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    const definition = {
      command: process.execPath,
      args: [fixture],
      protocolVersion: "2026-07-28" as const,
    };
    let connection = await manager.connect("modern", definition);
    const matching = vi.fn();
    const other = vi.fn();

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    manager.registerResourceUpdatedListener("matching", "modern", "ui://fixture/initial", matching);
    manager.registerResourceUpdatedListener("other", "modern", "ui://fixture/other", other);
    await waitFor(() => connection.listenState === "active" &&
      connection.listenFilter?.resourceSubscriptions?.length === 2);

    const current = report(await control(connection, "report"));
    expect(current.filter.resourceSubscriptions).toEqual([
      "ui://fixture/initial",
      "ui://fixture/other",
    ]);
    await control(connection, "resource-updated");
    await waitFor(() => matching.mock.calls.length === 1);
    expect(matching).toHaveBeenCalledWith("modern", "ui://fixture/initial");
    expect(other).not.toHaveBeenCalled();

    const previous = connection;
    connection = await manager.reconnect("modern", definition, previous);
    await waitFor(() => connection.listenState === "active" &&
      connection.listenFilter?.resourceSubscriptions?.length === 2);
    expect(report(await control(connection, "report")).filter.resourceSubscriptions).toEqual([
      "ui://fixture/initial",
      "ui://fixture/other",
    ]);

    connection.recentResourceUris = new Map(Array.from({ length: 40 }, (_, index) => [
      `ui://fixture/recent-${index}`,
      now + index,
    ]));
    await manager.ensureListen("modern", connection);
    const bounded = report(await control(connection, "report")).filter.resourceSubscriptions as string[];
    expect(bounded).toHaveLength(32);
    expect(bounded).toContain("ui://fixture/initial");
    expect(bounded).toContain("ui://fixture/other");

    manager.removeResourceUpdatedListener("matching");
    manager.removeResourceUpdatedListener("other");
    vi.mocked(Date.now).mockReturnValue(now + 11 * 60_000);
    await manager.ensureListen("modern", connection);
    expect(report(await control(connection, "report")).filter.resourceSubscriptions).toBeUndefined();
    await control(connection, "resource-updated");
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(matching).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  }, 5_000);
});
