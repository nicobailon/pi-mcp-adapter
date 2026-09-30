import { parentPort, workerData } from "node:worker_threads";

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const ERROR_MAX_BYTES = 64 * 1024;
const ERROR_TRUNCATION_MARKER = "\n...[mcpScript error truncated]";

// Set once main() imports quickjs-wasi from the host-resolved file URL.
let JSException;

function post(message) {
  parentPort?.postMessage(message);
}

function errorText(error) {
  if (JSException && error instanceof JSException) {
    const head = error.message ? `${error.name}: ${error.message}` : error.name;
    return error.stack ? `${head}\n${error.stack}` : head;
  }
  return error instanceof Error ? error.message : String(error);
}

function truncateErrorMessage(error) {
  const message = typeof error === "string" ? error : errorText(error);
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length <= ERROR_MAX_BYTES) return message;
  const marker = Buffer.from(ERROR_TRUNCATION_MARKER, "utf8");
  const prefix = bytes.subarray(0, ERROR_MAX_BYTES - marker.length - 3).toString("utf8").replace(/\uFFFD$/, "");
  return prefix + ERROR_TRUNCATION_MARKER;
}

function postError(error) {
  post({ type: "error", message: truncateErrorMessage(error) });
}

/** Silence QuickJS's WASI stdout/stderr so diagnostics cannot corrupt the host TUI. */
function discardOutput(memory) {
  return {
    fd_write(_fd, iovsPtr, iovsLen, nwrittenPtr) {
      const view = new DataView(memory.buffer);
      let written = 0;
      for (let index = 0; index < iovsLen; index++) {
        written += view.getUint32(iovsPtr + index * 8 + 4, true);
      }
      view.setUint32(nwrittenPtr, written, true);
      return 0;
    },
  };
}

const PRELUDE_SOURCE = `(function (bridge) {
  "use strict";
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const promiseThen = Promise.prototype.then;
  const ErrorCtor = Error;
  const reserved = new Set(["then", "catch", "finally", "toJSON", "toString", "valueOf"]);
  const pending = new Map();
  let nextId = 0;

  function inspect(value, ancestors) {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    if (typeof value === "bigint") return String(value) + "n";
    if (typeof value === "function") return "[Function" + (value.name ? ": " + value.name : "") + "]";
    if (typeof value === "symbol") return String(value);
    if (value === null || typeof value !== "object") return String(value);
    if (value instanceof ErrorCtor) return value.name + (value.message ? ": " + value.message : "");
    if (ancestors.includes(value)) return "[Circular]";
    const next = ancestors.concat([value]);
    if (value instanceof Map) {
      const entries = [];
      for (const [key, entry] of value) entries.push(inspectQuoted(key, next) + " => " + inspectQuoted(entry, next));
      return "Map(" + value.size + ") { " + entries.join(", ") + " }";
    }
    if (value instanceof Set) {
      const entries = [];
      for (const entry of value) entries.push(inspectQuoted(entry, next));
      return "Set(" + value.size + ") { " + entries.join(", ") + " }";
    }
    if (Array.isArray(value)) return "[ " + value.map((entry) => inspectQuoted(entry, next)).join(", ") + " ]";
    let keys;
    try { keys = Object.keys(value); } catch { return "[unserializable value]"; }
    return "{ " + keys.map((key) => key + ": " + inspectQuoted(value[key], next)).join(", ") + " }";
  }

  function inspectQuoted(value, ancestors) {
    return typeof value === "string" ? "'" + value.replaceAll("'", "\\\\'") + "'" : inspect(value, ancestors);
  }

  function needsInspect(value, ancestors) {
    if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return true;
    if (value === null || typeof value !== "object") return false;
    if (value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet || value instanceof ErrorCtor) return true;
    if (ancestors.includes(value)) return true;
    const next = ancestors.concat([value]);
    try { return Object.values(value).some((entry) => needsInspect(entry, next)); } catch { return true; }
  }

  function format(value) {
    if (typeof value === "string") return value;
    try {
      if (!needsInspect(value, [])) {
        const json = stringify(value, null, 2);
        if (json !== undefined) return json;
      }
      return inspect(value, []);
    } catch { return "[unserializable value]"; }
  }

  function toBlock(value) {
    if (value && typeof value === "object") {
      if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
      if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
        return { type: "image", data: value.data, mimeType: value.mimeType };
      }
    }
    return { type: "text", text: format(value) };
  }

  function request(type, payload) {
    return new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      bridge("request", type, id, stringify(payload));
    });
  }

  const tools = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "search") return (input) => request("search", { input });
      if (property === "describe") return (input) => request("describe", { input });
      if (property === "call") return (path, args, options) => {
        if (typeof path !== "string" || path.trim() === "") {
          return Promise.resolve({ ok: false, error: { code: "invalid_tool_path", message: "tools.call(path, args) requires a non-empty tool path." } });
        }
        const server = options?.server;
        if (server !== undefined && (typeof server !== "string" || server.trim() === "")) {
          return Promise.resolve({ ok: false, error: { code: "invalid_tool_server", message: "tools.call(path, args, { server }) requires a non-empty server name." } });
        }
        return request("call", server === undefined ? { path, args } : { path, args, server });
      };
      if (typeof property !== "string" || reserved.has(property)) return undefined;
      return (args) => request("call", { path: property, args });
    },
    ownKeys() { throw new ErrorCtor("tools is not enumerable — use tools.search({ query })"); },
  });

  const jev = Object.freeze({ evaluate: (input) => request("evaluate", { input }) });
  const emit = (value) => bridge("emit", stringify(toBlock(value)));
  const console = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...args) => emit("[console." + level + "] " + args.map(format).join(" "));
  }
  Object.freeze(console);
  Object.defineProperties(globalThis, {
    tools: { value: tools, enumerable: true },
    jev: { value: jev, enumerable: true },
    emit: { value: emit, enumerable: true },
    console: { value: console, enumerable: true },
  });

  return {
    settle(id, payload) {
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id);
      resolve(parse(payload));
    },
    run(fn) {
      let promise;
      try { promise = fn(); }
      catch (error) { bridge("error", format(error)); return; }
      promiseThen.call(promise,
        (value) => bridge("done", value === undefined ? undefined : stringify(toBlock(value))),
        (error) => bridge("error", format(error)));
    },
  };
})`;

async function main() {
  // Bun-compiled executables cannot resolve bare package names from this
  // worker file, so import quickjs-wasi from the URL the host resolved.
  const quickjs = await import(workerData.quickjsUrl);
  JSException = quickjs.JSException;
  const { MAX_STACK_SIZE, QuickJS } = quickjs;
  const interrupt = new Int32Array(workerData.interrupt);
  let outputBytes = 0;
  let outputExceeded = false;
  const postOutput = (message, block) => {
    if (outputExceeded) return;
    const bytes = Buffer.byteLength(JSON.stringify(block), "utf8");
    if (bytes > workerData.outputMaxBytes - outputBytes) {
      outputExceeded = true;
      postError("mcpScript output exceeds the 16 MiB per-script budget");
      Atomics.store(interrupt, 0, 1);
      return;
    }
    outputBytes += bytes;
    post(message);
  };
  const vm = await QuickJS.create({
    wasm: workerData.wasm,
    memoryLimit: MEMORY_LIMIT_BYTES,
    maxStackSize: MAX_STACK_SIZE,
    interruptHandler: () => Atomics.load(interrupt, 0) !== 0,
    wasi: discardOutput,
  });

  const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
    const messageType = kind.toString();
    if (messageType === "request") {
      const payload = JSON.parse(c.toString());
      post({ type: a.toString(), id: b.toNumber(), ...payload });
    } else if (messageType === "emit") {
      const block = JSON.parse(a.toString());
      postOutput({ type: "emit", block }, block);
    } else if (messageType === "done") {
      if (a === undefined || a.isUndefined) {
        post({ type: "done" });
      } else {
        const returnBlock = JSON.parse(a.toString());
        postOutput({ type: "done", returnBlock }, returnBlock);
      }
    } else if (messageType === "error") {
      postError(a.toString());
    }
    return vm.undefined;
  });

  const api = vm.withScope((scope) => scope.escape(vm.callFunction(
    vm.evalCode(PRELUDE_SOURCE, "mcpScript-prelude.js"), vm.undefined, bridge,
  )));
  const settle = api.getProp("settle");
  const run = api.getProp("run");

  parentPort?.on("message", (message) => {
    if (message?.type !== "result" || typeof message.id !== "number") return;
    try {
      const payload = "dataJson" in message
        ? `{"ok":true,"data":${message.dataJson}}`
        : JSON.stringify(message.envelope);
      vm.withScope(() => vm.callFunction(settle, api, vm.newNumber(message.id), vm.newString(payload)));
      vm.executePendingJobs();
    } catch (error) {
      postError(error);
    }
  });

  let fn;
  try {
    fn = vm.evalCode(`(async () => {\n${workerData.code}\n})`, "mcpScript.js");
    vm.callFunction(run, api, fn).dispose();
    fn.dispose();
    vm.executePendingJobs();
  } catch (error) {
    postError(error);
  }
}

if (parentPort) main().catch(postError);
