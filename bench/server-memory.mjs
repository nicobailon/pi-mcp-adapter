// Dev-only benchmark for issue #783: how many MCP server processes stay alive,
// and how much memory they use, with many configured local stdio servers.
//
//   node bench/server-memory.mjs [--scenario 1,2,3,real] [--adapter <checkout>]
//     [--servers 100] [--tools 50] [--runs 3] [--hold-minutes 2]
//     [--pi <pi-coding-agent dir>] [--everything <dir with node_modules>]
//     [--out <results.jsonl>]
//
// Scenario 1: no metadata cache, start a session, wait for MCP init.
// Scenario 2: valid cache, idleTimeout 1 minute; call 3 servers, wait for the
//             idle stop, call 1 again.
// Scenario 3: Pi's built-in MCP (no adapter) with the same servers.
// real:       one @modelcontextprotocol/server-everything process.
//             Install it first and pass the directory as --everything:
//             npm install --prefix /tmp/everything @modelcontextprotocol/server-everything@2026.8.31
//
// --adapter picks the checkout whose index.ts is loaded; the stub servers
// always come from this checkout. Pi (for the adapter session and for
// scenario 3) is the installed package at --pi. Everything runs in temporary
// HOME/agent/project directories, so no real config, cache, or imported host
// config is read. Stub servers get a `--bench-run=<pid>` argument, and only
// processes with this run's tag are counted or killed, so tests or another
// bench using the same fixture are left alone. Each result line is printed and, with --out,
// appended to that file as soon as it is measured. Interrupting the bench
// kills everything it started.
//
// Run one 100-server scenario at a time on an otherwise quiet machine. RSS is
// an estimate: shared pages are counted per process, and macOS memory
// compression moves totals between runs, so compare process counts first.
// Not part of CI; there are no thresholds.
import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values: opts } = parseArgs({
  options: {
    scenario: { type: "string", default: "1,2" },
    adapter: { type: "string", default: repo },
    servers: { type: "string", default: "100" },
    tools: { type: "string", default: "50" },
    runs: { type: "string", default: "3" },
    "hold-minutes": { type: "string", default: "2" },
    pi: { type: "string", default: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent" },
    everything: { type: "string" },
    out: { type: "string" },
  },
});
const fixture = join(repo, "__tests__/fixtures/tools-only-server.mjs");
const serverTag = `--bench-run=${process.pid}`;
const serverCount = Number(opts.servers);
const toolCount = Number(opts.tools);
const runCount = Number(opts.runs);
const adapterEntry = join(resolve(opts.adapter), "index.ts");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mib = kib => Math.round(kib / 1024);

function record(result) {
  const line = JSON.stringify(result);
  console.log(line);
  if (opts.out) appendFileSync(opts.out, `${line}\n`);
}

// Everything the bench starts, so an interrupt can stop it: direct children,
// plus command-line matches for processes they spawn.
const children = new Set();
const cleanupMatches = new Set([serverTag]);
const tempRoots = new Set();
const samplers = new Set();
function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function cleanup() {
  for (const sampler of samplers) sampler.stopped = true;
  for (const child of children) child.kill("SIGKILL");
  let killed = 0;
  for (const match of cleanupMatches) killed += await killLeftovers(match);
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  return killed;
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, async () => {
    const killed = await cleanup();
    console.error(`${signal}: stopped ${killed} leftover server processes`);
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
  });
}
process.once("exit", () => { for (const child of children) child.kill("SIGKILL"); });

// --- process sampling --------------------------------------------------------

async function processes() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,rss=,command="], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split("\n").filter(Boolean).map(line => {
    const [, pid, rss, command] = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return { pid: Number(pid), rssKiB: Number(rss), command };
  });
}

async function sample(match, hostPid) {
  const all = await processes();
  const servers = all.filter(p => p.command.includes(match));
  return {
    live: servers.length,
    serverRssKiB: servers.reduce((sum, p) => sum + p.rssKiB, 0),
    hostRssKiB: all.find(p => p.pid === hostPid)?.rssKiB ?? 0,
  };
}

function startSampler(match, hostPid, origin = Date.now()) {
  const state = { peak: 0, timeline: [], last: undefined, stopped: false };
  samplers.add(state);
  const loop = (async () => {
    while (!state.stopped) {
      const s = await sample(match, hostPid);
      state.peak = Math.max(state.peak, s.live);
      if (s.live !== state.last) state.timeline.push([Math.round((Date.now() - origin) / 1000), s.live]);
      state.last = s.live;
      await sleep(250);
    }
  })();
  state.stop = async () => { state.stopped = true; samplers.delete(state); await loop; };
  return state;
}

async function waitForLive(match, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await sample(match, 0);
    if (predicate(s.live)) return s;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for live servers; last count ${s.live}`);
    await sleep(250);
  }
}

async function killLeftovers(match) {
  const left = (await processes()).filter(p => p.command.includes(match));
  for (const p of left) {
    try {
      process.kill(p.pid, "SIGKILL");
    } catch (error) {
      // It exited between the ps listing and the kill.
      if (error.code !== "ESRCH") throw error;
    }
  }
  return left.length;
}

// --- fixtures ----------------------------------------------------------------

function makeDirs(label) {
  const root = mkdtempSync(join(tmpdir(), `pi-mcp-bench-${label}-`));
  tempRoots.add(root);
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(projectDir);
  return { root, agentDir, projectDir };
}

function isolatedEnv(dirs) {
  const { PI_PACKAGE_DIR, ...env } = process.env;
  return { ...env, HOME: dirs.root, PI_CODING_AGENT_DIR: dirs.agentDir };
}

function mcpServers() {
  return Object.fromEntries(Array.from({ length: serverCount }, (_, i) => [
    `s${String(i).padStart(3, "0")}`,
    { command: process.execPath, args: [fixture, "--tools", String(toolCount), serverTag] },
  ]));
}

// --- adapter session child ---------------------------------------------------

function startSession(dirs) {
  const child = track(spawn(process.execPath, ["--import", "tsx", join(repo, "bench/session.ts")], {
    cwd: repo,
    env: { ...isolatedEnv(dirs), BENCH_ADAPTER: adapterEntry, BENCH_PROJECT_DIR: dirs.projectDir, BENCH_PI: resolve(opts.pi) },
    stdio: ["pipe", "pipe", "inherit"],
  }));
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise(resolve => child.once("exit", resolve));
  return {
    pid: child.pid,
    async send(command) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      for (;;) {
        const next = await Promise.race([replies.next(), exited.then(code => ({ exit: code }))]);
        if ("exit" in next) throw new Error(`Bench session exited with ${next.exit}`);
        if (next.done) throw new Error("Bench session closed stdout");
        if (next.value.startsWith("{\"op\"")) return JSON.parse(next.value);
      }
    },
    async shutdown() {
      await this.send({ op: "shutdown" });
      await exited;
    },
  };
}

function writeAdapterConfig(dirs, settings = {}) {
  writeFileSync(join(dirs.agentDir, "mcp-adapter.json"), JSON.stringify({ mcpServers: mcpServers(), settings }));
}

async function scenario1(run) {
  const dirs = makeDirs("s1");
  try {
    writeAdapterConfig(dirs);
    const session = startSession(dirs);
    const sampler = startSampler(serverTag, session.pid);
    const ready = await session.send({ op: "ready" });
    await sleep(1000);
    await sampler.stop();
    const after = await sample(serverTag, session.pid);
    await session.shutdown();
    const leftovers = await killLeftovers(serverTag);
    return {
      scenario: 1, run,
      piVersion: ready.piVersion,
      readyMs: Math.round(ready.ms),
      peakLive: sampler.peak,
      liveAfterReady: after.live,
      serverRssAfterReadyMiB: mib(after.serverRssKiB),
      hostRssMiB: mib(after.hostRssKiB),
      cacheMiB: +(statSync(join(dirs.agentDir, "mcp-cache.json")).size / 2 ** 20).toFixed(1),
      cacheWrites: ready.cacheWrites,
      cacheIoMs: Math.round(ready.cacheIoMs),
      maxLoopDelayMs: Math.round(ready.maxLoopDelayMs),
      leftoversAfterShutdown: leftovers,
    };
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

async function scenario2(run) {
  const dirs = makeDirs("s2");
  try {
    // Build a valid cache first, then start a fresh session against it.
    writeAdapterConfig(dirs, { idleTimeout: 1 });
    const warm = startSession(dirs);
    await warm.send({ op: "ready" });
    await warm.shutdown();
    await killLeftovers(serverTag);

    const origin = Date.now();
    const session = startSession(dirs);
    const sampler = startSampler(serverTag, session.pid, origin);
    const ready = await session.send({ op: "ready" });
    const liveAtReady = (await sample(serverTag, session.pid)).live;
    const firstCalls = [];
    for (const server of ["s000", "s001", "s002"]) firstCalls.push(Math.round((await session.send({ op: "call", server })).ms));
    const liveAfterCalls = (await sample(serverTag, session.pid)).live;
    const lastCall = Date.now();
    await waitForLive(serverTag, live => live === 0, 3 * 60_000);
    const idleStopSec = Math.round((Date.now() - lastCall) / 1000);
    const reconnect = await session.send({ op: "call", server: "s000" });
    const after = await sample(serverTag, session.pid);
    await sampler.stop();
    await session.shutdown();
    const leftovers = await killLeftovers(serverTag);
    return {
      scenario: 2, run,
      piVersion: ready.piVersion,
      readyMs: Math.round(ready.ms),
      liveAtReady,
      firstCallMs: firstCalls,
      liveAfterCalls,
      idleStopSecAfterLastCall: idleStopSec,
      reconnectMs: Math.round(reconnect.ms),
      liveAfterReconnect: after.live,
      peakLive: sampler.peak,
      timelineSecLive: sampler.timeline,
      hostRssMiB: mib(after.hostRssKiB),
      leftoversAfterShutdown: leftovers,
    };
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

// --- Pi built-in MCP ---------------------------------------------------------

async function scenario3() {
  const piPackage = JSON.parse(readFileSync(join(opts.pi, "package.json"), "utf8"));
  const dirs = makeDirs("s3");
  try {
    // The built-in reads <agentDir>/mcp.json. No adapter and no settings.json,
    // so nothing disables it with `-builtin:mcp`.
    writeFileSync(join(dirs.agentDir, "mcp.json"), JSON.stringify({ mcpServers: mcpServers() }));
    const start = Date.now();
    // RPC mode with stdin held open keeps the session alive without a model call.
    const child = track(spawn(process.execPath, [join(opts.pi, piPackage.bin.pi), "--mode", "rpc", "--no-session"], {
      cwd: dirs.projectDir,
      env: isolatedEnv(dirs),
      stdio: ["pipe", "ignore", "inherit"],
    }));
    const exited = new Promise(resolve => child.once("exit", resolve));
    const sampler = startSampler(serverTag, child.pid);
    await waitForLive(serverTag, live => live >= serverCount, 120_000);
    const readyMs = Date.now() - start;
    await sleep(2000);
    const atReady = await sample(serverTag, child.pid);
    await sleep(Number(opts["hold-minutes"]) * 60_000);
    const afterHold = await sample(serverTag, child.pid);
    await sampler.stop();
    child.stdin.end();
    const exitTimer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    await exited;
    clearTimeout(exitTimer);
    await sleep(500);
    const leftovers = await killLeftovers(serverTag);
    const settingsPath = join(dirs.agentDir, "settings.json");
    let settings = "(none)";
    try { settings = readFileSync(settingsPath, "utf8"); } catch {}
    return {
      scenario: 3,
      piVersion: piPackage.version,
      builtinDisabledInSettings: settings.includes("-builtin:mcp"),
      readyMs,
      peakLive: sampler.peak,
      liveAtReady: atReady.live,
      serverRssAtReadyMiB: mib(atReady.serverRssKiB),
      hostRssAtReadyMiB: mib(atReady.hostRssKiB),
      holdMinutes: Number(opts["hold-minutes"]),
      liveAfterHold: afterHold.live,
      serverRssAfterHoldMiB: mib(afterHold.serverRssKiB),
      leftoversAfterExit: leftovers,
    };
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

// --- one real server ---------------------------------------------------------

async function realServer(run) {
  const packageDir = join(resolve(opts.everything), "node_modules/@modelcontextprotocol/server-everything");
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const bin = join(packageDir, typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0]);
  cleanupMatches.add(bin);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "bench", version: "1.0.0" });
  const start = performance.now();
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "stdio"], stderr: "ignore" }));
  const { tools } = await client.listTools();
  const coldStartMs = Math.round(performance.now() - start);
  await sleep(1000);
  const s = await sample(bin, 0);
  await client.close();
  await sleep(500);
  return { scenario: "real", run, version: pkg.version, coldStartMs, tools: tools.length, processes: s.live, rssMiB: mib(s.serverRssKiB), leftovers: await killLeftovers(bin) };
}

// --- main --------------------------------------------------------------------

const scenarios = opts.scenario.split(",");
const { stdout: gitHead } = await execFileAsync("git", ["-C", resolve(opts.adapter), "rev-parse", "--short", "HEAD"]);
record({
  machine: `${cpus()[0].model}, ${cpus().length} cores, ${arch()}`,
  os: `${process.platform} ${release()}`,
  node: process.version,
  adapter: `${resolve(opts.adapter)} @ ${gitHead.trim()}`,
  servers: serverCount,
  toolsPerServer: toolCount,
});
try {
  for (const name of scenarios) {
    if (name === "1") for (let run = 1; run <= runCount; run++) record(await scenario1(run));
    if (name === "2") for (let run = 1; run <= runCount; run++) record(await scenario2(run));
    if (name === "3") record(await scenario3());
    if (name === "real") for (let run = 1; run <= runCount; run++) record(await realServer(run));
  }
} finally {
  const left = await cleanup();
  if (left > 0) console.error(`Killed ${left} leftover server processes`);
}
