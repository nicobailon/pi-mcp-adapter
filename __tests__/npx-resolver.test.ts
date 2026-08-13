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
    vi.doUnmock("cross-spawn");
  });

  afterEach(() => {
    vi.doUnmock("node:fs");
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

  it("writes mcp-npx-cache.json to PI_CODING_AGENT_DIR without extra arguments", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    writeCachedPackage(npmCache, "demo-pkg");

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "demo-pkg", "--token=secret-value"]);
    const cache = readFileSync(join(agentDir, "mcp-npx-cache.json"), "utf-8");

    expect(result?.extraArgs).toEqual(["--token=secret-value"]);
    expect(cache).not.toContain("secret-value");
    expect(existsSync(join(agentDir, "mcp-npx-cache.json"))).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "mcp-npx-cache.json"))).toBe(false);
  });

  it("removes stale version-1 cache files on module import", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    writeFileSync(
      join(agentDir, "mcp-npx-cache.json"),
      JSON.stringify({
        version: 1,
        entries: {
          [JSON.stringify(["npx", "-y", "demo-pkg", "--token=secret-value"] as const)]: {},
        },
      }),
      "utf-8",
    );
    await import("../npx-resolver.ts");

    expect(existsSync(join(agentDir, "mcp-npx-cache.json"))).toBe(false);
  });

  it("continues resolution when version-1 cache deletion fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const cachePath = join(agentDir, "mcp-npx-cache.json");
    writeFileSync(cachePath, JSON.stringify({ version: 1, entries: {} }), "utf-8");
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      return {
        ...fs,
        unlinkSync: vi.fn(() => { throw new Error("permission denied"); }),
        writeFileSync: vi.fn(() => { throw new Error("permission denied"); }),
      };
    });
    vi.doMock("cross-spawn", () => ({
      default: vi.fn(() => {
        throw new Error("npm unavailable");
      }),
    }));

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    await expect(resolveNpxBinary("npx", ["-y", "missing-pkg"])).resolves.toBeNull();

    expect(existsSync(cachePath)).toBe(true);
  });

  it("clears version-1 secrets and returns a cached package when cache save fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const cachePath = join(agentDir, "mcp-npx-cache.json");
    writeFileSync(cachePath, JSON.stringify({
      version: 1,
      entries: { [JSON.stringify(["npx", "demo-pkg", "--token=secret-value"])]: {} },
    }), "utf-8");
    const binPath = writeCachedPackage(npmCache, "demo-pkg");
    vi.doMock("node:fs", async (importOriginal) => {
      const fs = await importOriginal<typeof import("node:fs")>();
      return {
        ...fs,
        unlinkSync: vi.fn(() => { throw new Error("permission denied"); }),
        writeFileSync: vi.fn((path: string, data: string, options?: Parameters<typeof fs.writeFileSync>[2]) => {
          if (path === cachePath && data === "") return fs.writeFileSync(path, data, options);
          throw new Error("permission denied");
        }),
      };
    });

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    expect(readFileSync(cachePath, "utf-8")).not.toContain("secret-value");

    await expect(resolveNpxBinary("npx", ["-y", "demo-pkg", "--runtime=value"])).resolves.toEqual({
      binPath,
      extraArgs: ["--runtime=value"],
      isJs: true,
    });
  });

  it("ignores malformed version-2 cache entries", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const cachePath = join(agentDir, "mcp-npx-cache.json");
    writeFileSync(cachePath, JSON.stringify({
      version: 2,
      entries: {
        [JSON.stringify(["npx", "demo-pkg", ""])]: {
          resolvedBin: 123,
          resolvedAt: "recent",
          isJs: "yes",
        },
      },
    }), "utf-8");
    const binPath = writeCachedPackage(npmCache, "demo-pkg");

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "demo-pkg"]);

    expect(result?.binPath).toBe(binPath);
    expect(readFileSync(cachePath, "utf-8")).not.toContain("\"resolvedBin\": 123");
  });

  it("ignores persisted prototype keys during cache lookup", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.NPM_CONFIG_CACHE = npmCache;

    const poisonedBin = writeCachedPackage(npmCache, "poison-pkg");
    const demoBin = writeCachedPackage(npmCache, "demo-pkg");
    writeFileSync(join(agentDir, "mcp-npx-cache.json"), `{
      "version": 2,
      "entries": {
        "__proto__": {
          "resolvedBin": ${JSON.stringify(poisonedBin)},
          "resolvedAt": ${Date.now()},
          "isJs": true
        }
      }
    }`, "utf-8");

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "demo-pkg"]);

    expect(result?.binPath).toBe(demoBin);
  });

  it("uses cross-spawn to read npm's cache directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.NPM_CONFIG_CACHE;

    const binPath = writeCachedPackage(npmCache, "demo-pkg");
    const crossSpawn = vi.fn();
    const sync = vi.fn(() => ({ status: 0, stdout: `${npmCache}\n` }));
    Object.assign(crossSpawn, { sync });
    vi.doMock("cross-spawn", () => ({ default: crossSpawn }));

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "demo-pkg"]);

    expect(sync).toHaveBeenCalledWith("npm", ["config", "get", "cache"], { encoding: "utf-8" });
    expect(crossSpawn).not.toHaveBeenCalled();
    expect(result?.binPath).toBe(binPath);
  });

  it("uses cross-spawn to populate npm's npx cache on the slow path", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-mcp-npx-home-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-npx-agent-"));
    const npmCache = mkdtempSync(join(tmpdir(), "pi-mcp-npx-cache-"));

    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.NPM_CONFIG_CACHE;

    const proc = {
      kill: vi.fn(),
      on: vi.fn((event: string, callback: () => void) => {
        if (event === "close") queueMicrotask(callback);
        return proc;
      }),
    };
    const crossSpawn = vi.fn(() => {
      writeCachedPackage(npmCache, "demo-pkg");
      return proc;
    });
    const sync = vi.fn(() => ({ status: 0, stdout: `${npmCache}\n` }));
    Object.assign(crossSpawn, { sync });
    vi.doMock("cross-spawn", () => ({ default: crossSpawn }));

    const { resolveNpxBinary } = await import("../npx-resolver.ts");
    const result = await resolveNpxBinary("npx", ["-y", "demo-pkg"]);

    expect(crossSpawn).toHaveBeenCalledWith(
      "npm",
      ["exec", "--yes", "--package", "demo-pkg", "--", "node", "-e", "1"],
      { stdio: "ignore" },
    );
    expect(result).not.toBeNull();
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
        version: 2,
        entries: {
          [JSON.stringify(["npx", "plainpkg@2.0.0", ""] as const)]: {
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
    expect(cache.entries[JSON.stringify(["npx", "plainpkg@2.0.0", ""])]?.packageVersion).toBe("2.0.0");
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
