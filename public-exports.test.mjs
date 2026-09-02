import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";

async function extractPackedPackage(fixtureRoot) {
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", fixtureRoot], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const tarball = path.join(fixtureRoot, JSON.parse(packed.stdout)[0].filename);
  const packageRoot = path.join(fixtureRoot, "node_modules", "pi-mcp-adapter");
  await mkdir(packageRoot, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", tarball, "-C", packageRoot, "--strip-components=1"], {
    encoding: "utf8"
  });
  assert.equal(extracted.status, 0, `${extracted.stdout}\n${extracted.stderr}`);
  await symlink(path.join(process.cwd(), "node_modules"), path.join(packageRoot, "node_modules"), "dir");
}

test("public metadata, config, and type helpers load in plain Node from node_modules", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pi-mcp-public-exports-"));
  try {
    await extractPackedPackage(fixtureRoot);
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

test("token CLI avoids package-local TypeScript imports under node_modules", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pi-mcp-token-cli-"));
  try {
    await extractPackedPackage(fixtureRoot);
    await writeFile(path.join(fixtureRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        remote: { url: "https://example.test/mcp", auth: "bearer", bearerTokenStore: true },
      },
    }));

    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        'const { main } = await import("./node_modules/pi-mcp-adapter/cli.js");',
        'const { Readable } = await import("node:stream");',
        'const run = (args, input = "") => { const logs = []; const errors = []; return main(args, line => logs.push(line), line => errors.push(line), Readable.from([input])).then(code => ({ code, logs, errors })); };',
        'const set = await run(["token", "set", "remote"], "secret-token\\n");',
        'if (set.code !== 0 || set.errors.length !== 0 || set.logs.join("\\n").includes("secret-token")) process.exit(2);',
        'const status = await run(["token", "status", "remote"]);',
        'if (status.code !== 0 || status.errors.length !== 0 || !status.logs.join("\\n").includes("Bearer token is stored")) process.exit(3);',
        'const remove = await run(["token", "remove", "remote"]);',
        'if (remove.code !== 0 || remove.errors.length !== 0) process.exit(4);',
      ].join("\n")
    ], {
      cwd: fixtureRoot,
      env: { ...process.env, PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory" },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
