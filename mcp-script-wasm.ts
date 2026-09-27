import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export type McpScriptWasmModule = object;

const cached = new Map<string, Promise<McpScriptWasmModule>>();

/** Load and compile the packaged QuickJS runtime once per host process. */
export function loadMcpScriptWasm(path = createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")): Promise<McpScriptWasmModule> {
  let module = cached.get(path);
  if (!module) {
    const webAssembly = (globalThis as unknown as {
      WebAssembly: { compile(bytes: Uint8Array): Promise<McpScriptWasmModule> };
    }).WebAssembly;
    module = readFile(path)
      .then((bytes) => webAssembly.compile(bytes))
      .catch((error: unknown) => {
        cached.delete(path);
        throw error;
      });
    cached.set(path, module);
  }
  return module;
}
