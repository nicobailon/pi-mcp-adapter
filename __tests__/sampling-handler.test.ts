import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  complete: mocks.complete,
}));

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model = {
  provider: "anthropic",
  id: "claude-sonnet",
  api: "anthropic-messages",
  name: "Claude Sonnet",
  input: ["text"],
  reasoning: false,
  cost: usage.cost,
  contextWindow: 200000,
  maxTokens: 8192,
};

function createOptions(overrides: Record<string, unknown> = {}) {
  return {
    serverName: "i18n",
    autoApprove: true,
    modelRegistry: {
      getAvailable: vi.fn(() => [model]),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key", headers: { "x-test": "1" } })),
    },
    getCurrentModel: vi.fn(() => undefined),
    getSignal: vi.fn(() => undefined),
    ...overrides,
  } as any;
}

describe("sampling handler", () => {
  beforeEach(() => {
    mocks.complete.mockReset().mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "Bonjour" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet",
      usage,
      stopReason: "stop",
      timestamp: 1,
    });
  });

  it("converts approved MCP sampling requests into pi-ai completions", async () => {
    const { handleSamplingRequest } = await import("../sampling-handler.ts");
    const result = await handleSamplingRequest(createOptions(), {
      method: "sampling/createMessage",
      params: {
        systemPrompt: "Translate tersely.",
        messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        maxTokens: 50,
        temperature: 0.2,
        metadata: { locale: "fr" },
      },
    } as any);

    expect(mocks.complete).toHaveBeenCalledWith(
      model,
      {
        systemPrompt: "Translate tersely.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Hello" }],
            timestamp: expect.any(Number),
          },
        ],
      },
      {
        apiKey: "key",
        headers: { "x-test": "1" },
        maxTokens: 50,
        temperature: 0.2,
        metadata: { locale: "fr" },
        signal: undefined,
      },
    );
    expect(result).toEqual({
      role: "assistant",
      content: { type: "text", text: "Bonjour" },
      model: "anthropic/claude-sonnet",
      stopReason: "endTurn",
    });
  });

  it("requires UI approval unless auto-approve is enabled", async () => {
    const { handleSamplingRequest } = await import("../sampling-handler.ts");

    await expect(handleSamplingRequest(createOptions({ autoApprove: false, ui: undefined }), {
      method: "sampling/createMessage",
      params: { messages: [], maxTokens: 50 },
    } as any)).rejects.toThrow("MCP sampling requires interactive approval");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("asks for approval with inspectable request and response content", async () => {
    const { handleSamplingRequest } = await import("../sampling-handler.ts");
    const ui = { confirm: vi.fn(async () => true) };

    await handleSamplingRequest(createOptions({ autoApprove: false, ui }), {
      method: "sampling/createMessage",
      params: {
        systemPrompt: "Translate tersely.",
        messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        maxTokens: 50,
      },
    } as any);

    expect(ui.confirm).toHaveBeenCalledTimes(2);
    expect(ui.confirm.mock.calls[0][0]).toBe("Approve MCP sampling request");
    expect(ui.confirm.mock.calls[0][1]).toContain("System: Translate tersely.");
    expect(ui.confirm.mock.calls[0][1]).toContain("1. user: Hello");
    expect(ui.confirm.mock.calls[1][0]).toBe("Return MCP sampling response");
    expect(ui.confirm.mock.calls[1][1]).toContain("Bonjour");
  });

  it("rejects unsupported sampling features loudly", async () => {
    const { handleSamplingRequest } = await import("../sampling-handler.ts");

    await expect(handleSamplingRequest(createOptions(), {
      method: "sampling/createMessage",
      params: {
        messages: [{ role: "user", content: { type: "image", data: "abc", mimeType: "image/png" } }],
        maxTokens: 50,
      },
    } as any)).rejects.toThrow("MCP sampling image content is not supported");

    await expect(handleSamplingRequest(createOptions(), {
      method: "sampling/createMessage",
      params: {
        messages: [{ role: "user", content: { type: "audio", data: "abc", mimeType: "audio/wav" } }],
        maxTokens: 50,
      },
    } as any)).rejects.toThrow("MCP sampling audio content is not supported");

    await expect(handleSamplingRequest(createOptions(), {
      method: "sampling/createMessage",
      params: { messages: [], maxTokens: 50, includeContext: "thisServer" },
    } as any)).rejects.toThrow("MCP sampling context inclusion is not supported");

    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
