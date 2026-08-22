import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";

test("public metadata, config, and type helpers load in plain Node from node_modules", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pi-mcp-public-exports-"));
  try {
    const packageRoot = path.join(fixtureRoot, "node_modules", "pi-mcp-adapter");
    await mkdir(path.dirname(packageRoot), { recursive: true });
    await cp(process.cwd(), packageRoot, {
      recursive: true,
      filter(source) {
        const relative = path.relative(process.cwd(), source);
        return relative === "" || (!relative.startsWith("node_modules")
          && !relative.startsWith(".git"));
      }
    });
    await symlink(path.join(process.cwd(), "node_modules"), path.join(packageRoot, "node_modules"), "dir");
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'const metadata = await import("pi-mcp-adapter/metadata-cache");',
        'const config = await import("pi-mcp-adapter/config");',
        'const types = await import("pi-mcp-adapter/types");',
        'if (typeof metadata.isServerCacheValid !== "function") process.exit(2);',
        'if (typeof types.formatToolName !== "function") process.exit(3);',
        'if (typeof config.loadMcpConfig !== "function") process.exit(4);'
      ].join("\n")
    ], {
      cwd: fixtureRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
