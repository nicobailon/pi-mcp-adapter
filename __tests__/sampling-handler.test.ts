import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import type { CreateMessageRequest, ModelPreferences } from "@modelcontextprotocol/client";
import type { SamplingHandlerOptions } from "../sampling-handler.ts";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
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
  baseUrl: "https://api.anthropic.com",
  input: ["text"],
  reasoning: false,
  cost: usage.cost,
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"anthropic-messages">;

const opus = {
  ...model,
  id: "claude-opus",
  name: "Claude Opus",
} satisfies Model<"anthropic-messages">;

const haiku = {
  ...model,
  id: "claude-haiku",
  name: "Claude Haiku",
} satisfies Model<"anthropic-messages">;

const geminiFlash = {
  ...model,
  provider: "google",
  id: "gemini-2.5-flash",
  api: "google-generative-ai",
  name: "Gemini 2.5 Flash",
  baseUrl: "https://generativelanguage.googleapis.com",
} satisfies Model<"google-generative-ai">;

function createOptions(overrides: Partial<SamplingHandlerOptions> = {}): SamplingHandlerOptions {
  return {
    serverName: "i18n",
    autoApprove: true,
    modelRegistry: {
      getAvailable: vi.fn(() => [model]),
      complete: mocks.complete,
    },
    getCurrentModel: vi.fn(() => undefined),
    getSignal: vi.fn(() => undefined),
    ...overrides,
  };
}

async function runBasicSampling(
  overrides: Partial<SamplingHandlerOptions>,
  modelPreferences?: ModelPreferences,
): Promise<void> {
  const { handleSamplingRequest } = await import("../sampling-handler.ts");
  await handleSamplingRequest(createOptions(overrides), createSamplingRequest({
    ...(modelPreferences ? { modelPreferences } : {}),
    messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
    maxTokens: 50,
  }));
}

function createSamplingRequest(params: CreateMessageRequest["params"]): CreateMessageRequest {
  return { method: "sampling/createMessage", params };
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
    const result = await handleSamplingRequest(createOptions(), createSamplingRequest({
      systemPrompt: "Translate tersely.",
      messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
      maxTokens: 50,
      temperature: 0.2,
      metadata: { locale: "fr" },
    }));

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

    await expect(handleSamplingRequest(
      createOptions({ autoApprove: false, ui: undefined }),
      createSamplingRequest({ messages: [], maxTokens: 50 }),
    )).rejects.toThrow("MCP sampling requires interactive approval");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("asks for approval with inspectable request and response content", async () => {
    const { handleSamplingRequest } = await import("../sampling-handler.ts");
    const ui = { confirm: vi.fn(async () => true) };

    await handleSamplingRequest(createOptions({ autoApprove: false, ui }), createSamplingRequest({
      systemPrompt: "Translate tersely.",
      messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
      maxTokens: 50,
    }));

    expect(ui.confirm).toHaveBeenCalledTimes(2);
    expect(ui.confirm.mock.calls[0][0]).toBe("Approve MCP sampling request");
    expect(ui.confirm.mock.calls[0][1]).toContain("System: Translate tersely.");
    expect(ui.confirm.mock.calls[0][1]).toContain("1. user: Hello");
    expect(ui.confirm.mock.calls[1][0]).toBe("Return MCP sampling response");
    expect(ui.confirm.mock.calls[1][1]).toContain("Bonjour");
  });

  it("uses model preference hints before the current conversation model", async () => {
    await runBasicSampling({
      modelRegistry: {
        getAvailable: vi.fn(() => [haiku, opus]),
        complete: mocks.complete,
      },
      getCurrentModel: vi.fn(() => opus),
    }, { hints: [{ name: "haiku" }] });

    expect(mocks.complete.mock.calls[0][0]).toBe(haiku);
  });

  it("matches model preference hints case-insensitively after trimming", async () => {
    await runBasicSampling({
      modelRegistry: {
        getAvailable: vi.fn(() => [haiku, opus]),
        complete: mocks.complete,
      },
      getCurrentModel: vi.fn(() => opus),
    }, { hints: [{ name: " HAIKU " }] });

    expect(mocks.complete.mock.calls[0][0]).toBe(haiku);
  });

  it("matches model preference hints against display names", async () => {
    await runBasicSampling({
      modelRegistry: {
        getAvailable: vi.fn(() => [geminiFlash, opus]),
        complete: mocks.complete,
      },
      getCurrentModel: vi.fn(() => opus),
    }, { hints: [{ name: "2.5 Flash" }] });

    expect(mocks.complete.mock.calls[0][0]).toBe(geminiFlash);
  });

  it("matches model preference hints against provider/id", async () => {
    await runBasicSampling({
      modelRegistry: {
        getAvailable: vi.fn(() => [geminiFlash, opus]),
        complete: mocks.complete,
      },
      getCurrentModel: vi.fn(() => opus),
    }, { hints: [{ name: "google/gemini" }] });

    expect(mocks.complete.mock.calls[0][0]).toBe(geminiFlash);
  });

  it("preserves preference order across multiple model hints", async () => {
    await runBasicSampling({
      modelRegistry: {
        getAvailable: vi.fn(() => [haiku, geminiFlash, opus]),
        complete: mocks.complete,
      },
      getCurrentModel: vi.fn(() => opus),
    }, { hints: [{ name: "gemini" }, { name: "haiku" }] });

    expect(mocks.complete.mock.calls[0][0]).toBe(geminiFlash);
  });

  it("propagates completion errors without falling back to another candidate", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("Provider is not configured: anthropic"));

    await expect(runBasicSampling({
      modelRegistry: {
        getAvailable: vi.fn(() => [haiku, opus]),
        complete,
      },
      getCurrentModel: vi.fn(() => opus),
    }, { hints: [{ name: "haiku" }] })).rejects.toThrow("Provider is not configured: anthropic");

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toBe(haiku);
  });

  it("preserves current-model-first selection when no hints are provided", async () => {
    await runBasicSampling({
      modelRegistry: {
        getAvailable: vi.fn(() => [haiku]),
        complete: mocks.complete,
      },
      getCurrentModel: vi.fn(() => opus),
    });

    expect(mocks.complete.mock.calls[0][0]).toBe(opus);
  });

  it("rejects unsupported sampling features loudly", async () => {
    const { handleSamplingRequest } = await import("../sampling-handler.ts");

    await expect(handleSamplingRequest(createOptions(), createSamplingRequest({
      messages: [{ role: "user", content: { type: "image", data: "abc", mimeType: "image/png" } }],
      maxTokens: 50,
    }))).rejects.toThrow("MCP sampling image content is not supported");

    await expect(handleSamplingRequest(createOptions(), createSamplingRequest({
      messages: [{ role: "user", content: { type: "audio", data: "abc", mimeType: "audio/wav" } }],
      maxTokens: 50,
    }))).rejects.toThrow("MCP sampling audio content is not supported");

    await expect(handleSamplingRequest(createOptions(), createSamplingRequest({
      messages: [],
      maxTokens: 50,
      includeContext: "thisServer",
    }))).rejects.toThrow("MCP sampling context inclusion is not supported");

    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
