import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServerManager } from "../server-manager.ts";

const managers: McpServerManager[] = [];
const temporaryDirectories: string[] = [];
const environmentKeys = [
  "PI_MCP_ENV_AUDIT_SENTINEL_X9",
  "PI_MCP_ENV_AUDIT_SELECTED_X9",
  "PI_MCP_ENV_AUDIT_INTERPOLATED_X9",
  "PI_MCP_ENV_AUDIT_LITERAL_X9",
] as const;
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));

function readEnvironmentReports(path: string): Array<Record<string, string>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, string>);
}

afterEach(async () => {
  await Promise.all(managers.map(manager => manager.closeAll()));
  managers.length = 0;
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
  for (const key of environmentKeys) {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

  it("controls arbitrary stdio environment inheritance while preserving explicit env behavior", async () => {
    process.env.PI_MCP_ENV_AUDIT_SENTINEL_X9 = "host-sentinel";
    delete process.env.PI_MCP_ENV_AUDIT_SELECTED_X9;
    delete process.env.PI_MCP_ENV_AUDIT_INTERPOLATED_X9;
    delete process.env.PI_MCP_ENV_AUDIT_LITERAL_X9;

    const directory = mkdtempSync(join(tmpdir(), "pi-mcp-env-"));
    temporaryDirectories.push(directory);
    const reportPath = join(directory, "environment.jsonl");
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);

    await manager.connect("default", {
      command: process.execPath,
      args: [legacyExitsOnDiscoverFixture, reportPath],
    });
    await manager.connect("true", {
      command: process.execPath,
      args: [legacyExitsOnDiscoverFixture, reportPath],
      inheritEnv: true,
    });
    await manager.connect("false", {
      command: process.execPath,
      args: [legacyExitsOnDiscoverFixture, reportPath],
      inheritEnv: false,
      env: {
        PI_MCP_ENV_AUDIT_SELECTED_X9: "selected-value",
        PI_MCP_ENV_AUDIT_INTERPOLATED_X9: "${PI_MCP_ENV_AUDIT_SENTINEL_X9}",
      },
    });
    await manager.connect("literal", {
      command: process.execPath,
      args: [legacyExitsOnDiscoverFixture, reportPath],
      inheritEnv: false,
      literalEnv: true,
      env: {
        PI_MCP_ENV_AUDIT_LITERAL_X9: "${PI_MCP_ENV_AUDIT_SENTINEL_X9}",
      },
    });

    expect(readEnvironmentReports(reportPath)).toEqual([
      { inherited: "present", selected: "absent", interpolated: "absent", literal: "absent" },
      { inherited: "present", selected: "absent", interpolated: "absent", literal: "absent" },
      { inherited: "absent", selected: "selected", interpolated: "interpolated", literal: "absent" },
      { inherited: "absent", selected: "absent", interpolated: "absent", literal: "literal" },
    ]);
  }, 5_000);

  it("passes the opt-out environment to both auto-negotiation stdio processes", async () => {
    process.env.PI_MCP_ENV_AUDIT_SENTINEL_X9 = "host-sentinel";
    delete process.env.PI_MCP_ENV_AUDIT_SELECTED_X9;
    delete process.env.PI_MCP_ENV_AUDIT_INTERPOLATED_X9;
    delete process.env.PI_MCP_ENV_AUDIT_LITERAL_X9;

    const directory = mkdtempSync(join(tmpdir(), "pi-mcp-env-auto-"));
    temporaryDirectories.push(directory);
    const reportPath = join(directory, "environment.jsonl");
    const manager = new McpServerManager();
    managers.push(manager);
    manager.setDefaultRequestTimeoutMs(1_000);

    await manager.connect("auto", {
      command: process.execPath,
      args: [legacyExitsOnDiscoverFixture, reportPath],
      protocolVersion: "auto",
      inheritEnv: false,
      env: { PI_MCP_ENV_AUDIT_SELECTED_X9: "selected-value" },
    });

    expect(readEnvironmentReports(reportPath)).toEqual([
      { inherited: "absent", selected: "selected", interpolated: "absent", literal: "absent" },
      { inherited: "absent", selected: "selected", interpolated: "absent", literal: "absent" },
    ]);
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
