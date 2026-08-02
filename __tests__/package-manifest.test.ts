import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: Record<string, unknown>;
  types?: string;
};

const visualizerPackageJson = JSON.parse(
  readFileSync(join(repoRoot, "examples/interactive-visualizer/package.json"), "utf-8"),
) as { dependencies?: Record<string, string> };
const visualizerServerSource = readFileSync(
  join(repoRoot, "examples/interactive-visualizer/src/server.ts"),
  "utf-8",
);

const hostPeerPackages = {
  "@earendil-works/pi-ai": "0.74.2",
  "@earendil-works/pi-tui": "0.74.2",
  "typebox": "1.3.3",
};

describe("package.json files", () => {
  it("exports the TypeScript source entry for SDK consumers", () => {
    expect(packageJson.types).toBe("./index.ts");
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./index.ts",
        import: "./index.ts",
        default: "./index.ts",
      },
      "./types": {
        types: "./types.ts",
        import: "./types.ts",
        default: "./types.ts",
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

describe("package.json dependency policy", () => {
  it("requires the Node runtime supported by the Pi host", () => {
    expect(packageJson.engines?.node).toBe(">=22.19.0");
  });

  it("treats Pi host packages as optional wildcard peers with exact dev pins", () => {
    const entries = Object.entries(hostPeerPackages);

    for (const [name, exactVersion] of entries) {
      expect(packageJson.peerDependencies?.[name]).toBe("*");
      expect(packageJson.peerDependenciesMeta?.[name]?.optional).toBe(true);
      expect(packageJson.dependencies?.[name]).toBeUndefined();
      expect(packageJson.devDependencies?.[name]).toBe(exactVersion);
    }
  });

  it("builds the interactive visualizer server with stable SDK v2", () => {
    expect(visualizerPackageJson.dependencies?.["@modelcontextprotocol/server"]).toBe("2.0.0");
    expect(visualizerPackageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(visualizerServerSource).toContain("@modelcontextprotocol/server");
    expect(visualizerServerSource).not.toContain("@modelcontextprotocol/sdk");
  });

  it("uses stable SDK v2 while retaining v1 only for ext-apps compatibility", () => {
    expect(packageJson.dependencies?.["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/core"]).toBe("2.0.0");
    expect(packageJson.devDependencies?.["@modelcontextprotocol/server"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/ext-apps"]).toBeDefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBe("^1.30.0");
  });

  const runtimeModules = readdirSync(repoRoot)
    .filter(entry => entry.endsWith(".ts") && !entry.endsWith(".test.ts"));

  it.each(runtimeModules)("keeps v1 SDK imports out of runtime module %s", entry => {
    expect(readFileSync(join(repoRoot, entry), "utf8")).not.toContain("@modelcontextprotocol/sdk");
  });
});
