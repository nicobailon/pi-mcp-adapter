import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const hostPeerPackages = {
  "@earendil-works/pi-ai": "0.74.2",
  "@earendil-works/pi-tui": "0.74.2",
  "typebox": "1.3.3",
};

describe("package.json files", () => {
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

describe("package.json dependency policy", () => {
  it("treats Pi host packages as optional wildcard peers with exact dev pins", () => {
    const entries = Object.entries(hostPeerPackages);

    for (const [name, exactVersion] of entries) {
      expect(packageJson.peerDependencies?.[name]).toBe("*");
      expect(packageJson.peerDependenciesMeta?.[name]?.optional).toBe(true);
      expect(packageJson.dependencies?.[name]).toBeUndefined();
      expect(packageJson.devDependencies?.[name]).toBe(exactVersion);
    }
  });
});
