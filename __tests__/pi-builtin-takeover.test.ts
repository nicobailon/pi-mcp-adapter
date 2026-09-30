import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("replacing Pi's built-in MCP extension", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-builtin-takeover-")));
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves out the replaceable built-in, which registers /mcp during load", async () => {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [join(process.cwd(), "index.ts")],
      extensionFactories: [{
        name: "mcp",
        builtin: true,
        replaceable: true,
        factory: (pi) => pi.registerCommand("mcp", { description: "built-in", handler: async () => {} }),
      }],
    });
    await loader.reload();

    const { extensions, warnings } = loader.getExtensions();
    expect(extensions.map((extension) => extension.path)).not.toContain("builtin:mcp");
    const adapter = extensions.find((extension) => extension.path === join(process.cwd(), "index.ts"));
    expect(adapter?.commands.has("mcp")).toBe(true);
    expect(warnings).toContainEqual(expect.objectContaining({ path: "builtin:mcp" }));
  }, 20_000);
});
