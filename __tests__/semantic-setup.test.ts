import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupSemanticSearch } from "../commands.ts";
import { loadMcpConfig, writeSemanticSearchConfig } from "../config.ts";
import type { McpExtensionState } from "../state.ts";

function state(): McpExtensionState {
  return {
    config: {
      mcpServers: {
        zeta: { command: "zeta" },
        disabled: { command: "disabled", disabled: true },
        alpha: { command: "alpha" },
      },
    },
  } as McpExtensionState;
}

/** Pi's model registry with the given classifier models, each with a credential. */
function modelRegistry(models: string[]) {
  return {
    findOfType: vi.fn((_type: string, provider: string, id: string) => models.includes(`${provider}/${id}`) ? { provider, id } : undefined),
    getProviderAuthStatus: vi.fn(() => ({ configured: true })),
    classify: vi.fn(),
  };
}

const ui = () => ({ select: vi.fn(async () => "Use all 2 enabled servers (default)"), confirm: vi.fn(async () => true), notify: vi.fn() });

afterEach(() => vi.unstubAllEnvs());

describe("semantic search setup", () => {
  it("writes the allowlist for confirmed servers, names the model, keeps other settings, and drops settings.jev", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-semantic-setup-"));
    const path = join(root, "mcp.json");
    writeFileSync(path, '{"settings":{"toolPrefix":"short","jev":{"allowedServers":["alpha"]},"semanticSearch":{"candidateLimit":40}},"custom":"kept"}\n');
    const prompts = ui();

    const ctx = { hasUI: true, ui: prompts, modelRegistry: modelRegistry(["typesafe/jev-latest"]) };
    expect(await setupSemanticSearch(state(), ctx as any, path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      settings: { toolPrefix: "short", semanticSearch: { candidateLimit: 40, allowedServers: ["alpha", "zeta"] } },
      custom: "kept",
    });
    expect(prompts.confirm.mock.calls[0]).toEqual([
      "Share MCP tool metadata with typesafe/jev-latest?",
      "Semantic searches send the query text, server names, tool paths, tool names, and descriptions from 2 servers to typesafe/jev-latest through Pi. Semantic search does not send tool results.",
    ]);
    expect(prompts.notify).toHaveBeenCalledWith("Semantic search configured for 2 servers. Reloading Pi…", "info");
  });

  it("explains a missing classifier and changes nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-semantic-setup-none-"));
    const path = join(root, "mcp.json");
    for (const [modelRegistryValue, message] of [
      [undefined, "Semantic search needs Pi 0.99 or later"],
      [modelRegistry([]), "Semantic search needs a classifier model in Pi."],
    ] as const) {
      const prompts = ui();
      expect(await setupSemanticSearch(state(), { hasUI: true, ui: prompts, modelRegistry: modelRegistryValue } as any, path)).toBe(false);
      expect(prompts.select).not.toHaveBeenCalled();
      expect(prompts.notify).toHaveBeenCalledWith(expect.stringContaining(message), "error");
    }
    const configured = state();
    configured.config.settings = { semanticSearch: { model: "openrouter/missing" } };
    const prompts = ui();
    expect(await setupSemanticSearch(configured, { hasUI: true, ui: prompts, modelRegistry: modelRegistry(["typesafe/jev-latest"]) } as any, path)).toBe(false);
    expect(prompts.notify).toHaveBeenCalledWith(expect.stringContaining('Classifier model "openrouter/missing" is not in Pi\'s model list'), "error");
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("does not overwrite malformed configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-semantic-setup-invalid-"));
    const path = join(root, "mcp.json");
    writeFileSync(path, "{invalid\n");

    expect(() => writeSemanticSearchConfig(path, root, ["demo"])).toThrow(`Failed to read MCP config at ${path}`);
    expect(readFileSync(path, "utf8")).toBe("{invalid\n");
  });

  it("writes project-scoped policy by default and validates server names", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-semantic-setup-project-"));
    const result = writeSemanticSearchConfig(undefined, cwd, ["demo"]);
    expect(result.path).toBe(join(cwd, ".pi", "mcp-adapter.json"));
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual({ settings: { semanticSearch: { allowedServers: ["demo"] } } });

    const invalidPath = join(cwd, "invalid.json");
    expect(() => writeSemanticSearchConfig(invalidPath, cwd, ["__proto__"])).toThrow("allowedServers");
    expect(() => readFileSync(invalidPath, "utf8")).toThrow();
  });

  it("overrides a lower-precedence project policy", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-semantic-setup-precedence-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { demo: { command: "demo" }, other: { command: "other" } },
      settings: { semanticSearch: { allowedServers: ["demo", "other"] } },
    }));

    expect(writeSemanticSearchConfig(undefined, root, ["demo"], { allowedServers: ["demo", "other"] }).changed).toBe(true);
    expect(loadMcpConfig(undefined, root).settings?.semanticSearch).toEqual({ allowedServers: ["demo"] });
  });
});
