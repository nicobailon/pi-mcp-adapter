import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const testHome = mkdtempSync(join(tmpdir(), "pi-mcp-test-home-"));
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));
// Pi subagents export MCP_DIRECT_TOOLS=__none__, which turns off direct, search-mode and script tools.
// Tests that need it set their own value; an inherited one must not reach them.
delete process.env.MCP_DIRECT_TOOLS;

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		env: {
				// A test that starts a session without its own HOME must never write state into the developer's real Pi agent dir,
				// so neither the real HOME nor an inherited agent-dir override reaches the tests.
				HOME: testHome,
				PI_CODING_AGENT_DIR: "",
			PI_MCP_ADAPTER_TEST_AUTH_STORE: "memory",
			// Cache tests opt in explicitly to keep existing tests platform-neutral.
			PI_MCP_ADAPTER_DISABLE_AUTH_CACHE: "1",
		},
		include: ["__tests__/**/*.test.ts", "tests/**/*.test.ts"],
		setupFiles: ["./tests/setup-cross-platform.ts"],
		// Plan 07-04: matrix reporter added (D-17)
		// 07-02 deviation note: matrix reporter does its work in onTestRunEnd.
		reporters: ["default", "./tests/reporters/matrix-reporter.ts"],
		coverage: {
			provider: "v8",
			include: ["*.ts", "interfaces/**/*.ts", "adapters/**/*.ts"],
			exclude: [
				"__tests__/**",
				"vitest.config.ts",
				"cli.js",
				"app-bridge.bundle.js",
				"host-html-template.ts",
				"glimpse-ui.ts",
			],
			reporter: ["text", "html", "json"],
			thresholds: {
				"interfaces/agent-paths.ts": {
					lines: 80,
					functions: 80,
					branches: 80,
					statements: 80,
				},
				"interfaces/sampling.ts": {
					lines: 80,
					functions: 80,
					branches: 80,
					statements: 80,
				},
				"adapters/pi-renderer.ts": {
					lines: 80,
					functions: 80,
					branches: 80,
					statements: 80,
				},
			},
		},
	},
	// vite's import-analysis (es-module-lexer) chokes on `.js` files that keep a
	// `#!` shebang on CRLF line endings (common on Windows checkouts), throwing
	// "Invalid or unexpected token" when a test `import()`s cli.js. The shebang
	// only matters for direct execution, never for import, so strip it before
	// vite's transform.
	plugins: [
		{
			name: "strip-shebang",
			enforce: "pre",
			transform(code, id) {
				if (/\.(js|mjs)$/.test(id) && code.startsWith("#!")) {
					return code.replace(/^#![^\n]*\n/, "");
				}
			},
		},
	],
});
