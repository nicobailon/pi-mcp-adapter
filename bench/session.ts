// Child process for bench/server-memory.mjs: one Pi session with the adapter
// loaded, driven by JSON lines on stdin and answering with JSON lines on stdout.
// Pi is loaded from BENCH_PI (an installed pi-coding-agent package), whose
// extension loader also hands that copy to the adapter. If stdin closes
// because the parent died, the session shuts down so no servers are left.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type * as Pi from "@earendil-works/pi-coding-agent";

const agentDir = process.env.PI_CODING_AGENT_DIR;
const adapterPath = process.env.BENCH_ADAPTER;
const projectDir = process.env.BENCH_PROJECT_DIR;
const piDir = process.env.BENCH_PI;
if (!agentDir || !adapterPath || !projectDir || !piDir) throw new Error("Missing bench session environment");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, VERSION } =
  await import(pathToFileURL(join(piDir, "dist/index.js")).href) as typeof Pi;

// Count and time synchronous metadata cache I/O (reads, temp writes, renames).
const cachePath = join(agentDir, "mcp-cache.json");
const cacheIo = { writes: 0, ms: 0 };
const { readFileSync, writeFileSync, renameSync } = fs;
const timed = <A extends unknown[], R>(fn: (...args: A) => R, matches: (...args: A) => boolean) => (...args: A): R => {
  if (!matches(...args)) return fn(...args);
  const start = performance.now();
  try {
    return fn(...args);
  } finally {
    cacheIo.ms += performance.now() - start;
  }
};
fs.readFileSync = timed(readFileSync, (path: unknown) => path === cachePath) as typeof fs.readFileSync;
fs.writeFileSync = timed(writeFileSync, (path: unknown) => typeof path === "string" && path.startsWith(`${cachePath}.`)) as typeof fs.writeFileSync;
fs.renameSync = timed((from: fs.PathLike, to: fs.PathLike) => {
  if (to === cachePath) cacheIo.writes++;
  renameSync(from, to);
}, (_from: fs.PathLike, to: fs.PathLike) => to === cachePath);
syncBuiltinESMExports();

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
const sessionStart = performance.now();

const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager, additionalExtensionPaths: [adapterPath] });
await loader.reload();
const { session } = await createAgentSession({
  cwd: projectDir,
  agentDir,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(projectDir),
  settingsManager,
  tools: ["mcp"],
});
await session.bindExtensions({ mode: "print", onError: error => console.error(error.error) });

const mcp = session.getToolDefinition("mcp");
if (!mcp) throw new Error("The adapter did not register the mcp tool");
const execute = (params: Record<string, unknown>) =>
  mcp.execute("bench", params, undefined, undefined, session.extensionRunner.createContext());
const reply = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(message)}\n`);
const shutdown = async () => {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
  session.dispose();
};

for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line) as { op: string; server?: string };
  if (command.op === "ready") {
    await execute({});
    reply({
      op: "ready",
      piVersion: VERSION,
      ms: performance.now() - sessionStart,
      cacheWrites: cacheIo.writes,
      cacheIoMs: cacheIo.ms,
      maxLoopDelayMs: loopDelay.max / 1e6,
    });
  } else if (command.op === "call") {
    const start = performance.now();
    const result = await execute({ tool: "action_0", server: command.server, args: {} });
    const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
    if (!text.includes("ok")) throw new Error(`Unexpected result from ${command.server}: ${text}`);
    reply({ op: "call", server: command.server, ms: performance.now() - start });
  } else if (command.op === "shutdown") {
    await shutdown();
    reply({ op: "shutdown" });
    process.exit(0);
  }
}
await shutdown();
process.exit(0);
