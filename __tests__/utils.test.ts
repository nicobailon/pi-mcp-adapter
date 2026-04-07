import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getConfigPathFromArgv, getConfigPathsFromArgv, parseConfigFlag } from "../utils.js";

describe("config path parsing", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  describe("getConfigPathsFromArgv", () => {
    it("returns undefined when no --mcp-config flag is present", () => {
      process.argv = ["node", "pi"];

      expect(getConfigPathsFromArgv()).toBeUndefined();
    });

    it("returns a single path after one --mcp-config flag", () => {
      process.argv = ["node", "pi", "--mcp-config", "a.json"];

      expect(getConfigPathsFromArgv()).toEqual(["a.json"]);
    });

    it("returns multiple paths after one --mcp-config flag", () => {
      process.argv = ["node", "pi", "--mcp-config", "a.json", "b.json"];

      expect(getConfigPathsFromArgv()).toEqual(["a.json", "b.json"]);
    });

    it("collects paths from repeated --mcp-config flags", () => {
      process.argv = ["node", "pi", "--mcp-config", "a.json", "--mcp-config", "b.json"];

      expect(getConfigPathsFromArgv()).toEqual(["a.json", "b.json"]);
    });

    it("expands ~ to the current home directory", () => {
      process.argv = ["node", "pi", "--mcp-config", "~/a.json"];

      expect(getConfigPathsFromArgv()).toEqual([`${os.homedir()}/a.json`]);
    });

    it("stops collecting paths at the next flag", () => {
      process.argv = ["node", "pi", "--mcp-config", "a.json", "--other"];

      expect(getConfigPathsFromArgv()).toEqual(["a.json"]);
    });
  });

  describe("getConfigPathFromArgv", () => {
    it("returns the first parsed config path for legacy compatibility", () => {
      process.argv = ["node", "pi", "--mcp-config", "~/a.json", "b.json"];

      expect(getConfigPathFromArgv()).toBe(`${os.homedir()}/a.json`);
    });
  });

  describe("parseConfigFlag", () => {
    it("preserves a string flag as a single config path", () => {
      expect(parseConfigFlag("a.json")).toEqual(["a.json"]);
    });

    it("preserves spaces inside a single config path", () => {
      expect(parseConfigFlag("~/Library/Application Support/mcp.json")).toEqual([
        `${os.homedir()}/Library/Application Support/mcp.json`,
      ]);
    });

    it("returns undefined when the flag is undefined", () => {
      expect(parseConfigFlag(undefined)).toBeUndefined();
    });
  });
});
