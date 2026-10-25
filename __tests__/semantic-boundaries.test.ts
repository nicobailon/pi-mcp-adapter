import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpAdapter } from "../index.ts";

afterEach(() => vi.restoreAllMocks());

describe("semantic search boundaries", () => {
  it("does no network I/O during extension registration", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const registerTool = vi.fn();
    createMcpAdapter({ config: { settings: {}, mcpServers: {} } })({
      registerTool,
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      events: { on: vi.fn(), emit: vi.fn() },
      getAllTools: vi.fn(() => []),
    } as any);
    expect(registerTool).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
