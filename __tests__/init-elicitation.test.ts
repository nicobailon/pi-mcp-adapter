import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { McpConfig } from "../types.ts";

function writeConfig(config: McpConfig): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-elicitation-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  return path;
}

function createPi(configPath: string) {
  return {
    getFlag: () => configPath,
    sendMessage: () => undefined,
  } as any;
}

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    cwd: process.cwd(),
    hasUI: true,
    ui: { confirm: async () => true },
    modelRegistry: {},
    model: undefined,
    signal: undefined,
    ...overrides,
  } as any;
}

describe("initializeMcp elicitation config", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("enables elicitation by default when a trusted UI exists", async () => {
    const { initializeMcp } = await import("../init.ts");
    const configPath = writeConfig({ mcpServers: {} });
    const ui = { confirm: async () => true };

    const state = await initializeMcp(createPi(configPath), createContext({ ui }));

    expect((state.manager as any).elicitationConfig).toEqual({
      ui,
      timeoutMs: undefined,
    });
  });

  it("passes through custom elicitation timeout settings", async () => {
    const { initializeMcp } = await import("../init.ts");
    const configPath = writeConfig({
      settings: { elicitationTimeoutMs: 120000 },
      mcpServers: {},
    });

    const state = await initializeMcp(createPi(configPath), createContext());

    expect((state.manager as any).elicitationConfig.timeoutMs).toBe(120000);
  });

  it("does not enable elicitation when disabled by settings", async () => {
    const { initializeMcp } = await import("../init.ts");
    const configPath = writeConfig({
      settings: { elicitation: false },
      mcpServers: {},
    });

    const state = await initializeMcp(createPi(configPath), createContext());

    expect((state.manager as any).elicitationConfig).toBeUndefined();
  });

  it("does not enable elicitation without a trusted UI", async () => {
    const { initializeMcp } = await import("../init.ts");
    const configPath = writeConfig({ mcpServers: {} });

    const state = await initializeMcp(createPi(configPath), createContext({ hasUI: false, ui: undefined }));

    expect((state.manager as any).elicitationConfig).toBeUndefined();
  });
});
