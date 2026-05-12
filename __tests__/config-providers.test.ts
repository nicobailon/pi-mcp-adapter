import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  resolveMcpConfig,
  writeDirectToolsConfig,
} from "../config.js";
import { registerMcpServerProvider } from "../providers.js";

function createPi(): Pick<ExtensionAPI, "events"> {
  const listeners = new Map<string, Array<(data: unknown) => void>>();

  return {
    events: {
      on(event: string, handler: (data: unknown) => void) {
        const current = listeners.get(event) ?? [];
        current.push(handler);
        listeners.set(event, current);
      },
      emit(event: string, data: unknown) {
        for (const handler of listeners.get(event) ?? []) {
          handler(data);
        }
      },
    },
  } as Pick<ExtensionAPI, "events">;
}

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe("extension MCP providers", () => {
  it("merges extension-provided servers before user overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-provider-"));
    const userConfigPath = join(dir, "user-mcp.json");
    process.chdir(dir);

    writeFileSync(
      userConfigPath,
      JSON.stringify({
        mcpServers: {
          demo: {
            directTools: false,
          },
        },
      }),
    );

    const pi = createPi();
    registerMcpServerProvider(pi as ExtensionAPI, () => ({
      source: "pi-mcp-demo",
      servers: {
        demo: {
          command: "npx",
          args: ["-y", "demo-server"],
          directTools: true,
        },
      },
    }));

    const resolved = resolveMcpConfig(pi, userConfigPath);

    expect(resolved.config.mcpServers.demo).toEqual({
      command: "npx",
      args: ["-y", "demo-server"],
      directTools: false,
    });
    expect(resolved.provenance.get("demo")).toEqual({ path: userConfigPath, kind: "user" });
  });

  it("exposes extension provenance for provider-only servers", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-provider-"));
    const userConfigPath = join(dir, "user-mcp.json");
    process.chdir(dir);

    const pi = createPi();
    registerMcpServerProvider(pi as ExtensionAPI, () => ({
      source: "pi-mcp-demo",
      servers: {
        demo: {
          command: "npx",
          args: ["-y", "demo-server"],
          directTools: true,
        },
      },
    }));

    const resolved = resolveMcpConfig(pi, userConfigPath);

    expect(resolved.provenance.get("demo")).toEqual({
      path: userConfigPath,
      kind: "extension",
      extensionSource: "pi-mcp-demo",
    });
  });

  it("writes extension-backed directTools overrides into user config", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-mcp-provider-"));
    const userConfigPath = join(dir, "user-mcp.json");
    process.chdir(dir);
    mkdirSync(join(dir, ".pi"), { recursive: true });

    const pi = createPi();
    registerMcpServerProvider(pi as ExtensionAPI, () => ({
      source: "pi-mcp-demo",
      servers: {
        demo: {
          command: "npx",
          args: ["-y", "demo-server"],
          directTools: true,
        },
      },
    }));

    const resolved = resolveMcpConfig(pi, userConfigPath);

    writeDirectToolsConfig(
      new Map([["demo", false]]),
      resolved.provenance,
      resolved.config,
    );

    const saved = JSON.parse(readFileSync(userConfigPath, "utf-8"));
    expect(saved.mcpServers.demo).toEqual({
      command: "npx",
      args: ["-y", "demo-server"],
      directTools: false,
    });
  });
});
