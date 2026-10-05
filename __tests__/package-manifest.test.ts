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
  "@earendil-works/pi-ai": { peer: "^0.84.1 || ^0.85.0 || ^0.86.0 || ^0.87.0 || ^0.99.0 || ^1.0.0", dev: "1.0.0", optional: true },
  "@earendil-works/pi-tui": { peer: "*", dev: "1.0.0", optional: false },
  "typebox": { peer: "*", dev: "1.3.27", optional: false },
};

describe("package.json files", () => {
  it("keeps the bundled MCP scripting skill available for manual use only", () => {
    const skill = readFileSync(join(repoRoot, "skills", "mcp-scripting", "SKILL.md"), "utf-8");
    expect(skill).toMatch(/^disable-model-invocation:\s*true\s*$/m);
  });

  it("ships every doc section the published README links to", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
    const links = [...readme.matchAll(/\]\(([^)]*docs\/[^)]*)\)/g)].map(([, url]) => {
      const parsed = url!.match(/^https:\/\/github\.com\/nicobailon\/pi-mcp-adapter\/blob\/main\/(docs\/[\w-]+\.md)(?:#([\w-]+))?$/);
      expect(parsed, url).not.toBeNull();
      return parsed!;
    });

    expect(links.length).toBeGreaterThan(0);
    expect(packageJson.files).toContain("docs");
    for (const [, path, anchor] of links) {
      const headings = readFileSync(join(repoRoot, path!), "utf-8").match(/^#+ .+$/gm)!
        .map((heading) => heading.replace(/^#+ /, "").toLowerCase().replace(/[^\w\- ]/g, "").replaceAll(" ", "-"));
      if (anchor) expect(headings, `${path}#${anchor}`).toContain(anchor);
    }
  });

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
  it("uses only registry semver dependency specs and no native refresh-lock addon", () => {
    const dependencyGroups = [
      packageJson.dependencies ?? {},
      packageJson.devDependencies ?? {},
      packageJson.peerDependencies ?? {},
    ];
    const registrySemver = /^(?:[~^]?\d+\.\d+\.\d+|\*)(?:\s*\|\|\s*(?:[~^]?\d+\.\d+\.\d+|\*))*$/;

    for (const dependencies of dependencyGroups) {
      for (const [name, spec] of Object.entries(dependencies)) {
        if (name === "recheck") {
          expect(spec).toBe("4.6.0-beta.3");
          continue;
        }
        expect(spec).toMatch(registrySemver);
        expect(spec).not.toMatch(/^(?:https?:|git(?:\+[^:]+)?:|file:)/);
      }
    }
    expect(packageJson.dependencies?.["fs-native-extensions"]).toBeUndefined();
  });

  it("declares Pi host packages as peers with exact dev pins", () => {
    const entries = Object.entries(hostPeerPackages);

    for (const [name, versions] of entries) {
      expect(packageJson.peerDependencies?.[name]).toBe(versions.peer);
      expect(packageJson.peerDependenciesMeta?.[name]?.optional ?? false).toBe(versions.optional);
      expect(packageJson.dependencies?.[name]).toBeUndefined();
      expect(packageJson.devDependencies?.[name]).toBe(versions.dev);
    }
  });

  // Hosts that import the package outside Pi's extension loader resolve peers with Node, so a peer
  // imported at runtime cannot be optional. Type-only peers stay optional to skip their install.
  it("marks a Pi host peer optional only when shipped source imports it for types alone", () => {
    const shippedSources = (packageJson.files ?? [])
      .filter((file) => /\.(?:ts|js|mjs|cjs)$/.test(file))
      .map((file) => readFileSync(join(repoRoot, file), "utf-8"));

    for (const [name, versions] of Object.entries(hostPeerPackages)) {
      const specifier = `["']${name}(?:/[^"']*)?["']`;
      const runtimeImport = new RegExp([
        `^\\s*(?:import|export)\\s+(?!type\\s)[^;]*?from\\s+${specifier}`,
        `^\\s*import\\s+${specifier}`,
        `\\b(?:import|require)\\(\\s*${specifier}\\s*\\)`,
      ].join("|"), "m");
      expect(shippedSources.some((source) => runtimeImport.test(source)), name).toBe(!versions.optional);
    }
  });

  it("tests extension APIs against Pi 1.0.0", () => {
    expect(packageJson.devDependencies?.["@earendil-works/pi-coding-agent"]).toBe("1.0.0");
  });

  it("uses the stable modular SDK v2 client/core packages without the legacy monolithic SDK", () => {
    const packageLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf-8")) as {
      packages: Record<string, { dev?: boolean }>;
    };
    const productionLegacySdk = Object.keys(packageLock.packages).filter(
      (path) => path.endsWith("node_modules/@modelcontextprotocol/sdk") && !packageLock.packages[path]?.dev
    );
    expect(productionLegacySdk).toEqual([]);
    expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/core"]).toBe("2.0.0");
    expect(packageJson.devDependencies?.["@modelcontextprotocol/server"]).toBeUndefined();
  });
});
