import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(path: string) => boolean>(),
  readFileSync: vi.fn<(path: string, encoding: string) => string>(),
}));

vi.mock("node:fs", () => ({
  existsSync: fsMock.existsSync,
  readFileSync: fsMock.readFileSync,
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

import os from "node:os";
import { loadMcpConfig } from "../config.js";

const cwd = process.cwd();
const defaultConfigPath = `${os.homedir()}/.pi/agent/mcp.json`;
const projectConfigPath = `${cwd}/.pi/mcp.json`;

describe("loadMcpConfig multi-file merge", () => {
  const originalArgv = process.argv;
  const originalWarn = console.warn;
  let files: Record<string, string>;
  let warnSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.argv = [...originalArgv];
    files = {};
    fsMock.existsSync.mockImplementation((path: string) => path in files);
    fsMock.readFileSync.mockImplementation((path: string) => {
      if (!(path in files)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return files[path];
    });
    warnSpy = vi.fn();
    console.warn = warnSpy;
  });

  afterEach(() => {
    process.argv = originalArgv;
    console.warn = originalWarn;
    vi.restoreAllMocks();
  });

  it("loads a single file from an array override", () => {
    files["/one.json"] = JSON.stringify({
      mcpServers: { one: { command: "node" } },
    });

    expect(loadMcpConfig(["/one.json"])).toEqual({
      mcpServers: { one: { command: "node" } },
    });
  });

  it("loads multiple files and merges servers", () => {
    files["/a.json"] = JSON.stringify({
      mcpServers: { alpha: { command: "a" } },
    });
    files["/b.json"] = JSON.stringify({
      mcpServers: { beta: { command: "b" } },
    });

    expect(loadMcpConfig(["/a.json", "/b.json"]).mcpServers).toEqual({
      alpha: { command: "a" },
      beta: { command: "b" },
    });
  });

  it("lets later files override the same server", () => {
    files["/a.json"] = JSON.stringify({
      mcpServers: { playwright: { command: "old", args: ["--stdio"] } },
    });
    files["/b.json"] = JSON.stringify({
      mcpServers: { playwright: { command: "new", args: ["serve"] } },
    });

    expect(loadMcpConfig(["/a.json", "/b.json"]).mcpServers.playwright).toEqual({
      command: "new",
      args: ["serve"],
    });
  });

  it("merges settings shallowly across files", () => {
    files["/a.json"] = JSON.stringify({
      mcpServers: {},
      settings: { toolPrefix: "short" },
    });
    files["/b.json"] = JSON.stringify({
      mcpServers: {},
      settings: { idleTimeout: 30 },
    });

    expect(loadMcpConfig(["/a.json", "/b.json"]).settings).toEqual({
      toolPrefix: "short",
      idleTimeout: 30,
    });
  });

  it("merges imports as a deduplicated union", () => {
    files["/a.json"] = JSON.stringify({
      mcpServers: {},
      imports: ["cursor"],
    });
    files["/b.json"] = JSON.stringify({
      mcpServers: {},
      imports: ["claude-code", "cursor"],
    });

    expect(loadMcpConfig(["/a.json", "/b.json"]).imports).toEqual(["cursor", "claude-code"]);
  });

  it("skips missing files gracefully and loads existing ones", () => {
    files["/exists.json"] = JSON.stringify({
      mcpServers: { only: { command: "node" } },
    });

    expect(loadMcpConfig(["/missing.json", "/exists.json"]).mcpServers).toEqual({
      only: { command: "node" },
    });
  });

  it("falls back to the default config when given an empty array", () => {
    files[defaultConfigPath] = JSON.stringify({
      mcpServers: { defaulted: { command: "node" } },
    });

    expect(loadMcpConfig([])).toEqual(loadMcpConfig(undefined));
  });

  it("still accepts a string override path", () => {
    files["/single.json"] = JSON.stringify({
      mcpServers: { single: { command: "node" } },
    });

    expect(loadMcpConfig("/single.json").mcpServers).toEqual({
      single: { command: "node" },
    });
  });

  it("skips invalid JSON files, warns, and still loads valid files", () => {
    files["/bad.json"] = "{";
    files["/good.json"] = JSON.stringify({
      mcpServers: { good: { command: "node" } },
    });

    expect(loadMcpConfig(["/bad.json", "/good.json"]).mcpServers).toEqual({
      good: { command: "node" },
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  it("lets project config override merged multi-file config", () => {
    files["/a.json"] = JSON.stringify({
      mcpServers: { playwright: { command: "a" }, alpha: { command: "alpha" } },
    });
    files["/b.json"] = JSON.stringify({
      mcpServers: { playwright: { command: "b" }, beta: { command: "beta" } },
    });
    files[projectConfigPath] = JSON.stringify({
      mcpServers: { playwright: { command: "project" } },
    });

    expect(loadMcpConfig(["/a.json", "/b.json"]).mcpServers).toEqual({
      alpha: { command: "alpha" },
      beta: { command: "beta" },
      playwright: { command: "project" },
    });
  });
});
