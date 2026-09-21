import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupJevSemanticSearch } from "../commands.ts";
import { loadMcpConfig, writeJevSemanticSearchConfig } from "../config.ts";
import type { McpExtensionState } from "../state.ts";

const mocks = vi.hoisted(() => ({
  resolveJevCredential: vi.fn(() => ({ status: "present", source: "keyring", apiKey: "test-key" })),
}));

vi.mock("../jev-key-store.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jev-key-store.ts")>()),
  resolveJevCredential: mocks.resolveJevCredential,
}));

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

afterEach(() => vi.unstubAllEnvs());

describe("Jev setup", () => {
  it("enables semantic search for confirmed servers and preserves other settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-jev-setup-"));
    const path = join(root, "mcp.json");
    writeFileSync(path, '{"settings":{"scriptMode":true},"custom":"kept"}\n');
    const ui = {
      select: vi.fn(async () => "Use all 2 enabled servers (default)"),
      confirm: vi.fn(async () => true),
      notify: vi.fn(),
    };
    const currentState = state();
    currentState.config.settings = { jev: { scriptEvaluation: true, allowedServers: ["prior"] } };

    expect(await setupJevSemanticSearch(currentState, { hasUI: true, ui } as any, path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      settings: {
        scriptMode: true,
        jev: { scriptEvaluation: true, semanticSearch: true, allowedServers: ["alpha", "zeta"] },
      },
      custom: "kept",
    });
    expect(ui.confirm.mock.calls[0]?.[1]).toContain("script evaluations");
    expect(ui.notify).toHaveBeenCalledWith("Jev semantic search configured for 2 servers. Reloading Pi…", "info");
  });

  it("explains how to store a missing credential without changing config", async () => {
    mocks.resolveJevCredential.mockReturnValueOnce({ status: "missing" });
    const ui = { select: vi.fn(), confirm: vi.fn(), notify: vi.fn() };

    expect(await setupJevSemanticSearch(state(), { hasUI: true, ui } as any)).toBe(false);
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("pi-mcp-adapter key set typesafe"), "error");
  });

  it("does not overwrite malformed configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-jev-setup-invalid-"));
    const path = join(root, "mcp.json");
    writeFileSync(path, "{invalid\n");

    expect(() => writeJevSemanticSearchConfig(path, root, ["demo"])).toThrow("Failed to update Jev settings");
    expect(readFileSync(path, "utf8")).toBe("{invalid\n");
  });

  it("writes project-scoped policy by default and validates server names", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-jev-setup-project-"));
    const result = writeJevSemanticSearchConfig(undefined, cwd, ["demo"]);
    expect(result.path).toBe(join(cwd, ".pi", "mcp.json"));
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toMatchObject({
      settings: { jev: { semanticSearch: true, allowedServers: ["demo"] } },
    });

    const longNamePath = join(cwd, "long-name.json");
    expect(writeJevSemanticSearchConfig(longNamePath, cwd, ["x".repeat(129)]).changed).toBe(true);

    const invalidPath = join(cwd, "invalid.json");
    expect(() => writeJevSemanticSearchConfig(invalidPath, cwd, ["__proto__"])).toThrow("allowedServers");
    expect(() => readFileSync(invalidPath, "utf8")).toThrow();
  });

  it("overrides a lower-precedence project policy", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-jev-setup-precedence-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { demo: { command: "demo" } },
      settings: { jev: { semanticSearch: true, allowedServers: ["demo"] } },
    }));

    expect(writeJevSemanticSearchConfig(undefined, root, ["demo"], { semanticSearch: true, allowedServers: ["demo"] }).changed).toBe(true);
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { demo: { command: "demo" }, other: { command: "other" } },
      settings: { jev: { semanticSearch: true, allowedServers: ["demo", "other"] } },
    }));
    expect(loadMcpConfig(undefined, root).settings?.jev).toMatchObject({
      semanticSearch: true,
      allowedServers: ["demo"],
    });
  });
});
