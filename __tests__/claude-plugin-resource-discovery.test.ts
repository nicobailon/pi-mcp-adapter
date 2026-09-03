import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Claude plugin skill resource discovery", () => {
  it("discovers plugin skills on startup and refreshes them on reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-claude-resources-"));
    roots.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const plugin = join(cwd, "plugin");
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(join(plugin, ".claude-plugin"), { recursive: true }),
      mkdir(join(plugin, "skills", "first-skill"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "resource-fixture" })),
      writeFile(join(plugin, "skills", "first-skill", "SKILL.md"), "---\nname: first-skill\ndescription: First fixture skill\n---\n"),
      writeFile(join(cwd, ".mcp.json"), JSON.stringify({
        claudePlugins: [{ path: plugin, skills: true }],
        mcpServers: {},
      })),
    ]);

    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [resolve("index.ts")],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      noTools: "all",
    });
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
    expect(loader.getSkills().skills.map(skill => skill.name)).toContain("first-skill");

    await mkdir(join(plugin, "skills", "second-skill"), { recursive: true });
    await writeFile(join(plugin, "skills", "second-skill", "SKILL.md"), "---\nname: second-skill\ndescription: Second fixture skill\n---\n");
    await session.reload();

    expect(errors).toEqual([]);
    expect(loader.getSkills().skills.map(skill => skill.name)).toEqual(expect.arrayContaining(["first-skill", "second-skill"]));
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
    session.dispose();
  });
});
