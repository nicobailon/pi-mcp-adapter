import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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

test("packed bearer storage recovers through the root helper from dist", { skip: process.platform !== "linux" }, async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pi-mcp-keyring-recovery-"));
  try {
    await extractPackedPackage(fixtureRoot);
    const packageRoot = path.join(fixtureRoot, "node_modules", "pi-mcp-adapter");
    await rm(path.join(packageRoot, "node_modules"));
    const nativeRoot = path.join(packageRoot, "node_modules", "@napi-rs", "keyring");
    await mkdir(nativeRoot, { recursive: true });
    await writeFile(path.join(nativeRoot, "index.js"), `
      const assert = require("node:assert/strict");
      exports.Entry = class {
        constructor(service) {
          if (process.env.SYNTHETIC_KEYRING_HELPER !== "1") throw new Error("KeyRevoked");
          assert.equal(service, "pi-mcp-adapter.bearer");
        }
        getPassword() { return JSON.stringify({ token: "synthetic-secret", serverUrl: "https://example.test/mcp" }); }
        setPassword(value) { assert.equal(JSON.parse(value).token, "synthetic-secret"); }
        deleteCredential() { return true; }
      };
    `);
    const bin = path.join(fixtureRoot, "bin");
    await mkdir(bin);
    const keyctl = path.join(bin, "keyctl");
    await writeFile(keyctl, `#!${process.execPath}
      const assert = require("node:assert/strict");
      const { spawnSync } = require("node:child_process");
      const { readFileSync } = require("node:fs");
      const args = process.argv.slice(2);
      assert.deepEqual(args.slice(0, 2), ["session", "-"]);
      const result = spawnSync(args[2], [args[3]], {
        input: readFileSync(0), encoding: "utf8", timeout: 2000,
        env: { ...process.env, SYNTHETIC_KEYRING_HELPER: "1" },
      });
      process.stdout.write(result.stdout || "");
      process.exit(result.status === 0 ? 0 : 1);
    `);
    await chmod(keyctl, 0o755);
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      const store = await import("./node_modules/pi-mcp-adapter/dist/mcp-bearer-store.js");
      const url = "https://example.test/mcp";
      store.saveBearerTokenForUrl("remote", "synthetic-secret", url);
      assert.equal(store.getBearerTokenForUrl("remote", url), "synthetic-secret");
      assert.equal(store.getBearerTokenForUrl("remote", url + "/other"), undefined);
      store.removeBearerToken("remote");
    `], {
      cwd: fixtureRoot, encoding: "utf8", timeout: 15000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`, PI_MCP_ADAPTER_TEST_AUTH_STORE: "", PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY: "", SYNTHETIC_KEYRING_HELPER: "" },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

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

test("System One key CLI loads built secure-store modules from the packed package", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "pi-mcp-key-cli-"));
  try {
    await extractPackedPackage(fixtureRoot);
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", [
      'const { main } = await import("./node_modules/pi-mcp-adapter/cli.js");',
      'const { Readable } = await import("node:stream");',
      'const run = (args, input = "") => { const logs = []; const errors = []; return main(args, line => logs.push(line), line => errors.push(line), Readable.from([input])).then(code => ({ code, logs, errors })); };',
      'const set = await run(["key", "set", "systemone"], "packed-secret\\n");',
      'if (set.code !== 0 || JSON.stringify(set).includes("packed-secret")) process.exit(2);',
      'const status = await run(["key", "status", "systemone"]);',
      'if (status.code !== 0 || status.logs[0] !== "source=keyring") process.exit(3);',
      'const remove = await run(["key", "remove", "systemone"]);',
      'if (remove.code !== 0) process.exit(4);',
    ].join("\n")], {
      cwd: fixtureRoot,
      env: { ...process.env, PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory", SYSTEMONE_API_KEY: undefined, TYPESAFE_API_KEY: undefined },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
