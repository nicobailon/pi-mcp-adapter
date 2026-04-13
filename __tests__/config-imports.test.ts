import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

describe("loadMcpConfig imports", () => {
  let homeDir: string;
  let cwd: string;
  let previousCwd: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "pi-mcp-home-"));
    cwd = mkdtempSync(join(tmpdir(), "pi-mcp-cwd-"));
    previousCwd = process.cwd();
    process.chdir(cwd);

    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return {
        ...actual,
        homedir: () => homeDir,
      };
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    vi.doUnmock("node:os");
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("imports opencode servers from ~/.config/opencode/opencode.json", async () => {
    writeJson(join(homeDir, ".pi", "agent", "mcp.json"), {
      imports: ["opencode"],
      mcpServers: {
        localOverride: {
          command: "node",
          args: ["server.js"],
        },
      },
    });

    writeJson(join(homeDir, ".config", "opencode", "opencode.json"), {
      mcp: {
        localServer: {
          type: "local",
          command: ["npx", "-y", "example-mcp"],
          environment: {
            API_KEY: "secret",
          },
          enabled: true,
        },
        remoteServer: {
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer token",
          },
          oauth: {
            clientId: "client-id",
          },
        },
        disabledServer: {
          type: "local",
          command: ["npx", "disabled-mcp"],
          enabled: false,
        },
      },
    });

    const { loadMcpConfig } = await import("../config.ts");
    const config = loadMcpConfig();

    expect(config.mcpServers.localOverride).toEqual({
      command: "node",
      args: ["server.js"],
    });
    expect(config.mcpServers.localServer).toEqual({
      command: "npx",
      args: ["-y", "example-mcp"],
      env: {
        API_KEY: "secret",
      },
    });
    expect(config.mcpServers.remoteServer).toEqual({
      url: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer token",
      },
      auth: "oauth",
    });
    expect(config.mcpServers.disabledServer).toBeUndefined();
  });
});
