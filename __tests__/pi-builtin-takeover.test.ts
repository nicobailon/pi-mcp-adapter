import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

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

  /** Loads the extensions next to a fake replaceable built-in that registers /mcp, as Pi's does. */
  async function loadWithBuiltin(options: { additionalExtensionPaths?: string[]; extensionFactories?: InlineExtension[] }) {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: options.additionalExtensionPaths ?? [],
      extensionFactories: [{
        name: "mcp",
        builtin: true,
        replaceable: true,
        factory: (pi) => pi.registerCommand("mcp", { description: "built-in", handler: async () => {} }),
      }, ...options.extensionFactories ?? []],
    });
    await loader.reload();
    return loader.getExtensions();
  }

  it("leaves out the replaceable built-in, which registers /mcp during load", async () => {
    const adapterPath = join(process.cwd(), "index.ts");
    const { extensions, warnings } = await loadWithBuiltin({ additionalExtensionPaths: [adapterPath] });

    expect(extensions.map((extension) => extension.path)).not.toContain("builtin:mcp");
    expect(extensions.find((extension) => extension.path === adapterPath)?.commands.has("mcp")).toBe(true);
    expect(warnings).toContainEqual(expect.objectContaining({ path: "builtin:mcp" }));
  }, 20_000);

  it("keeps the built-in when a host supplies its own config", async () => {
    const { createMcpAdapter } = await import("../index.ts");
    const { extensions } = await loadWithBuiltin({
      extensionFactories: [{ name: "adapter", factory: createMcpAdapter({ config: { mcpServers: {} } }) }],
    });

    expect(extensions.map((extension) => extension.path)).toContain("builtin:mcp");
    const adapter = extensions.find((extension) => extension.path === "<inline:adapter>");
    expect(adapter?.commands.has("mcp-adapter")).toBe(true);
    expect(adapter?.commands.has("mcp")).toBe(false);
  }, 20_000);
});
