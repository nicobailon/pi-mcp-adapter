import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const tempHomes: string[] = [];

async function loadConfigModule() {
  vi.resetModules();
  return import("../config.ts");
}

function createTestHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-mcp-adapter-home-"));
  tempHomes.push(home);
  process.env.HOME = home;
  process.chdir(home);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "mcp.json"),
    JSON.stringify({ imports: ["codex"], mcpServers: {} }),
  );
  return home;
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.chdir(originalCwd);
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("loadMcpConfig imports", () => {
  it("imports Codex MCP servers from config.toml", async () => {
    const home = createTestHome();

    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        '[mcp_servers.context7]',
        'url = "https://mcp.context7.com/mcp"',
        '',
        '[mcp_servers.serena]',
        'command = "uvx"',
        'args = ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"]',
      ].join("\n"),
    );

    const { loadMcpConfig } = await loadConfigModule();
    const config = loadMcpConfig();

    expect(config.mcpServers.context7).toEqual({
      url: "https://mcp.context7.com/mcp",
    });
    expect(config.mcpServers.serena).toEqual({
      command: "uvx",
      args: ["--from", "git+https://github.com/oraios/serena", "serena", "start-mcp-server"],
    });
  });

  it("falls back to Codex config.json when config.toml is absent", async () => {
    const home = createTestHome();

    writeFileSync(
      join(home, ".codex", "config.json"),
      JSON.stringify({
        mcpServers: {
          exa: {
            url: "https://mcp.exa.ai/mcp",
          },
        },
      }),
    );

    const { loadMcpConfig } = await loadConfigModule();
    const config = loadMcpConfig();

    expect(config.mcpServers.exa).toEqual({
      url: "https://mcp.exa.ai/mcp",
    });
  });

  it("falls back to Codex config.json when config.toml is invalid", async () => {
    const home = createTestHome();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.exa\nurl = \"broken\"\n");
    writeFileSync(
      join(home, ".codex", "config.json"),
      JSON.stringify({
        mcpServers: {
          exa: {
            url: "https://mcp.exa.ai/mcp",
          },
        },
      }),
    );

    const { loadMcpConfig } = await loadConfigModule();
    const config = loadMcpConfig();

    expect(config.mcpServers.exa).toEqual({
      url: "https://mcp.exa.ai/mcp",
    });
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("getServerProvenance imports", () => {
  it("falls back to Codex config.json when config.toml is invalid", async () => {
    const home = createTestHome();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.exa\nurl = \"broken\"\n");
    writeFileSync(
      join(home, ".codex", "config.json"),
      JSON.stringify({
        mcpServers: {
          exa: {
            url: "https://mcp.exa.ai/mcp",
          },
        },
      }),
    );

    const { getServerProvenance } = await loadConfigModule();
    const provenance = getServerProvenance();

    expect(provenance.get("exa")).toEqual({
      path: join(home, ".pi", "agent", "mcp.json"),
      kind: "import",
      importKind: "codex",
    });
    expect(warnSpy).toHaveBeenCalled();
  });
});
