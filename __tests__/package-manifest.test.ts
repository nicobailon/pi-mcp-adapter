import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  name?: string;
  version?: string;
  files?: string[];
  exports?: Record<string, unknown>;
  bin?: Record<string, string>;
  pi?: { extensions?: string[] };
};

describe("package.json files", () => {
  it("preserves the package, CLI, and default Pi extension entry", () => {
    expect(packageJson.name).toBe("pi-mcp-adapter");
    expect(packageJson.version).toBe("2.11.0");
    expect(packageJson.bin).toEqual({ "pi-mcp-adapter": "cli.js" });
    expect(packageJson.pi?.extensions).toEqual(["./index.ts"]);
  });

  it("exports the compiled extension and programmatic lifecycle", () => {
    expect(packageJson.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./programmatic": {
        types: "./dist/programmatic.d.ts",
        import: "./dist/programmatic.js",
      },
    });
  });

  it("publishes every root runtime TypeScript module", () => {
    const publishedFiles = new Set(packageJson.files ?? []);
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    expect(runtimeModules.length).toBeGreaterThan(0);
    expect(runtimeModules.filter((entry) => !publishedFiles.has(entry))).toEqual([]);
  });
});
