import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createPromptCommand,
  formatPromptResult,
  listAllPromptMetadata,
  parsePromptArgs,
  resolvePromptArgs,
} from "../prompts.ts";
import type { McpExtensionState } from "../state.ts";
import type { PromptMetadata } from "../types.ts";
import { formatPromptCommandName, sanitizePromptName } from "../types.ts";

function meta(overrides: Partial<PromptMetadata> = {}): PromptMetadata {
  return {
    serverName: "demo",
    originalName: "brief",
    commandName: "mcp__demo__brief",
    description: "Daily brief",
    arguments: [
      { name: "topic", required: true, description: "Topic" },
      { name: "date", required: false },
    ],
    ...overrides,
  };
}

function baseState(promptMetadata: Map<string, PromptMetadata[]>): McpExtensionState {
  return {
    config: { mcpServers: { demo: { command: "demo" } } },
    manager: {
      getConnection: vi.fn(() => ({ status: "connected" as const, tools: [], resources: [], prompts: [] })),
      getPrompt: vi.fn(),
    },
    toolMetadata: new Map(),
    promptMetadata,
    failureTracker: new Map(),
    completedUiSessions: [],
  } as unknown as McpExtensionState;
}

function commandCtx(overrides: Partial<ExtensionCommandContext> = {}): ExtensionCommandContext {
  return {
    hasUI: true,
    ui: { notify: vi.fn() },
    signal: undefined,
    ...overrides,
  } as unknown as ExtensionCommandContext;
}

describe("prompt command naming", () => {
  it("mirrors Claude Code's mcp__<server>__<prompt> convention", () => {
    expect(formatPromptCommandName("plan", "agent-board", "server")).toBe("mcp__agent_board__plan");
  });

  it("honors the toolPrefix short mode", () => {
    expect(formatPromptCommandName("plan", "agent-board-mcp", "short")).toBe("mcp__agent_board__plan");
  });

  it("falls back to the server name when toolPrefix is 'none'", () => {
    expect(formatPromptCommandName("plan", "agent-board", "none")).toBe("mcp__agent_board__plan");
  });

  it("sanitizes prompt names with unusual characters", () => {
    expect(sanitizePromptName("weekly.report")).toBe("weekly_report");
    expect(sanitizePromptName("with spaces & symbols")).toBe("with_spaces_symbols");
    expect(sanitizePromptName("123-start")).toBe("_123-start");
    expect(sanitizePromptName("---")).toBe("prompt");
  });
});

describe("parsePromptArgs", () => {
  it("splits positional args on whitespace", () => {
    expect(parsePromptArgs("today weather")).toEqual({
      positional: ["today", "weather"],
      named: {},
    });
  });

  it("preserves double-quoted phrases", () => {
    expect(parsePromptArgs('"important tasks" today')).toEqual({
      positional: ["important tasks", "today"],
      named: {},
    });
  });

  it("recognizes key=value tokens as named args", () => {
    expect(parsePromptArgs("topic=demo date=today")).toEqual({
      positional: [],
      named: { topic: "demo", date: "today" },
    });
  });

  it("allows quoted values in key=value tokens", () => {
    expect(parsePromptArgs('topic="demo of the day" date=today')).toEqual({
      positional: [],
      named: { topic: "demo of the day", date: "today" },
    });
  });

  it("mixes positional and named", () => {
    expect(parsePromptArgs("today topic=demo")).toEqual({
      positional: ["today"],
      named: { topic: "demo" },
    });
  });
});

describe("resolvePromptArgs", () => {
  it("returns positional args mapped by declared order", () => {
    const result = resolvePromptArgs(meta(), { positional: ["ai", "today"], named: {} });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ topic: "ai", date: "today" });
  });

  it("prefers named args over positional when both are provided", () => {
    const result = resolvePromptArgs(meta(), {
      positional: ["fallback"],
      named: { topic: "ai" },
    });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ topic: "ai" });
  });

  it("rejects missing required args with a usage hint", () => {
    const result = resolvePromptArgs(meta(), { positional: [], named: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required argument");
    expect(result.error).toContain("Usage: /mcp__demo__brief <topic> [date]");
  });

  it("allows undeclared named args through for permissive server schemas", () => {
    const result = resolvePromptArgs(meta({ arguments: [] }), {
      positional: [],
      named: { extra: "value" },
    });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual({ extra: "value" });
  });
});

describe("formatPromptResult", () => {
  it("returns a single user message verbatim", () => {
    const result: GetPromptResult = {
      messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
    };
    expect(formatPromptResult(result)).toBe("Hello");
  });

  it("preserves role attribution for multi-turn prompts", () => {
    const result: GetPromptResult = {
      messages: [
        { role: "user", content: { type: "text", text: "Hi" } },
        { role: "assistant", content: { type: "text", text: "Hello" } },
      ],
    };
    expect(formatPromptResult(result)).toBe("[user] Hi\n\n[assistant] Hello");
  });

  it("summarizes embedded resource content", () => {
    const result: GetPromptResult = {
      messages: [
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: "file:///readme.md", text: "# Title" },
          } as unknown as GetPromptResult["messages"][number]["content"],
        },
      ],
    };
    expect(formatPromptResult(result)).toContain("[resource file:///readme.md]");
    expect(formatPromptResult(result)).toContain("# Title");
  });

  it("returns an empty string when no message has extractable text", () => {
    const result: GetPromptResult = {
      messages: [
        {
          role: "user",
          content: { type: "image", data: "b64", mimeType: "image/png" } as unknown as GetPromptResult["messages"][number]["content"],
        },
      ],
    };
    // Images still produce a placeholder marker so the model sees the intent.
    expect(formatPromptResult(result)).toBe("[image image/png (embedded)]");
  });
});

describe("createPromptCommand handler", () => {
  it("sends the resolved prompt text as a user message", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const state = baseState(promptMetadata);
    (state.manager.getPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [{ role: "user", content: { type: "text", text: "Brief for ai" } }],
    });
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;

    const command = createPromptCommand(pi, () => state, meta());
    await command.handler("ai", commandCtx());

    expect(state.manager.getPrompt).toHaveBeenCalledWith("demo", "brief", { topic: "ai" }, undefined);
    expect(pi.sendUserMessage).toHaveBeenCalledWith("Brief for ai");
  });

  it("shows a usage error when required args are missing", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const state = baseState(promptMetadata);
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
    const notify = vi.fn();

    const command = createPromptCommand(pi, () => state, meta());
    await command.handler("", commandCtx({ hasUI: true, ui: { notify } as any }));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Missing required argument"), "error");
  });

  it("surfaces MCP server errors without sending a user message", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const state = baseState(promptMetadata);
    (state.manager.getPrompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Prompt not found"));
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
    const notify = vi.fn();

    const command = createPromptCommand(pi, () => state, meta());
    await command.handler("ai", commandCtx({ ui: { notify } as any }));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Prompt not found"), "error");
  });

  it("prompts users to authenticate when the server needs auth", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const state = baseState(promptMetadata);
    (state.manager.getConnection as ReturnType<typeof vi.fn>).mockReturnValue({ status: "needs-auth" });
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
    const notify = vi.fn();

    const command = createPromptCommand(pi, () => state, meta());
    await command.handler("ai", commandCtx({ ui: { notify } as any }));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("needs authentication"), "error");
  });

  it("warns when the prompt returns no textual content", async () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([["demo", [meta()]]]);
    const state = baseState(promptMetadata);
    (state.manager.getPrompt as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: [],
    });
    const pi = { sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
    const notify = vi.fn();

    const command = createPromptCommand(pi, () => state, meta());
    await command.handler("ai", commandCtx({ ui: { notify } as any }));

    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no text content"), "warning");
  });
});

describe("listAllPromptMetadata", () => {
  it("flattens and sorts across servers", () => {
    const promptMetadata = new Map<string, PromptMetadata[]>([
      ["beta", [meta({ serverName: "beta", commandName: "mcp__beta__plan", originalName: "plan" })]],
      ["alpha", [meta({ serverName: "alpha", commandName: "mcp__alpha__plan", originalName: "plan" })]],
    ]);
    const state = baseState(promptMetadata);

    const names = listAllPromptMetadata(state).map(p => p.commandName);
    expect(names).toEqual(["mcp__alpha__plan", "mcp__beta__plan"]);
  });
});
