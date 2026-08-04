import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

const managers: McpServerManager[] = [];

afterEach(async () => {
  await Promise.all(managers.map(manager => manager.closeAll()));
  managers.length = 0;
});

const legacyFixture = fileURLToPath(new URL("./fixtures/legacy-no-discover-server.mjs", import.meta.url));
const legacyExitsOnDiscoverFixture = fileURLToPath(new URL("./fixtures/legacy-exits-on-discover-server.mjs", import.meta.url));
const modernFixture = fileURLToPath(new URL("./fixtures/modern-discover-server.mjs", import.meta.url));

describe("McpServerManager protocol negotiation", () => {
  it("defaults to the classic initialize handshake without server/discover", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);

    const connection = await manager.connect("legacy", {
      command: process.execPath,
      args: [legacyFixture],
    });

    expect(connection.status).toBe("connected");
    expect(connection.client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
    expect(connection.tools.map(tool => tool.name)).toEqual(["classic_initialize_reached"]);
  }, 5_000);

  it("auto falls back to classic initialize for a legacy stdio server", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);

    const connection = await manager.connect("legacy-auto", {
      command: process.execPath,
      args: [legacyFixture],
      protocolVersion: "auto",
    });

    expect(connection.status).toBe("connected");
    expect(connection.client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
    expect(connection.tools.map(tool => tool.name)).toEqual(["classic_initialize_reached"]);
  }, 5_000);

  it("keeps traced auto negotiation on the SDK disposable stdio probe path", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);
    manager.setTraceConfig({ enabled: true });

    const connection = await manager.connect("legacy-auto-traced", {
      command: process.execPath,
      args: [legacyExitsOnDiscoverFixture],
      protocolVersion: "auto",
    });

    expect(connection.status).toBe("connected");
    expect(connection.client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
    expect(connection.tools.map(tool => tool.name)).toEqual(["legacy_after_sibling_probe"]);
  }, 5_000);

  it.each(["auto", "2026-07-28"] as const)("connects to a modern stdio server in %s mode", async protocolVersion => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);

    const connection = await manager.connect(`modern-${protocolVersion}`, {
      command: process.execPath,
      args: [modernFixture],
      protocolVersion,
    });

    expect(connection.status).toBe("connected");
    expect(connection.client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(connection.tools.map(tool => tool.name)).toEqual(["modern_discovery_reached"]);
  }, 5_000);

  it("does not fall back when 2026-07-28 is pinned against a legacy server", async () => {
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);

    await expect(manager.connect("legacy-pinned", {
      command: process.execPath,
      args: [legacyFixture],
      protocolVersion: "2026-07-28",
    })).rejects.toThrow();
  }, 5_000);

  it("rejects an invalid runtime protocolVersion", async () => {
    const manager = new McpServerManager();
    managers.push(manager);

    await expect(manager.connect("invalid", {
      command: process.execPath,
      args: [legacyFixture],
      protocolVersion: "future" as never,
    })).rejects.toThrow("Invalid MCP protocolVersion: future");
  });
});
