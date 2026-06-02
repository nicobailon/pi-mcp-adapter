import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ElicitationHandlerOptions } from "../elicitation-handler.ts";

function createOptions(overrides: Partial<ElicitationHandlerOptions> = {}): ElicitationHandlerOptions {
  return {
    serverName: "github",
    ui: {
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "value"),
      select: vi.fn(async (_title: string, options: string[]) => options[0]),
    } as any,
    timeoutMs: 300000,
    ...overrides,
  };
}

function createElicitationRequest(params: ElicitRequest["params"]): ElicitRequest {
  return { method: "elicitation/create", params };
}

describe("elicitation handler", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("collects and validates simple form fields before accepting", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      confirm: vi.fn(async () => true),
      input: vi
        .fn()
        .mockResolvedValueOnce("Release note")
        .mockResolvedValueOnce("42")
        .mockResolvedValueOnce("7"),
      select: vi
        .fn()
        .mockResolvedValueOnce("true")
        .mockResolvedValueOnce("High"),
    };

    const result = await handleElicitationRequest(createOptions({ ui: ui as any }), createElicitationRequest({
      message: "Approve publishing this change?",
      requestedSchema: {
        type: "object",
        properties: {
          comment: { type: "string", minLength: 3 },
          score: { type: "number", minimum: 1, maximum: 100 },
          retries: { type: "integer", default: 7 },
          approved: { type: "boolean" },
          priority: { type: "string", enum: ["low", "high"], enumNames: ["Low", "High"] },
        },
        required: ["comment", "score", "approved", "priority"],
      },
    }));

    expect(result).toEqual({
      action: "accept",
      content: {
        comment: "Release note",
        score: 42,
        retries: 7,
        approved: true,
        priority: "high",
      },
    });
    expect(ui.confirm).toHaveBeenCalledTimes(2);
    expect(ui.confirm.mock.calls[0][0]).toBe("MCP request from github");
    expect(ui.confirm.mock.calls[0][2]).toEqual({ timeout: 300000 });
    expect(ui.input.mock.calls[0]).toEqual(["comment (required)", "", { timeout: 300000 }]);
    expect(ui.input.mock.calls[1]).toEqual(["score (required)", "", { timeout: 300000 }]);
    expect(ui.input.mock.calls[2]).toEqual(["retries", "7", { timeout: 300000 }]);
    expect(ui.select.mock.calls[0]).toEqual(["approved (required)", ["true", "false"], { timeout: 300000 }]);
    expect(ui.select.mock.calls[1]).toEqual(["priority (required)", ["Low", "High"], { timeout: 300000 }]);
    expect(ui.confirm.mock.calls[1][1]).toContain("\"priority\": \"high\"");
    expect(ui.confirm.mock.calls[1][2]).toEqual({ timeout: 300000 });
  });

  it("returns decline for explicit initial denial", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = { confirm: vi.fn(async () => false), input: vi.fn(), select: vi.fn() };

    const result = await handleElicitationRequest(createOptions({ ui: ui as any }), createElicitationRequest({
      message: "Approve?",
      requestedSchema: { type: "object", properties: {} },
    }));

    expect(result).toEqual({ action: "decline" });
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("returns decline for explicit final denial", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      input: vi.fn(async () => "ok"),
      select: vi.fn(),
    };

    const result = await handleElicitationRequest(createOptions({ ui: ui as any }), createElicitationRequest({
      message: "Approve?",
      requestedSchema: {
        type: "object",
        properties: { comment: { type: "string" } },
        required: ["comment"],
      },
    }));

    expect(result).toEqual({ action: "decline" });
  });

  it("returns cancel when UI is unavailable", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");

    const result = await handleElicitationRequest(createOptions({ ui: undefined }), createElicitationRequest({
      message: "Approve?",
      requestedSchema: { type: "object", properties: {} },
    }));

    expect(result).toEqual({ action: "cancel" });
  });

  it("returns cancel for URL and non-form elicitation modes", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");

    await expect(handleElicitationRequest(createOptions(), createElicitationRequest({
      mode: "url",
      message: "Open this URL?",
      requestedSchema: { type: "object", properties: {} },
    } as any))).resolves.toEqual({ action: "cancel" });

    await expect(handleElicitationRequest(createOptions(), createElicitationRequest({
      mode: "custom",
      message: "Custom?",
      requestedSchema: { type: "object", properties: {} },
    } as any))).resolves.toEqual({ action: "cancel" });
  });

  it("returns cancel for missing or invalid schemas", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");

    await expect(handleElicitationRequest(createOptions(), createElicitationRequest({
      message: "Approve?",
    } as any))).resolves.toEqual({ action: "cancel" });

    await expect(handleElicitationRequest(createOptions(), createElicitationRequest({
      message: "Approve?",
      requestedSchema: { type: "array" },
    } as any))).resolves.toEqual({ action: "cancel" });
  });

  it("skips unsupported optional fields and cancels unsupported required fields", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");

    await expect(handleElicitationRequest(createOptions(), createElicitationRequest({
      message: "Approve?",
      requestedSchema: {
        type: "object",
        properties: {
          optionalList: { type: "array" },
        },
      },
    } as any))).resolves.toEqual({ action: "accept", content: {} });

    await expect(handleElicitationRequest(createOptions(), createElicitationRequest({
      message: "Approve?",
      requestedSchema: {
        type: "object",
        properties: {
          requiredList: { type: "array" },
        },
        required: ["requiredList"],
      },
    } as any))).resolves.toEqual({ action: "cancel" });
  });

  it("returns cancel when field validation fails", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "101"),
      select: vi.fn(),
    };

    const result = await handleElicitationRequest(createOptions({ ui: ui as any }), createElicitationRequest({
      message: "Approve?",
      requestedSchema: {
        type: "object",
        properties: { score: { type: "number", maximum: 100 } },
        required: ["score"],
      },
    }));

    expect(result).toEqual({ action: "cancel" });
  });

  it("returns cancel when field input is dismissed", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => undefined),
      select: vi.fn(),
    };

    const result = await handleElicitationRequest(createOptions({ ui: ui as any }), createElicitationRequest({
      message: "Approve?",
      requestedSchema: {
        type: "object",
        properties: { comment: { type: "string" } },
        required: ["comment"],
      },
    }));

    expect(result).toEqual({ action: "cancel" });
  });

  it("returns cancel when a trusted UI call fails", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => {
        throw new Error("dismissed");
      }),
      select: vi.fn(),
    };

    const result = await handleElicitationRequest(createOptions({ ui: ui as any }), createElicitationRequest({
      message: "Approve?",
      requestedSchema: {
        type: "object",
        properties: { comment: { type: "string" } },
        required: ["comment"],
      },
    }));

    expect(result).toEqual({ action: "cancel" });
  });

  it("returns cancel on trusted UI timeout", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      confirm: vi.fn(async (_title: string, _message: string, opts?: { timeout?: number }) => {
        return opts?.timeout === 10 ? undefined : true;
      }),
      input: vi.fn(),
      select: vi.fn(),
    };

    const result = await handleElicitationRequest(createOptions({ ui: ui as any, timeoutMs: 10 }), createElicitationRequest({
      message: "Approve?",
      requestedSchema: { type: "object", properties: {} },
    }));

    expect(result).toEqual({ action: "cancel" });
    expect(ui.confirm.mock.calls[0][2]).toEqual({ timeout: 10 });
  });
});
