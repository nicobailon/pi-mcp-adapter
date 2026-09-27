import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export type McpScriptWasmModule = object;

let cached: Promise<McpScriptWasmModule> | undefined;

/** Load and compile the packaged QuickJS runtime once per host process. */
export function loadMcpScriptWasm(): Promise<McpScriptWasmModule> {
  if (!cached) {
    const path = createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
    const webAssembly = (globalThis as unknown as {
      WebAssembly: { compile(bytes: Uint8Array): Promise<McpScriptWasmModule> };
    }).WebAssembly;
    cached = readFile(path)
      .then((bytes) => webAssembly.compile(bytes))
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
  }
  return cached;
}
