// Dev-only benchmark: token cost of MCP tasks with Pi's built-in MCP and with
// this adapter. Results are in docs/pi-builtin-comparison.md#measured-token-cost.
//
//   node bench/token-cost/run.mjs [--setups builtin,adapter,scripts]
//     [--tasks single,prose,filter,batch,pipe] [--runs 3] [--concurrency 5]
//     [--model gpt=openai-codex/gpt-6.1-sol] [--model claude=anthropic/claude-sonnet-5]
//     [--extension <path>] [--adapter <checkout>] [--out <dir>]
//
// Setups:
//   builtin  Pi's built-in MCP with its default codemode exposure:
//            pi -ne -e builtin:mcp -e builtin:codemode -e builtin:tool-search
//   adapter  this adapter with default settings (scripts off)
//   scripts  this adapter with settings.scriptMode: true, bulk tasks only
//            (filter, batch, pipe)
//
// Each run is a headless `pi -p` session in its own directory under --out
// (default: a new temp directory) with two local test servers from server.mjs:
// an issue tracker (150 issues, 70 pull requests) and a notes service. Every
// answer is checked against data.mjs, and write tasks against the servers'
// call log. The run uses your installed `pi` and its model credentials; each
// --model takes a label and a provider/id, and --extension loads an extra
// extension such as a provider bridge. The summary prints median tokens and
// cost per task, setup, and model. Cost is the provider-reported cost; when a
// provider reports none, it is computed at Claude Sonnet prices ($3 per million
// input tokens, $3.75 cache write, $0.30 cache read, $15 output).
// Not part of CI; there are no thresholds.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { truth } from "./data.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: opts } = parseArgs({
  options: {
    setups: { type: "string", default: "builtin,adapter,scripts" },
    tasks: { type: "string", default: "single,prose,filter,batch,pipe" },
    runs: { type: "string", default: "3" },
    concurrency: { type: "string", default: "5" },
    model: { type: "string", multiple: true, default: ["gpt=openai-codex/gpt-6.1-sol", "claude=anthropic/claude-sonnet-5"] },
    extension: { type: "string", multiple: true, default: [] },
    adapter: { type: "string", default: resolve(here, "../..") },
    out: { type: "string" },
  },
});
const models = Object.fromEntries(opts.model.map((m) => { const at = m.indexOf("="); if (at < 1) throw new Error(`--model ${m}: use label=provider/id`); return [m.slice(0, at), m.slice(at + 1)]; }));
const setups = opts.setups.split(",");
for (const s of setups) if (!["builtin", "adapter", "scripts"].includes(s)) throw new Error(`unknown setup ${s}`);
const out = opts.out ? resolve(opts.out) : mkdtempSync(join(tmpdir(), "pi-mcp-token-cost-"));

const numbers = (text) => new Set((text.match(/\d+/g) ?? []).map(Number));
const tasks = {
  filter: {
    bulk: true,
    prompt: "Using the tracker MCP server: find open issues labeled `bug` whose updated_at is before 2026-08-01 and that have no linking PR. A PR links an issue when its body contains `Fixes #N` or `Closes #N` (any case) and the PR is open or merged; ignore PRs that were closed without merging. Reply with only the matching issue numbers, ascending, comma-separated.",
    check: ({ answer }) => {
      const got = numbers(answer), want = new Set(truth.orphanBugs);
      const hit = [...got].filter((n) => want.has(n)).length;
      return { ok: hit === want.size && got.size === want.size, detail: `${hit}/${want.size} found, ${got.size - hit} extra` };
    },
  },
  batch: {
    bulk: true,
    prompt: "Using the tracker MCP server: close every open issue that has the `stale` label, posting the comment `Closing as stale.` on each. Then reply with how many issues you closed.",
    check: ({ log }) => {
      const closed = new Set(log.filter((e) => e.op === "close").map((e) => e.number));
      const commented = new Set(log.filter((e) => e.op === "comment" && e.body?.trim() === "Closing as stale.").map((e) => e.number));
      const want = truth.staleOpen;
      const good = want.filter((n) => closed.has(n) && commented.has(n)).length;
      const extra = [...closed].filter((n) => !want.includes(n)).length;
      const stray = log.filter((e) => e.op === "comment" && !want.includes(e.number)).length;
      return { ok: good === want.length && extra === 0 && stray === 0, detail: `${good}/${want.length} closed+commented, ${extra} wrong closes, ${stray} stray comments` };
    },
  },
  single: {
    prompt: "Using the tracker MCP server: what is the title of issue #42? Reply with just the title.",
    check: ({ answer }) => ({ ok: answer.toLowerCase().includes(truth.issue42Title.toLowerCase()), detail: answer.slice(0, 80) }),
  },
  prose: {
    prompt: "Using the notes MCP server's documentation search: how many times is a failed webhook delivery retried by default, and which setting changes that? Answer in one sentence.",
    check: ({ answer }) => ({ ok: /\b5\b|five/i.test(answer) && answer.includes("webhooks.retry.maxAttempts"), detail: answer.slice(0, 120) }),
  },
  pipe: {
    bulk: true,
    prompt: "Using the notes MCP server: fetch the transcript with id `standup-2026-09-28` and save its full text verbatim as a new note titled `Standup 2026-09-28`. Reply `done` when finished.",
    check: ({ log }) => {
      const notes = log.filter((e) => e.op === "note" && e.title === "Standup 2026-09-28");
      const exact = notes.some((n) => n.body === truth.transcript);
      const trimmed = notes.some((n) => n.body?.trim() === truth.transcript.trim());
      const best = notes.map((n) => n.body?.length ?? 0).join(",");
      return { ok: exact || trimmed, detail: `${notes.length} notes with the title, exact=${exact}, lengths=[${best}] want ${truth.transcript.length}` };
    },
  },
};

for (const t of opts.tasks.split(",")) if (!tasks[t]) throw new Error(`unknown task ${t}`);

const jobs = [];
for (let run = 1; run <= Number(opts.runs); run++)
  for (const model of Object.keys(models))
    for (const task of opts.tasks.split(","))
      for (const setup of setups) if (setup !== "scripts" || tasks[task].bulk) jobs.push({ id: `${model}-${task}-${setup}-${run}`, model, task, setup });

function runJob(job) {
  const dir = join(out, job.id);
  const logPath = join(dir, "server-log.jsonl");
  mkdirSync(join(dir, ".pi"), { recursive: true });
  const servers = Object.fromEntries(["tracker", "notes"].map((kind) => [kind, { command: process.execPath, args: [join(here, "server.mjs"), kind], env: { BENCH_LOG: logPath } }]));
  const common = [...opts.extension.flatMap((e) => ["-e", e]), "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-session", "--model", models[job.model], "--thinking", "medium"];
  let args;
  if (job.setup === "builtin") {
    writeFileSync(join(dir, ".pi/mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
    args = ["-p", "--mode", "json", "-ne", "-e", "builtin:mcp", "-e", "builtin:codemode", "-e", "builtin:tool-search", "--approve", ...common, tasks[job.task].prompt];
  } else {
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers, settings: { scriptMode: job.setup === "scripts" } }, null, 2));
    args = ["-p", "--mode", "json", "-ne", "-e", join(opts.adapter, "index.ts"), ...common, "--mcp-config", join(dir, "mcp.json"), tasks[job.task].prompt];
  }
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn("pi", args, { cwd: dir, env: { ...process.env, PI_MCP_CONFIG_MODE: "exclusive" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 8 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(join(dir, "events.jsonl"), stdout);
      const events = stdout.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const assistant = events.filter((e) => e.type === "message_end" && e.message.role === "assistant").map((e) => e.message);
      const sum = (k) => assistant.reduce((a, m) => a + (m.usage?.[k] ?? 0), 0);
      const input = sum("input"), cacheRead = sum("cacheRead"), cacheWrite = sum("cacheWrite"), output = sum("output");
      const reported = assistant.reduce((a, m) => a + (m.usage?.cost?.total ?? 0), 0);
      const toolCalls = {};
      for (const m of assistant) for (const c of m.content ?? []) if (c.type === "toolCall") toolCalls[c.name] = (toolCalls[c.name] ?? 0) + 1;
      const answer = (assistant.at(-1)?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const log = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const verdict = tasks[job.task].check({ answer, log });
      const first = assistant[0]?.usage ?? {};
      const result = {
        ...job, modelId: models[job.model], code, wallMs: Date.now() - started, turns: assistant.length, input, cacheRead, cacheWrite, output,
        promptTokens: input + cacheRead + cacheWrite, firstTurnPromptTokens: (first.input ?? 0) + (first.cacheRead ?? 0) + (first.cacheWrite ?? 0),
        cost: reported > 0 ? reported : (input * 3 + cacheWrite * 3.75 + cacheRead * 0.3 + output * 15) / 1e6, costReported: reported > 0,
        toolCalls, ok: verdict.ok, detail: verdict.detail, answer: answer.slice(0, 400), stderrTail: stderr.slice(-500),
      };
      writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
      console.log(`${job.id.padEnd(28)} ${verdict.ok ? "OK  " : "FAIL"} ${String(Math.round(result.wallMs / 1000)).padStart(4)}s turns=${result.turns} prompt=${result.promptTokens} out=${output} tools=${JSON.stringify(toolCalls)} ${verdict.detail}`);
      done(result);
    });
  });
}

console.log(`${jobs.length} runs in ${out}`);
const queue = [...jobs], results = [];
await Promise.all(Array.from({ length: Number(opts.concurrency) }, async () => { while (queue.length) results.push(await runJob(queue.shift())); }));

const med = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
console.log("\nmodel   task    setup    pass  prompt   out  turns  1st-turn  scripts  cents/run");
for (const model of Object.keys(models)) for (const task of opts.tasks.split(",")) for (const setup of setups) {
  const g = results.filter((r) => r.model === model && r.task === task && r.setup === setup);
  if (!g.length) continue;
  const scripts = g.reduce((a, r) => a + (r.toolCalls.codemode ?? 0) + (r.toolCalls.mcpScript ?? 0), 0);
  console.log(model.padEnd(7), task.padEnd(7), setup.padEnd(8), `${g.filter((r) => r.ok).length}/${g.length}`.padStart(4), String(med(g.map((r) => r.promptTokens))).padStart(7),
    String(med(g.map((r) => r.output))).padStart(5), String(med(g.map((r) => r.turns))).padStart(6), String(med(g.map((r) => r.firstTurnPromptTokens))).padStart(9),
    String(scripts).padStart(8), (med(g.map((r) => r.cost)) * 100).toFixed(1).padStart(10));
}
for (const r of results.filter((r) => !r.ok)) console.log("FAIL", r.id, r.detail);
