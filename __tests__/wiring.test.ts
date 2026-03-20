import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

function readSource(file: string): string {
  return readFileSync(resolve(import.meta.dirname, "..", file), "utf-8");
}

describe("multi-config call-site wiring", () => {
  it("index.ts imports getConfigPathsFromArgv instead of getConfigPathFromArgv", () => {
    const source = readSource("index.ts");

    expect(source).toMatch(/import\s+\{[^}]*getConfigPathsFromArgv[^}]*\}\s+from\s+"\.\/utils\.js";/);
    expect(source).not.toContain('import { getConfigPathFromArgv } from "./utils.js";');
  });

  it("index.ts passes earlyConfigPaths into loadMcpConfig", () => {
    const source = readSource("index.ts");

    expect(source).toContain("const earlyConfigPaths = getConfigPathsFromArgv();");
    expect(source).toContain("const earlyConfig = loadMcpConfig(earlyConfigPaths);");
    expect(source).not.toContain("const earlyConfigPath = getConfigPathFromArgv();");
    expect(source).not.toContain("const earlyConfig = loadMcpConfig(earlyConfigPath);");
  });

  it("index.ts describes the mcp-config flag as supporting repeated paths", () => {
    const source = readSource("index.ts");

    expect(source).toMatch(/description:\s*"[^"]*(Path\(s\)|can be repeated)[^"]*"/);
  });

  it("init.ts uses getConfigPathsFromArgv so repeated mcp-config flags are preserved", () => {
    const source = readSource("init.ts");

    expect(source).toContain('import { getConfigPathsFromArgv, openUrl, parallelLimit } from "./utils.js";');
    expect(source).toContain('const configPaths = getConfigPathsFromArgv();');
    expect(source).toContain('const config = loadMcpConfig(configPaths);');
    expect(source).not.toContain('parseConfigFlag(pi.getFlag("mcp-config"))');
  });

  it("commands.ts uses getConfigPathsFromArgv-derived config paths for provenance so repeated flags survive end-to-end", () => {
    const source = readSource("commands.ts");

    expect(source).toMatch(/import\s+\{[^}]*getConfigPathsFromArgv[^}]*\}\s+from\s+"\.\/utils\.js";/);
    expect(source).toContain('const configPaths = getConfigPathsFromArgv();');
    expect(source).toContain('const provenanceMap = getServerProvenance(configPaths);');
    expect(source).not.toContain('parseConfigFlag(pi.getFlag("mcp-config"))');
    expect(source).not.toContain('configOverridePath');
  });
});
