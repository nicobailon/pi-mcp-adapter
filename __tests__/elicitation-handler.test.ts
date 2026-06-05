import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElicitRequest } from "@modelcontextprotocol/sdk/types.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
}));

vi.mock("open", () => ({ default: mocks.open }));

function formRequest(params: ElicitRequest["params"]): ElicitRequest {
  return { method: "elicitation/create", params } as ElicitRequest;
}

describe("elicitation handler", () => {
  beforeEach(() => {
    mocks.open.mockReset();
    mocks.open.mockResolvedValue(undefined);
  });

  it("converts form elicitation schemas to Pi forms and returns accepted content", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      form: vi.fn(async () => ({
        action: "submit",
        values: {
          title: "Bug in auth flow",
          priority: "medium",
          assignToMe: true,
        },
      })),
    };

    const result = await handleElicitationRequest(
      { serverName: "github", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "form",
        message: "Create a new issue",
        requestedSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              title: "Title",
              description: "Issue title",
              minLength: 1,
            },
            priority: {
              type: "string",
              title: "Priority",
              enum: ["low", "medium", "high"],
              default: "medium",
            },
            assignToMe: {
              type: "boolean",
              title: "Assign to me",
              default: false,
            },
          },
          required: ["title"],
        },
      }),
    );

    expect(ui.form).toHaveBeenCalledWith({
      title: "MCP Input Request",
      message: "Server: github\n\nCreate a new issue",
      submitLabel: "Submit",
      secondaryLabel: "Decline",
      cancelLabel: "Cancel",
      fields: [
        {
          type: "text",
          name: "title",
          label: "Title",
          description: "Issue title",
          required: true,
          minLength: 1,
        },
        {
          type: "select",
          name: "priority",
          label: "Priority",
          required: false,
          options: [
            { value: "low" },
            { value: "medium" },
            { value: "high" },
          ],
          defaultValue: "medium",
        },
        {
          type: "boolean",
          name: "assignToMe",
          label: "Assign to me",
          defaultValue: false,
        },
      ],
    });
    expect(result).toEqual({
      action: "accept",
      content: {
        title: "Bug in auth flow",
        priority: "medium",
        assignToMe: true,
      },
    });
  });

  it("shows URL elicitations as a Pi form and opens accepted URLs", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      form: vi.fn(async () => ({ action: "submit", values: {} })),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "stripe", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "url",
        message: "Confirm payment authorization",
        elicitationId: "elicit_123",
        url: "https://checkout.stripe.com/c/pay/cs_test_123",
      }),
    );

    expect(ui.form).toHaveBeenCalledWith({
      title: "MCP Browser Request",
      message: [
        "Server: stripe",
        "",
        "Confirm payment authorization",
        "",
        "Domain: checkout.stripe.com",
        "URL: https://checkout.stripe.com/c/pay/cs_test_123",
        "",
        "Open this URL in your browser?",
      ].join("\n"),
      fields: [],
      submitLabel: "Open",
      secondaryLabel: "Decline",
      cancelLabel: "Cancel",
    });
    expect(mocks.open).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_123");
    expect(ui.notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
    expect(result).toEqual({ action: "accept" });
  });

  it("cancels non-browser URL elicitation schemes before prompting or opening", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      form: vi.fn(async () => ({ action: "submit", values: {} })),
      notify: vi.fn(),
    };

    await expect(
      handleElicitationRequest(
        { serverName: "demo", ui: ui as any, autoOpenUrls: true },
        formRequest({
          mode: "url",
          message: "Open local file",
          elicitationId: "elicit_file",
          url: "file:///etc/passwd",
        }),
      ),
    ).resolves.toEqual({ action: "cancel" });

    expect(ui.form).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("cancels form elicitations when the UI form fails", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      form: vi.fn(async () => {
        throw new Error("form unavailable");
      }),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "form",
        message: "Collect input",
        requestedSchema: {
          type: "object",
          properties: {
            note: { type: "string", title: "Note" },
          },
        },
      }),
    );

    expect(result).toEqual({ action: "cancel" });
  });

  it("cancels form elicitations when submitted values fail validation", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      form: vi.fn(async () => ({
        action: "submit",
        values: { count: "not a number" },
      })),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "form",
        message: "Collect count",
        requestedSchema: {
          type: "object",
          properties: {
            count: { type: "number", title: "Count" },
          },
          required: ["count"],
        },
      }),
    );

    expect(result).toEqual({ action: "cancel" });
  });

  it("cancels URL elicitations when the prompt fails before opening", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      form: vi.fn(async () => {
        throw new Error("form unavailable");
      }),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "url",
        message: "Approve access",
        elicitationId: "elicit_prompt_error",
        url: "https://example.com/approve",
      }),
    );

    expect(result).toEqual({ action: "cancel" });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("cancels URL elicitations when opening the accepted URL fails", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    mocks.open.mockRejectedValueOnce(new Error("browser unavailable"));
    const ui = {
      form: vi.fn(async () => ({ action: "submit", values: {} })),
      notify: vi.fn(),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "url",
        message: "Approve access",
        elicitationId: "elicit_open_error",
        url: "https://example.com/approve",
      }),
    );

    expect(result).toEqual({ action: "cancel" });
    expect(mocks.open).toHaveBeenCalledWith("https://example.com/approve");
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("ignores notification failures after opening an accepted URL", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = {
      form: vi.fn(async () => ({ action: "submit", values: {} })),
      notify: vi.fn(() => {
        throw new Error("notification unavailable");
      }),
    };

    const result = await handleElicitationRequest(
      { serverName: "demo", ui: ui as any, autoOpenUrls: false },
      formRequest({
        mode: "url",
        message: "Approve access",
        elicitationId: "elicit_notify_error",
        url: "https://example.com/approve",
      }),
    );

    expect(result).toEqual({ action: "accept" });
    expect(mocks.open).toHaveBeenCalledWith("https://example.com/approve");
    expect(ui.notify).toHaveBeenCalledWith("Opened browser for MCP elicitation.", "info");
  });

  it("preserves empty strings for string fields unless schema constraints reject them", async () => {
    const { coerceAndValidateFormValues } = await import("../elicitation-handler.ts");
    const params = {
      mode: "form",
      message: "Collect note",
      requestedSchema: {
        type: "object",
        properties: {
          note: { type: "string", title: "Note" },
          summary: { type: "string", title: "Summary", minLength: 1 },
        },
        required: ["note"],
      },
    } as const;

    expect(coerceAndValidateFormValues(params, { note: "", summary: "ok" })).toEqual({
      note: "",
      summary: "ok",
    });
    expect(() => coerceAndValidateFormValues(params, { note: "ok", summary: "" })).toThrow(
      "Elicitation field summary is shorter than minimum length 1",
    );
  });

  it("maps Pi secondary and cancel form actions to MCP decline and cancel", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const makeRequest = () =>
      formRequest({
        mode: "form",
        message: "Continue?",
        requestedSchema: {
          type: "object",
          properties: {
            reason: { type: "string", title: "Reason" },
          },
        },
      });

    const declineUi = { form: vi.fn(async () => ({ action: "secondary" })) };
    const cancelUi = { form: vi.fn(async () => ({ action: "cancel" })) };

    await expect(
      handleElicitationRequest({ serverName: "demo", ui: declineUi as any, autoOpenUrls: false }, makeRequest()),
    ).resolves.toEqual({ action: "decline" });
    await expect(
      handleElicitationRequest({ serverName: "demo", ui: cancelUi as any, autoOpenUrls: false }, makeRequest()),
    ).resolves.toEqual({ action: "cancel" });
  });
});
