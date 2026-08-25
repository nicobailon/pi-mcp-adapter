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
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  types?: string;
};

const hostPeerPackages = {
  "@earendil-works/pi-ai": { peer: "^0.84.1", dev: "0.84.1" },
  "@earendil-works/pi-tui": { peer: "*", dev: "0.84.1" },
  "typebox": { peer: "*", dev: "1.3.3" },
};

describe("package.json files", () => {
  it("exports source entry points and plain Node host helpers", () => {
    expect(packageJson.types).toBe("./index.ts");
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./index.ts",
        import: "./index.ts",
        default: "./index.ts",
      },
      "./types": {
        types: "./dist/types.d.ts",
        import: "./dist/types.js",
        default: "./dist/types.js",
      },
      "./config": {
        types: "./dist/config.d.ts",
        import: "./dist/config.js",
        default: "./dist/config.js",
      },
      "./metadata-cache": {
        types: "./dist/metadata-cache.d.ts",
        import: "./dist/metadata-cache.js",
        default: "./dist/metadata-cache.js",
      },
    });
  });

  it("ships public host helpers without install-time prepare", () => {
    const publishedFiles = new Set(packageJson.files ?? []);

    expect(packageJson.scripts?.prepare).toBeUndefined();
    expect(packageJson.scripts?.prepack).toBe("npm run build:public");
    expect(publishedFiles.has("dist")).toBe(true);
    for (const entry of Object.values(packageJson.exports ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      for (const target of Object.values(entry)) {
        if (typeof target === "string" && target.startsWith("./dist/")) {
          expect(readFileSync(join(repoRoot, target), "utf-8").length).toBeGreaterThan(0);
        }
      }
    }
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

  it("does not import the peer-dependent MCP app bridge from runtime modules", () => {
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    const offenders = runtimeModules.filter((entry) =>
      readFileSync(join(repoRoot, entry), "utf-8").includes("@modelcontextprotocol/ext-apps/app-bridge")
    );

    expect(offenders).toEqual([]);
  });
});

describe("package.json dependency policy", () => {
  it("treats Pi host packages as optional peers with exact dev pins", () => {
    const entries = Object.entries(hostPeerPackages);

    for (const [name, versions] of entries) {
      expect(packageJson.peerDependencies?.[name]).toBe(versions.peer);
      expect(packageJson.peerDependenciesMeta?.[name]?.optional).toBe(true);
      expect(packageJson.dependencies?.[name]).toBeUndefined();
      expect(packageJson.devDependencies?.[name]).toBe(versions.dev);
    }
  });

  it("uses the stable modular SDK v2 client/core packages without the legacy monolithic SDK", () => {
    expect(packageJson.dependencies?.["@modelcontextprotocol/ext-apps"]).toBeDefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/core"]).toBe("2.0.0");
    expect(packageJson.devDependencies?.["@modelcontextprotocol/server"]).toBeUndefined();
  });
});
