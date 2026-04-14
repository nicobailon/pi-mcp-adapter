import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
});

afterEach(() => {
  process.chdir("/");
  rmSync(tempDir, { recursive: true, force: true });
});

describe("config loading", () => {
  it("loads .mcp.json from the opened project directory", async () => {
    process.chdir(tempDir);
    writeFileSync(join(tempDir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        local: { command: "npx", args: ["-y", "local-server"] },
      },
    }));

    const { loadMcpConfig } = await import("../config.js");
    const config = loadMcpConfig(join(tempDir, "missing-user-config.json"));

    expect(config.mcpServers.local).toEqual({ command: "npx", args: ["-y", "local-server"] });
  });

  it("loads editor-specific local project MCP files", async () => {
    process.chdir(tempDir);
    mkdirSync(join(tempDir, ".cursor"), { recursive: true });
    mkdirSync(join(tempDir, ".windsurf"), { recursive: true });
    mkdirSync(join(tempDir, ".claude"), { recursive: true });
    mkdirSync(join(tempDir, ".codex"), { recursive: true });
    mkdirSync(join(tempDir, ".vscode"), { recursive: true });

    writeFileSync(join(tempDir, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: { cursorLocal: { command: "cursor" } },
    }));
    writeFileSync(join(tempDir, ".windsurf", "mcp.json"), JSON.stringify({
      "mcp-servers": { windsurfLocal: { command: "windsurf" } },
    }));
    writeFileSync(join(tempDir, ".claude", "mcp.json"), JSON.stringify({
      mcpServers: { claudeLocal: { command: "claude" } },
    }));
    writeFileSync(join(tempDir, ".codex", "config.json"), JSON.stringify({
      mcpServers: { codexLocal: { command: "codex" } },
    }));
    writeFileSync(join(tempDir, ".vscode", "mcp.json"), JSON.stringify({
      mcpServers: { vscodeLocal: { command: "code" } },
    }));

    const { loadMcpConfig } = await import("../config.js");
    const config = loadMcpConfig(join(tempDir, "missing-user-config.json"));

    expect(Object.keys(config.mcpServers).sort()).toEqual([
      "claudeLocal",
      "codexLocal",
      "cursorLocal",
      "vscodeLocal",
      "windsurfLocal",
    ]);
  });

  it("prefers nearer project configs over parent directories", async () => {
    const root = join(tempDir, "workspace");
    const child = join(root, "apps", "demo");
    mkdirSync(child, { recursive: true });

    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { shared: { command: "root" } },
    }));
    writeFileSync(join(child, ".mcp.json"), JSON.stringify({
      mcpServers: { shared: { command: "child" } },
    }));

    process.chdir(child);
    const { loadMcpConfig, getServerProvenance } = await import("../config.js");
    const config = loadMcpConfig(join(tempDir, "missing-user-config.json"));
    const provenance = getServerProvenance(join(tempDir, "missing-user-config.json"));

    expect(config.mcpServers.shared).toEqual({ command: "child" });
    expect(provenance.get("shared")).toEqual({ path: join(child, ".mcp.json"), kind: "project" });
  });

  it("lets .pi/mcp.json override imported and local project configs", async () => {
    process.chdir(tempDir);
    writeFileSync(join(tempDir, ".mcp.json"), JSON.stringify({
      mcpServers: { same: { command: "generic" } },
    }));
    mkdirSync(join(tempDir, ".pi"), { recursive: true });
    writeFileSync(join(tempDir, ".pi", "mcp.json"), JSON.stringify({
      mcpServers: { same: { command: "pi" } },
      settings: { toolPrefix: "none" },
    }));

    const { loadMcpConfig } = await import("../config.js");
    const config = loadMcpConfig(join(tempDir, "missing-user-config.json"));

    expect(config.mcpServers.same).toEqual({ command: "pi" });
    expect(config.settings).toEqual({ toolPrefix: "none" });
  });
});
