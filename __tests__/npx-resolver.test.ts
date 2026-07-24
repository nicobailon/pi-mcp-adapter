import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("npx-resolver", () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalNpmCache = process.env.NPM_CONFIG_CACHE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    if (originalNpmCache === undefined) {
      delete process.env.NPM_CONFIG_CACHE;
    } else {
      process.env.NPM_CONFIG_CACHE = originalNpmCache;
    }
  });

  it("writes mcp-npx-cache.json to PI_CODING_AGENT_DIR", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    writeCachedPackage(npmCache, "demo-pkg");

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "demo-pkg"]);

    expect(result).not.toBeNull();
    expect(existsSync(join(agentDir, "mcp-npx-cache.json"))).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "mcp-npx-cache.json"))).toBe(false);
  });

  it("preserves npx separators for wrapper package arguments", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    writeCachedPackage(npmCache, "dotenv-cli");

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", [
      "--yes",
      "dotenv-cli",
      "--",
      "npx",
      "--yes",
      "@upstash/context7-mcp",
    ]);

    expect(result?.extraArgs).toEqual(["--", "npx", "--yes", "@upstash/context7-mcp"]);
  });

  it("does not add separators to npx invocations that did not include one", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    writeCachedPackage(npmCache, "dotenv-cli");

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", [
      "--yes",
      "dotenv-cli",
      "github-mcp-server",
      "stdio",
    ]);

    expect(result?.extraArgs).toEqual(["github-mcp-server", "stdio"]);
  });

  it("honors exact scoped package versions when a newer cache directory contains the wrong version", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const correctBin = writeCachedPackage(npmCache, "@scope/pkg", "2.0.0", "correct");
    writeCachedPackage(npmCache, "@scope/pkg", "1.0.0", "old");
    const newer = new Date(Date.now() + 10_000);
    utimesSync(join(npmCache, "_npx", "old"), newer, newer);

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "@scope/pkg@2.0.0"]);

    expect(result?.binPath).toBe(correctBin);
  });

  it("honors exact unscoped package versions when a newer cache directory contains the wrong version", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const correctBin = writeCachedPackage(npmCache, "plainpkg", "2.0.0", "correct");
    writeCachedPackage(npmCache, "plainpkg", "1.0.0", "old");
    const newer = new Date(Date.now() + 10_000);
    utimesSync(join(npmCache, "_npx", "old"), newer, newer);

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "plainpkg@2.0.0"]);

    expect(result?.binPath).toBe(correctBin);
  });

  it.each(["plainpkg@v2.0.0", "plainpkg@=2.0.0"])(
    "honors npm exact version spelling %s",
    async (packageSpec) => {
      const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
      const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
      const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.NPM_CONFIG_CACHE = npmCache;

      const correctBin = writeCachedPackage(npmCache, "plainpkg", "2.0.0", "correct");
      writeCachedPackage(npmCache, "plainpkg", "1.0.0", "old");
      const newer = new Date(Date.now() + 10_000);
      utimesSync(join(npmCache, "_npx", "old"), newer, newer);

      const { resolveNpxBinary } = await import("../npx-resolver.ts");
      const result = await resolveNpxBinary("npx", ["-y", packageSpec]);

      expect(result?.binPath).toBe(correctBin);
    },
  );

  it("ignores poisoned persistent cache entries for exact version requests", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const correctBin = writeCachedPackage(npmCache, "plainpkg", "2.0.0", "correct");
    const wrongBin = writeCachedPackage(npmCache, "plainpkg", "1.0.0", "old");
    writeFileSync(
      join(agentDir, "mcp-npx-cache.json"),
      JSON.stringify({
        version: 1,
        entries: {
          [JSON.stringify(["npx", "-y", "plainpkg@2.0.0"] as const)]: {
            resolvedBin: wrongBin,
            resolvedAt: Date.now(),
            packageVersion: "1.0.0",
            isJs: true,
          },
        },
      }),
      "utf-8",
    );

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "plainpkg@2.0.0"]);
    const cache = JSON.parse(readFileSync(join(agentDir, "mcp-npx-cache.json"), "utf-8"));

    expect(result?.binPath).toBe(correctBin);
    expect(cache.entries[JSON.stringify(["npx", "-y", "plainpkg@2.0.0"])]?.packageVersion).toBe("2.0.0");
  });
});

function writeCachedPackage(
  npmCache: string,
  packageName: string,
  version = "1.0.0",
  cacheId = "fixture",
): string {
  const packageDir = join(npmCache, "_npx", cacheId, "node_modules", packageName);
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version, bin: "bin/cli.js" }),
    "utf-8",
  );
  const binPath = join(packageDir, "bin", "cli.js");
  writeFileSync(binPath, "#!/usr/bin/env node\nconsole.log('ok')\n", "utf-8");
  return binPath;
}
