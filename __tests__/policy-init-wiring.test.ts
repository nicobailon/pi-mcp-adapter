import os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  readFileSync: vi.fn<(path: string, encoding?: string) => string>(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: fsMock.existsSync,
  readFileSync: fsMock.readFileSync,
  writeFileSync: fsMock.writeFileSync,
  mkdirSync: fsMock.mkdirSync,
  renameSync: fsMock.renameSync,
}));

import { initializeMcp } from "../init.js";

function makePiStub() {
  return {
    getFlag: vi.fn().mockReturnValue(undefined),
    sendMessage: vi.fn(),
    registerTool: vi.fn(),
  } as any;
}

function makeCtxStub() {
  return {
    hasUI: false,
  } as any;
}

describe("policy validation during adapter initialization", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ["node", "pi"];
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockImplementation((path: string) => {
      throw new Error(`ENOENT: ${path}`);
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("fails fast when startup config contains an invalid policy", async () => {
    const defaultConfigPath = `${os.homedir()}/.pi/agent/mcp.json`;
    const invalidConfig = JSON.stringify({
      mcpServers: {
        "test-server": {
          command: "echo",
          args: ["hello"],
          policy: {
            forbidKeys: ["secret"],
            requireKeys: ["secret"],
          },
        },
      },
    });

    fsMock.existsSync.mockImplementation((p: string) => p === defaultConfigPath);
    fsMock.readFileSync.mockImplementation((p: string) => {
      if (p === defaultConfigPath) return invalidConfig;
      throw new Error(`ENOENT: ${p}`);
    });

    await expect(initializeMcp(makePiStub(), makeCtxStub())).rejects.toThrow(
      /forbidKeys.*requireKeys|requireKeys.*forbidKeys|both/i
    );
  });
});
