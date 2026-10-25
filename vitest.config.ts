import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const testHome = mkdtempSync(join(tmpdir(), "pi-mcp-test-home-"));
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));

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
    include: ["__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["*.ts"],
      exclude: ["__tests__/**", "vitest.config.ts", "cli.js"],
    },
  },
});
