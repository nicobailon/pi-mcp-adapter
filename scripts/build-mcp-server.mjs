import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Re-expose `require` inside the ESM bundle. Several bundled CommonJS deps
// (e.g. cross-spawn) perform a runtime `require("child_process")` that plain
// `--format=esm` output cannot satisfy; `createRequire` makes that legal.
const requireShim =
  "import { createRequire as __bannerRequire } from 'node:module'; const require = __bannerRequire(import.meta.url);";

// Build metadata surfaced by `mcp-server --version` / `version`. CI (GitHub
// Actions release.yml) provides GITHUB_REF_NAME and GITHUB_SHA; local builds
// fall back to git, then to the package version / "unknown".
function runGit(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const shortHash = (h) => (h && h.length > 8 ? h.slice(0, 8) : h || "unknown");

const buildTag = process.env.GITHUB_REF_NAME
  || runGit(["describe", "--tags", "--exact-match"])
  || `v${pkg.version}`;
const buildHash = shortHash(process.env.GITHUB_SHA || runGit(["rev-parse", "HEAD"]));
const buildDate = new Date().toISOString();

const result = await build({
  entryPoints: ["bin/mcp-server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  banner: { js: requireShim },
  define: {
    __BUILD_INFO__: JSON.stringify({ tag: buildTag, hash: buildHash, date: buildDate }),
    // Keep --version in lockstep with package.json so it can never drift.
    __SERVER_VERSION__: JSON.stringify(pkg.version),
  },
  outfile: "mcp-server.mjs",
  logLevel: "info",
});

if (result.errors.length > 0) {
  process.exit(1);
}

// esbuild preserves the entry file's `#!/usr/bin/env npx tsx` shebang, which
// is wrong for a self-contained bundle: consumers run it via `node`, not tsx.
let output = readFileSync("mcp-server.mjs", "utf8");
output = output.replace(/^#![^\n]*\n/, "#!/usr/bin/env node\n");
writeFileSync("mcp-server.mjs", output);

console.log(`built mcp-server.mjs (tag=${buildTag}, commit=${buildHash}, built=${buildDate})`);