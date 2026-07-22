import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reload harness condition");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}


async function createReloadHarness() {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-reload-real-path-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await writeFile(join(root, "placeholder"), "ok");
  await Promise.all([
    import("node:fs/promises").then(({ mkdir }) => mkdir(agentDir, { recursive: true })),
    import("node:fs/promises").then(({ mkdir }) => mkdir(cwd, { recursive: true })),
  ]);
  const pidDir = join(root, "pids");
  await mkdir(pidDir, { recursive: true });
  const configPath = join(root, "mcp.json");
  await writeFile(configPath, JSON.stringify({
    mcpServers: {
      delayed: {
        command: process.execPath,
        args: [resolve("__tests__/fixtures/delayed-mcp-server.mjs")],
        env: { MCP_RELOAD_PID_DIR: pidDir },
        debug: true,
        lifecycle: "eager",
      },
    },
    settings: { sampling: false, elicitation: false },
  }));
  process.argv.push("--mcp-config", configPath);

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [resolve("index.ts")],
  });
  await loader.reload();
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const errors: Array<{ error: string; stack?: string }> = [];
  const statusCalls: string[] = [];
  const ui = new Proxy({
    notify: () => undefined,
    setStatus: (_key: string, value: unknown) => statusCalls.push(String(value)),
    theme: { fg: (_color: string, value: string) => value },
  } as any, {
    get(target, property, receiver) { return Reflect.get(target, property, receiver); },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    authStorage,
    modelRegistry,
    noTools: "all",
  });
  await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(error) });
  return {
    session,
    errors,
    statusCalls,
    pidDir,
    cleanupArgv: () => process.argv.splice(process.argv.lastIndexOf("--mcp-config"), 2),
  };
}

describe("Pi registered extension reload Real Path", () => {
  it("repeatedly reloads during eager initialization without stale ctx or duplicate processes", async () => {
    const harness = await createReloadHarness();
    try {
      await harness.session.reload();
      await harness.session.reload();
      await waitFor(() => harness.statusCalls.some(value => value.includes("MCP: 1/"))).catch(error => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; errors=${JSON.stringify(harness.errors)}; statuses=${JSON.stringify(harness.statusCalls)}`);
      });
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(harness.errors.map(error => `${error.error}\n${error.stack ?? ""}`).join("\n"))
        .not.toContain("This extension ctx is stale after session replacement or reload");
      const tools = harness.session.extensionRunner.getAllRegisteredTools().map(tool => tool.definition.name);
      expect(tools.filter(name => name === "mcp")).toHaveLength(1);
      expect(harness.statusCalls.filter(value => value.includes("MCP: 1/"))).toHaveLength(1);

      await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      harness.cleanupArgv();
      harness.session.dispose();
    }
  });
});
