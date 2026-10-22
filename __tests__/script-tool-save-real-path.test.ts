import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadMcpConfigWithSources } from "../config.ts";
import { toolErrorOverride } from "../error-signal.ts";
import { applyProjectServerTrust } from "../project-server-trust.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Ui = { select: ReturnType<typeof vi.fn>; editor: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
interface Fixture { session: Session; ui: Ui; agentDir: string; cwd: string; configPath: string; scriptPath: string; registerForeignTool: (name: string) => void }

const CODE = 'return "hello " + input.who;';
const SAVE = { name: "greet", description: "Greet someone", code: CODE, inputSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"] } };

// A real Pi session with the adapter and Pi's codemode. The UI is a TUI whose select approves and
// whose editor returns the script unchanged, unless a test scripts them; `mode: "print"` has no UI.
// `foreignTool` is a tool another extension registers while loading, and `registerForeignTool` one it
// registers later. Needs `env -u MCP_DIRECT_TOOLS`, as the suite runs.
async function withSession(
  run: (fixture: Fixture) => Promise<void>,
  options: { settings?: Record<string, unknown>; mode?: "tui" | "print"; directTools?: string; foreignTool?: string } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-script-save-"));
  const original = { agentDir: process.env.PI_CODING_AGENT_DIR, directTools: process.env.MCP_DIRECT_TOOLS };
  let session: Session | undefined;
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(cwd)]);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    if (options.directTools !== undefined) process.env.MCP_DIRECT_TOOLS = options.directTools;
    const configPath = join(agentDir, "mcp-adapter.json");
    await writeFile(configPath, `${JSON.stringify({ mcpServers: {}, settings: options.settings ?? {} }, null, 2)}\n`);
    const settingsManager = SettingsManager.inMemory();
    const foreignTool = (name: string) => ({ name, label: "x", description: "x", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [], details: {} }) });
    let foreignPi: ExtensionAPI | undefined;
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, additionalExtensionPaths: [resolve("index.ts")],
      extensionFactories: [createCodemodeExtension(), (pi) => {
        foreignPi = pi;
        if (options.foreignTool) pi.registerTool(foreignTool(options.foreignTool));
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, noTools: "builtin",
    }));
    await session.bindExtensions({ mode: "print" });
    await session.extensionRunner.emit({ type: "agent_start" });
    // Pi runs a nested call on behalf of the assistant message that issued the calling tool.
    session.agent.state.messages = [...session.agent.state.messages, {
      role: "assistant", content: [], api: "test", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }];
    const ui: Ui = {
      select: vi.fn(async (_title: string, options: string[]) => options[1]),
      editor: vi.fn(async (_title: string, prefill: string) => prefill),
      notify: vi.fn(),
    };
    if (options.mode !== "print") session.extensionRunner.setUIContext(ui as never, "tui");
    await vi.waitFor(() => expect(session!.getAllTools().map(tool => tool.name)).toContain("mcp"), { timeout: 10_000 });
    await run({
      session, ui, agentDir, cwd, configPath, scriptPath: join(agentDir, "mcp-scripts", "greet.js"),
      registerForeignTool: (name) => { foreignPi?.registerTool(foreignTool(name)); },
    });
  } finally {
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
    } finally {
      session?.dispose();
      for (const [key, value] of [["PI_CODING_AGENT_DIR", original.agentDir], ["MCP_DIRECT_TOOLS", original.directTools]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map(block => block.text ?? "").join("");

// As Pi runs a model-issued call: its tool_call hooks first, then the tool.
async function callAs(session: Session, toolName: string, toolCallId: string, input: Record<string, unknown>, options: { signal?: AbortSignal; trusted?: boolean } = {}) {
  const runner = session.extensionRunner;
  const definition = runner.getAllRegisteredTools().find(tool => tool.definition.name === toolName)!.definition;
  await runner.emitToolCall({ type: "tool_call", toolName, toolCallId, input } as never);
  const ctx = runner.createToolContext(toolCallId, undefined);
  const toolCtx = options.trusted === undefined ? ctx : Object.create(ctx, { isProjectTrusted: { value: () => options.trusted } });
  return definition.execute(toolCallId, input as never, options.signal, undefined, toolCtx) as Promise<any>;
}

const save = (session: Session, id: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal; trusted?: boolean } = {}) =>
  callAs(session, "mcp", id, { action: "save-script", args: { ...SAVE, ...args } }, options);

describe("mcp({ action: \"save-script\" }) in a real session", () => {
  it("writes both files after the two dialogs, and the tool works in the same session", async () => {
    await withSession(async ({ session, ui, configPath, scriptPath }) => {
      const result = await save(session, "save-1");

      expect(ui.select).toHaveBeenCalledTimes(1);
      expect(ui.select.mock.calls[0]![0]).toContain('Save script tool "greet" as mcp__script__greet?');
      expect(ui.select.mock.calls[0]![1]).toEqual(["Don't save", "Review the script"]);
      expect(ui.editor).toHaveBeenCalledWith(`Review the script for mcp__script__greet (${scriptPath}). Saving writes the script and its config entry; Escape writes nothing.`, CODE);
      expect(textOf(result)).toBe(`Saved script tool "greet". Call it as mcp__script__greet or mcp({ tool: "greet", args }).\nScript: ${scriptPath}\nConfig: ${configPath}`);
      expect(result.details).toEqual({ mode: "save-script", name: "greet", tool: "mcp__script__greet", path: configPath, scriptPath, target: "global", registered: true, edited: false });
      expect(toolErrorOverride(result.details)).toBeUndefined();
      expect(readFileSync(scriptPath, "utf8")).toBe(CODE);
      expect(JSON.parse(readFileSync(configPath, "utf8")).scriptTools).toEqual({ greet: { description: SAVE.description, file: "mcp-scripts/greet.js", inputSchema: SAVE.inputSchema } });

      expect(session.getAllTools().find(tool => tool.name === "mcp__script__greet")).toMatchObject({ exposure: "deferred" });
      expect(session.getToolDefinition("mcp__script__greet")?.promptSnippet).toBeUndefined();
      expect((session.getToolDefinition("mcp")?.parameters as any).properties.action.description).toBe("Action: 'install', 'ui-messages', 'auth-start', 'auth-complete', or 'save-script'");
      expect(textOf(await callAs(session, "mcp__script__greet", "st-1", { who: "Ada" }))).toContain("hello Ada");
    });
  }, 30_000);

  it("writes nothing when either dialog is declined, and leaves existing files byte-identical", async () => {
    await withSession(async ({ session, ui, configPath, scriptPath }) => {
      await mkdir(join(scriptPath, ".."), { recursive: true });
      await writeFile(scriptPath, "return 'old';\n");
      const before = [readFileSync(configPath), readFileSync(scriptPath)];
      ui.select.mockResolvedValueOnce("Don't save");
      const atSummary = await save(session, "save-1");
      ui.editor.mockResolvedValueOnce(undefined);
      const atEditor = await save(session, "save-2");

      for (const result of [atSummary, atEditor]) {
        expect(textOf(result)).toBe("The save was declined, so nothing was written.");
        expect(result.details).toEqual({ mode: "save-script", name: "greet", error: "declined" });
      }
      expect(ui.editor).toHaveBeenCalledTimes(1);
      expect([readFileSync(configPath), readFileSync(scriptPath)]).toEqual(before);
    });
  }, 30_000);

  it("writes the script as the operator edited it, and says so", async () => {
    await withSession(async ({ session, ui, scriptPath }) => {
      ui.editor.mockResolvedValueOnce('return "hi " + input.who;');
      const result = await save(session, "save-1");

      expect(textOf(result)).toContain("The operator edited the script before saving, so the saved code differs from the code you sent.");
      expect(result.details).toMatchObject({ registered: true, edited: true });
      expect(readFileSync(scriptPath, "utf8")).toBe('return "hi " + input.who;');

      ui.editor.mockResolvedValueOnce("   ");
      expect((await save(session, "save-2", { name: "other" })).details).toEqual({ mode: "save-script", name: "other", error: "code_empty" });
    });
  }, 30_000);

  it("refuses a save from inside a codemode script, and from a print session, asking nothing", async () => {
    await withSession(async ({ session, ui, scriptPath }) => {
      const nested = await callAs(session, "codemode", "cm-1", { code: `return await tools.mcp({ action: "save-script", args: ${JSON.stringify(SAVE)} });` });

      expect(textOf(nested)).toContain('Saving a script tool cannot be requested from inside another tool. Call mcp({ action: "save-script" }) directly.');
      expect(ui.select).not.toHaveBeenCalled();
      expect(existsSync(scriptPath)).toBe(false);
    });
    await withSession(async ({ session, configPath, scriptPath }) => {
      const before = readFileSync(configPath);
      const result = await save(session, "save-1");

      expect(textOf(result)).toBe("Saving a script tool needs an interactive terminal session, because it writes files only after you approve them. This session is print.");
      expect(result.details).toEqual({ mode: "save-script", name: "greet", error: "headless" });
      expect(existsSync(join(scriptPath, ".."))).toBe(false);
      expect(readFileSync(configPath)).toEqual(before);
    }, { mode: "print" });
  }, 60_000);

  it("throws an abort before or during the dialogs, writing nothing", async () => {
    await withSession(async ({ session, ui, scriptPath }) => {
      const aborted = new AbortController();
      aborted.abort();
      await expect(save(session, "save-1", {}, { signal: aborted.signal })).rejects.toThrow();
      expect(ui.select).not.toHaveBeenCalled();

      const during = new AbortController();
      ui.select.mockImplementationOnce(async () => { during.abort(); return undefined; });
      await expect(save(session, "save-2", {}, { signal: during.signal })).rejects.toThrow();
      expect(ui.editor).not.toHaveBeenCalled();
      expect(existsSync(scriptPath)).toBe(false);
    });
  }, 30_000);

  it("needs project trust for a project save, and records the approval so the next trust check admits the tool", async () => {
    await withSession(async ({ session, ui, cwd }) => {
      const untrusted = await save(session, "save-1", { target: "project" }, { trusted: false });
      expect(untrusted.details).toEqual({ mode: "save-script", name: "greet", error: "project_trust_required" });
      expect(ui.select).not.toHaveBeenCalled();

      const trusted = await save(session, "save-2", { target: "project" }, { trusted: true });
      const projectScript = join(cwd, ".pi", "mcp-scripts", "greet.js");
      expect(trusted.details).toMatchObject({ target: "project", path: join(cwd, ".pi", "mcp-adapter.json"), scriptPath: projectScript, registered: true });
      expect(ui.select.mock.calls[0]![0]).toContain("The script file can change without asking you again.");

      const nextSession = await applyProjectServerTrust(loadMcpConfigWithSources(undefined, cwd), {
        cwd, hasUI: false, mode: "print", ui: {} as never, isProjectTrusted: () => true,
      });
      expect(nextSession.blockedScriptTools.size).toBe(0);
      expect(nextSession.config.scriptTools?.greet).toEqual({ description: SAVE.description, file: projectScript, inputSchema: SAVE.inputSchema });
    });
  }, 30_000);

  it("refuses a name another tool has, and refuses everything when allowScriptToolSave is false", async () => {
    await withSession(async ({ session, ui }) => {
      const result = await save(session, "save-1", { name: "taken" });
      expect(textOf(result)).toBe('Cannot save script tool "taken": mcp__script__taken is already registered by another extension.');
      expect(result.details).toEqual({ mode: "save-script", name: "taken", error: "name_unavailable" });
      const nullTarget = await callAs(session, "mcp", "save-2", { action: "save-script", target: "global", args: { ...SAVE, target: null } });
      expect(nullTarget.details).toEqual({ mode: "save-script", name: "greet", error: "invalid_target" });
      expect(ui.select).not.toHaveBeenCalled();
    }, { foreignTool: "mcp__script__taken" });
    await withSession(async ({ session, ui, agentDir, registerForeignTool }) => {
      // After the adapter's last sync, so only a live check sees it.
      registerForeignTool("mcp__script__late");
      const result = await save(session, "save-1", { name: "late" });
      expect(textOf(result)).toBe('Cannot save script tool "late": mcp__script__late is already registered by another extension.');
      expect(result.details).toEqual({ mode: "save-script", name: "late", error: "name_unavailable" });
      expect(ui.select).not.toHaveBeenCalled();
      expect(existsSync(join(agentDir, "mcp-scripts"))).toBe(false);
    });
    await withSession(async ({ session, ui, scriptPath }) => {
      const result = await save(session, "save-1");
      expect(result.details).toEqual({ mode: "save-script", name: "greet", error: "save_disabled" });
      expect(ui.select).not.toHaveBeenCalled();
      expect(existsSync(scriptPath)).toBe(false);
      expect(session.getToolDefinition("mcp")?.description).not.toContain("save-script");
      expect((session.getToolDefinition("mcp")?.parameters as any).properties.action.description).toBe("Action: 'install', 'ui-messages', 'auth-start', or 'auth-complete'");
    }, { settings: { allowScriptToolSave: false } });
  }, 60_000);

  it("saves without registering on a frozen surface or under MCP_DIRECT_TOOLS=__none__, and says how to reach the tool", async () => {
    await withSession(async ({ session, scriptPath }) => {
      const result = await save(session, "save-1");
      expect(textOf(result)).toContain('Saved script tool "greet". The tool surface is frozen in this session, so it is callable after /reload.');
      expect(result.details).toMatchObject({ registered: false });
      expect(existsSync(scriptPath)).toBe(true);
    }, { settings: { freezeDirectTools: true } });
    await withSession(async ({ session }) => {
      const result = await save(session, "save-1");
      expect(textOf(result)).toContain('Saved script tool "greet". This session registers no script tools, so call it with mcp({ tool: "greet", args }).');
      expect(result.details).toMatchObject({ registered: false });
      expect(textOf(await callAs(session, "mcp", "mcp-1", { tool: "greet", args: { who: "Ada" } }))).toContain("hello Ada");
    }, { directTools: "__none__" });
  }, 60_000);

  it("reports script_save_failed as an error, with no dialog for a broken config, and after an approved write fails", async () => {
    await withSession(async ({ session, ui, configPath, scriptPath }) => {
      await writeFile(configPath, "{ malformed");
      const beforeDialog = await save(session, "save-1");
      expect(beforeDialog.details.message.startsWith(`Failed to read MCP config at ${configPath}: `)).toBe(true);
      expect(textOf(beforeDialog)).toBe(`Cannot save script tool "greet": ${beforeDialog.details.message}`);
      expect(beforeDialog.details).toEqual({ mode: "save-script", name: "greet", error: "script_save_failed", message: beforeDialog.details.message });
      expect(toolErrorOverride(beforeDialog.details)).toEqual({ isError: true });
      expect(ui.select).not.toHaveBeenCalled();

      await writeFile(configPath, "{}\n");
      // The config breaks between the approval and the write.
      ui.editor.mockImplementationOnce(async (_title: string, prefill: string) => { await writeFile(configPath, "{ malformed"); return prefill; });
      const afterApproval = await save(session, "save-2");
      expect(textOf(afterApproval)).toMatch(/^The script tool was approved, but could not be saved: Failed to read MCP config at /);
      expect(afterApproval.details).toMatchObject({ error: "script_save_failed" });
      expect(toolErrorOverride(afterApproval.details)).toEqual({ isError: true });
      expect(existsSync(scriptPath)).toBe(false);
    });
  }, 30_000);

  it("writes nothing when the script file changed after the operator approved the save", async () => {
    await withSession(async ({ session, ui, configPath, scriptPath }) => {
      const before = readFileSync(configPath);
      ui.editor.mockImplementationOnce(async (_title: string, prefill: string) => {
        await mkdir(join(scriptPath, ".."), { recursive: true });
        await writeFile(scriptPath, "return 'written meanwhile';");
        return prefill;
      });
      const result = await save(session, "save-1");

      const message = "the script file or its config entry changed after you approved the save, so nothing was written";
      expect(textOf(result)).toBe(`The script tool was approved, but could not be saved: ${message}`);
      expect(result.details).toEqual({ mode: "save-script", name: "greet", error: "script_save_failed", message });
      expect(readFileSync(scriptPath, "utf8")).toBe("return 'written meanwhile';");
      expect(readFileSync(configPath)).toEqual(before);
    });
  }, 30_000);

  it("writes nothing when mcp-scripts is relinked to another folder after the operator approved the save", async () => {
    await withSession(async ({ session, ui, agentDir, configPath }) => {
      const [a, b, link] = [join(agentDir, "..", "a"), join(agentDir, "..", "b"), join(agentDir, "mcp-scripts")];
      await Promise.all([mkdir(a), mkdir(b)]);
      await symlink(a, link);
      const before = readFileSync(configPath);
      ui.editor.mockImplementationOnce(async (_title: string, prefill: string) => {
        await unlink(link);
        await symlink(b, link);
        return prefill;
      });
      const result = await save(session, "save-1");

      expect(result.details).toMatchObject({ mode: "save-script", name: "greet", error: "script_save_failed" });
      expect(result.details.message).toBe(`${link} leads to a different folder than when you approved the save, so nothing was written`);
      expect(toolErrorOverride(result.details)).toEqual({ isError: true });
      expect([existsSync(join(a, "greet.js")), existsSync(join(b, "greet.js"))]).toEqual([false, false]);
      expect(readFileSync(configPath)).toEqual(before);
    });
  }, 30_000);

  it("replaces a tool it saved earlier in the session, and the new code runs", async () => {
    await withSession(async ({ session, scriptPath }) => {
      await save(session, "save-1");
      const replaced = await save(session, "save-2", { code: 'return "goodbye " + input.who;' });

      expect(replaced.details).toMatchObject({ tool: "mcp__script__greet", registered: true, edited: false });
      expect(readFileSync(scriptPath, "utf8")).toBe('return "goodbye " + input.who;');
      expect(textOf(await callAs(session, "mcp__script__greet", "st-1", { who: "Ada" }))).toContain("goodbye Ada");
    });
  }, 30_000);

  it("refuses a global save of a name a project config defines, naming that file", async () => {
    await withSession(async ({ session, ui, cwd, scriptPath }) => {
      const projectConfig = join(cwd, ".pi", "mcp-adapter.json");
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(projectConfig, JSON.stringify({ scriptTools: { greet: { description: "Project greet", file: "greet.js" } } }));
      const result = await save(session, "save-1");

      expect(result.details).toEqual({ mode: "save-script", name: "greet", error: "name_shadowed", shadowedBy: projectConfig });
      expect(ui.select).not.toHaveBeenCalled();
      expect(existsSync(scriptPath)).toBe(false);
    });
  }, 30_000);
});
