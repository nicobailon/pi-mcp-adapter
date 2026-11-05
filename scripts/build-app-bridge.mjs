import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(
  readFileSync(`${repoRoot}node_modules/@modelcontextprotocol/ext-apps/package.json`, "utf-8"),
);

// zod's `z.locales` namespace (every error-message translation, about 260 KB) can't be
// tree-shaken behind the SDK's `import * as z`. Nothing in the bridge reads it, and the
// default English messages load from locales/en.js, which stays.
const dropZodLocales = {
  name: "drop-zod-locales",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, ({ importer }) =>
      /[\\/]node_modules[\\/]zod[\\/]/.test(importer) ? { path: "zod-locales", namespace: "stub" } : undefined,
    );
    pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export {};" }));
  },
};

// The version banner lets __tests__/package-manifest.test.ts catch a bundle left behind by a devDependency bump.
await build({
  absWorkingDir: repoRoot,
  entryPoints: ["@modelcontextprotocol/ext-apps/app-bridge"],
  outfile: "app-bridge.bundle.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  plugins: [dropZodLocales],
  banner: { js: `// @modelcontextprotocol/ext-apps@${version} AppBridge, built by scripts/build-app-bridge.mjs` },
});
