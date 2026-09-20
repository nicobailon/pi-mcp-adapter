import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createRetryableLoader } from "../lazy-loader.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("lazy runtime import boundaries", () => {
  it("proves the idle boundary from a fresh process module-load trace", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-mcp-lazy-probe-"));
    const loaderPath = join(directory, "loader.mjs");
    const tracePath = join(directory, "loaded.txt");
    writeFileSync(loaderPath, `import { appendFileSync } from "node:fs";\nconst tracePath = ${JSON.stringify(tracePath)};\nexport async function load(url, context, nextLoad) {\n  appendFileSync(tracePath, url + "\\n");\n  return nextLoad(url, context);\n}\n`);
    try {
      const result = spawnSync(process.execPath, [
        "--experimental-loader", loaderPath,
        "--import", "tsx",
        "--input-type=module",
        "-e", `await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)})`,
      ], { cwd: new URL("..", import.meta.url), encoding: "utf8" });

      expect(result.status, result.stderr).toBe(0);
      const loaded = readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
      expect(loaded.some((url) => url.endsWith("/index.ts"))).toBe(true);
      for (const moduleName of ["init", "mcp-auth-flow", "proxy-modes", "direct-tools", "commands", "mcp-code", "mcp-install"]) {
        expect(loaded.some((url) => url.endsWith(`/${moduleName}.ts`)), moduleName).toBe(false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("createRetryableLoader", () => {
  it("coalesces concurrent first calls and caches the loaded value", async () => {
    const first = deferred<{ value: number }>();
    const importModule = vi.fn(() => first.promise);
    const load = createRetryableLoader(importModule);

    const one = load();
    const two = load();
    expect(one).toBe(two);
    expect(importModule).toHaveBeenCalledTimes(1);

    first.resolve({ value: 1 });
    await expect(one).resolves.toEqual({ value: 1 });
    await expect(load()).resolves.toEqual({ value: 1 });
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("clears a rejected import so the next call retries", async () => {
    const importModule = vi.fn()
      .mockRejectedValueOnce(new Error("import failed"))
      .mockResolvedValueOnce({ value: 2 });
    const load = createRetryableLoader(importModule);

    await expect(load()).rejects.toThrow("import failed");
    await expect(load()).resolves.toEqual({ value: 2 });
    expect(importModule).toHaveBeenCalledTimes(2);
  });
});
