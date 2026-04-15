import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@mariozechner/pi-coding-agent": fileURLToPath(new URL("./__tests__/stubs/pi-coding-agent.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["*.ts"],
      exclude: ["__tests__/**", "vitest.config.ts", "cli.js"],
    },
  },
});
