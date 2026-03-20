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

import { getServerProvenance } from "../config.js";

describe("getServerProvenance multi-file provenance", () => {
  const originalWarn = console.warn;
  let files: Record<string, string>;

  beforeEach(() => {
    files = {};
    fsMock.existsSync.mockImplementation((path: string) => path in files);
    fsMock.readFileSync.mockImplementation((path: string) => {
      if (!(path in files)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return files[path];
    });
    console.warn = vi.fn();
  });

  afterEach(() => {
    console.warn = originalWarn;
    vi.restoreAllMocks();
  });

  it("tracks the source file for each server across multiple override files", () => {
    files["/a.json"] = JSON.stringify({
      mcpServers: { alpha: { command: "a" } },
    });
    files["/b.json"] = JSON.stringify({
      mcpServers: { beta: { command: "b" } },
    });

    const provenance = getServerProvenance(["/a.json", "/b.json"]);

    expect(provenance.get("alpha")).toEqual({ path: "/a.json", kind: "user" });
    expect(provenance.get("beta")).toEqual({ path: "/b.json", kind: "user" });
  });

  it("uses the later file as provenance when the same server is overridden", () => {
    files["/a.json"] = JSON.stringify({
      mcpServers: { playwright: { command: "old" } },
    });
    files["/b.json"] = JSON.stringify({
      mcpServers: { playwright: { command: "new" } },
    });

    const provenance = getServerProvenance(["/a.json", "/b.json"]);

    expect(provenance.get("playwright")).toEqual({ path: "/b.json", kind: "user" });
  });
});
