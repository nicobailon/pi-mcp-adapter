import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../index.ts";

describe("mcp.panel.open keybinding", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "mcp-panel-shortcut-"));
    vi.stubEnv("PI_PACKAGE_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(agentDir, { recursive: true, force: true });
  });

  function load(keybindings?: string) {
    if (keybindings !== undefined) writeFileSync(join(agentDir, "keybindings.json"), keybindings);
    const fns = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
    const pi = new Proxy({ events: { on: vi.fn(), emit: vi.fn() }, getFlag: () => undefined } as Record<PropertyKey, unknown>, {
      get: (target, key) => target[key] ?? fns.get(key) ?? fns.set(key, vi.fn()).get(key),
    });
    createMcpAdapter()(pi as never);
    return pi as Record<string, ReturnType<typeof vi.fn>>;
  }

  it("opens the panel through /mcp-adapter from each configured key", async () => {
    const pi = load(JSON.stringify({ "mcp.panel.open": ["alt+m", "ctrl+shift+m"] }));

    expect(pi.registerShortcut.mock.calls.map(([key]) => key)).toEqual(["alt+m", "ctrl+shift+m"]);
    await pi.registerShortcut.mock.calls[0][1].handler({});
    expect(pi.sendUserMessage).toHaveBeenCalledWith("/mcp-adapter", { expandPromptTemplates: true });
  });

  it.each([
    ["no keybindings file", undefined],
    ["no mapping", JSON.stringify({ "app.model.select": "ctrl+l" })],
    ["an empty list", JSON.stringify({ "mcp.panel.open": [] })],
    ["a malformed file", "{ not json"],
  ])("registers no shortcut with %s", (_case, keybindings) => {
    expect(load(keybindings).registerShortcut).not.toHaveBeenCalled();
  });
});
