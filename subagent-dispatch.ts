/**
 * subagent-dispatch.ts — Tutoria fork addition.
 *
 * Spawns a child Pi process to execute a single MCP tool call inside an
 * isolated agent context. Returns the child's final assistant text, so the
 * heavy MCP payload (firecrawl HTML, large search results, etc.) stays in
 * the subagent's process and does not enter the parent's chat context.
 *
 * Implements Path 3 (ADAPTER-LEVEL fork) from Scout γ's verdict in
 * ~/workstreams/active/pi-ui-declutter/findings/2026-05-07-scout-synthesis.md.
 *
 * Recursion guard: PI_SUBAGENT_CHILD env var. If a child Pi has this fork
 * loaded too, its `routeViaSubagent` interception is skipped, preventing
 * infinite recursion.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const DEFAULT_AGENT = "delegate";
const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes per MCP call via subagent

/**
 * Returns true if the current Pi process is itself a subagent child. Caller
 * should skip the `routeViaSubagent` interception in that case.
 */
export function isSubagentChild(): boolean {
  return process.env[SUBAGENT_CHILD_ENV] === "1";
}

/**
 * Locate the agent .md file. Resolution order:
 *   1. ~/.pi/agents/<name>.md (operator override)
 *   2. <pi-subagents npm pkg>/agents/<name>.md (bundled, e.g. delegate.md)
 * Returns the absolute path, or null if not found.
 */
function resolveAgentFile(agentName: string): string | null {
  const home = os.homedir();
  const operatorPath = path.join(home, ".pi", "agents", `${agentName}.md`);
  if (fs.existsSync(operatorPath)) return operatorPath;

  // Search upward from this file for an installed pi-subagents package.
  const searchRoots = [
    path.join(home, ".npm-global", "lib", "node_modules", "pi-subagents", "agents"),
    path.join(home, ".npm-global", "lib", "node_modules", "@mjakl", "pi-subagent", "agents"),
  ];
  for (const root of searchRoots) {
    const candidate = path.join(root, `${agentName}.md`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Strip frontmatter from a Markdown agent file and return the body
 * (the system prompt). If no frontmatter, returns the full file content.
 */
function readAgentSystemPrompt(agentFile: string): string {
  const raw = fs.readFileSync(agentFile, "utf-8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  return m ? m[2].trim() : raw.trim();
}

export interface DispatchResult {
  ok: boolean;
  text: string;
  /** Stderr captured from the child, useful for debugging. */
  stderr?: string;
  /** Reason for failure if !ok. */
  error?: string;
}

/**
 * Build the task prompt for the subagent. Plain text so the LLM has
 * minimum ceremony to parse.
 */
function buildTaskPrompt(toolName: string, args: Record<string, unknown> | undefined): string {
  const argsStr = args ? JSON.stringify(args, null, 2) : "{}";
  return [
    `You have been delegated a single MCP tool call. Execute it once and return a synthesized result.`,
    ``,
    `MCP tool: ${toolName}`,
    `Arguments:`,
    "```json",
    argsStr,
    "```",
    ``,
    `Instructions:`,
    `- Call the named MCP tool ONCE with the given arguments.`,
    `- Synthesize the result into a concise answer (<=400 words).`,
    `- Return only the synthesis. Do not chain to other tools. Do not editorialize.`,
    `- If the tool errors, return the error message verbatim.`,
  ].join("\n");
}

/**
 * Dispatch an MCP tool call through a subagent (child Pi process).
 * Returns the child's final assistant text on success.
 */
export async function dispatchViaSubagent(input: {
  toolName: string;
  args?: Record<string, unknown>;
  agentName?: string;
  timeoutMs?: number;
  serverName?: string;
}): Promise<DispatchResult> {
  const agentName = input.agentName ?? DEFAULT_AGENT;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const agentFile = resolveAgentFile(agentName);
  if (!agentFile) {
    return { ok: false, text: "", error: `agent file not found: ${agentName}` };
  }

  let systemPrompt: string;
  try {
    systemPrompt = readAgentSystemPrompt(agentFile);
  } catch (err) {
    return { ok: false, text: "", error: `read agent file failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Materialize the system prompt + task into a temp dir so we can pass file
  // paths to Pi (avoids 8K argv limit and quoting headaches).
  let tempDir: string | undefined;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-subagent-"));
    const promptPath = path.join(tempDir, "agent.md");
    fs.writeFileSync(promptPath, systemPrompt, { mode: 0o600 });
    const taskPath = path.join(tempDir, "task.md");
    fs.writeFileSync(taskPath, buildTaskPrompt(input.toolName, input.args), { mode: 0o600 });

    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--append-system-prompt", promptPath,
      `@${taskPath}`,
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [SUBAGENT_CHILD_ENV]: "1",
    };

    const result = await runChild("pi", args, env, timeoutMs);
    return result;
  } catch (err) {
    return { ok: false, text: "", error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/**
 * Spawn the child Pi, parse its JSONL stdout to extract the final assistant
 * text, and time-out hard at `timeoutMs`. JSONL line shape (from
 * pi-subagents/runs/foreground/execution.ts:404-481):
 *   { type: "message_end", message: { role: "assistant", content: [{type:"text", text:"..."}], stopReason: "stop", ... } }
 */
function runChild(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<DispatchResult> {
  return new Promise((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let lastAssistantText = "";
    let settled = false;

    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      resolve({ ok: false, text: lastAssistantText, stderr: stderrBuf, error: `subagent timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timeoutHandle.unref?.();

    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      let evt: { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
      try { evt = JSON.parse(line); } catch { return; }
      if (evt.type === "message_end" && evt.message?.role === "assistant" && Array.isArray(evt.message.content)) {
        for (const part of evt.message.content) {
          if (part.type === "text" && typeof part.text === "string") {
            lastAssistantText = part.text;
          }
        }
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      lines.forEach(consumeLine);
    });

    proc.stderr.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ ok: false, text: lastAssistantText, stderr: stderrBuf, error: `spawn error: ${err.message}` });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      if (stdoutBuf.trim()) consumeLine(stdoutBuf);
      if (code !== 0 && !lastAssistantText) {
        resolve({ ok: false, text: "", stderr: stderrBuf, error: `child exited ${code}` });
        return;
      }
      if (!lastAssistantText) {
        resolve({ ok: false, text: "", stderr: stderrBuf, error: "no assistant message in subagent output" });
        return;
      }
      resolve({ ok: true, text: lastAssistantText, stderr: stderrBuf });
    });
  });
}
