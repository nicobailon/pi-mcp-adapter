import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const workspace = mkdtempSync(join(tmpdir(), "pi-mcp-adapter-pack-"));

try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", workspace], {
    cwd: root,
    encoding: "utf8",
  });
  const packed = JSON.parse(packOutput) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  assert.equal(packed.length, 1);
  const receipt = packed[0]!;
  const paths = new Set(receipt.files.map((file) => file.path));
  for (const required of [
    "LICENSE",
    "README.md",
    "cli.js",
    "index.ts",
    "programmatic.ts",
    "programmatic-types.ts",
    "examples/programmatic-source.ts",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/programmatic.js",
    "dist/programmatic.d.ts",
  ]) {
    assert(paths.has(required), `packed package is missing ${required}`);
  }
  assert(!paths.has("server-manager.test.ts"));

  execFileSync("npm", ["init", "-y"], { cwd: workspace, stdio: "ignore" });
  const tarball = join(workspace, receipt.filename);
  execFileSync("npm", ["install", "--ignore-scripts", tarball], {
    cwd: workspace,
    stdio: "pipe",
  });

  const importReceipt = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `
      const extension = await import('pi-mcp-adapter');
      const api = await import('pi-mcp-adapter/programmatic');
      if (typeof extension.default !== 'function') throw new Error('missing extension export');
      if (typeof api.createMcpAdapter !== 'function') throw new Error('missing programmatic export');
      const adapter = api.createMcpAdapter({ fileDiscovery: 'disabled' });
      if (typeof adapter.extension !== 'function' || typeof adapter.runtime.inspectSources !== 'function') {
        throw new Error('invalid programmatic factory');
      }
      let managerPrivate = false;
      try { await import('pi-mcp-adapter/server-manager'); }
      catch (error) { managerPrivate = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
      if (!managerPrivate) throw new Error('manager internals are package-exported');
      console.log(JSON.stringify({ extension: true, programmatic: true, managerPrivate }));
    `,
  ], { cwd: workspace, encoding: "utf8" }).trim();
  assert.deepEqual(JSON.parse(importReceipt), {
    extension: true,
    programmatic: true,
    managerPrivate: true,
  });

  const cliHelp = execFileSync(join(workspace, "node_modules", ".bin", "pi-mcp-adapter"), ["--help"], {
    cwd: workspace,
    encoding: "utf8",
  });
  assert.match(cliHelp, /pi-mcp-adapter helper/);

  const installedManifest = JSON.parse(readFileSync(
    join(workspace, "node_modules", "pi-mcp-adapter", "package.json"),
    "utf8",
  ));
  assert.equal(installedManifest.name, "pi-mcp-adapter");
  assert.equal(installedManifest.version, "2.11.0");
  assert.equal(installedManifest.license, "MIT");
  assert.deepEqual(installedManifest.pi.extensions, ["./index.ts"]);
  console.log(`packed package qualification passed: ${receipt.filename}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
