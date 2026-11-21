import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElicitRequest } from "@modelcontextprotocol/client";
import { getOsc8LinkAtColumn, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import type { ElicitationUIContext } from "../elicitation-handler.ts";

const mocks = vi.hoisted(() => ({
  open: vi.fn(async () => undefined),
}));

function request(params: ElicitRequest["params"]): ElicitRequest {
  return { method: "elicitation/create", params } as ElicitRequest;
}

type TestElicitationUI = ElicitationUIContext & {
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
};

function createUi(overrides: Partial<TestElicitationUI> = {}): TestElicitationUI {
  return {
    select: vi.fn(),
    input: vi.fn(),
    notify: vi.fn(),
    ...overrides,
  };
}

describe("MCP elicitation", () => {
  beforeEach(() => {
    mocks.open.mockReset();
    mocks.open.mockResolvedValue(undefined);
  });

  it("stops awaiting form UI output when the task is cancelled", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    let resolveSelection!: (value: string) => void;
    const ui = createUi({
      select: vi.fn(() => new Promise<string>(resolve => { resolveSelection = resolve; })),
    });
    const controller = new AbortController();
    const pending = handleElicitationRequest({ serverName: "demo", ui, allowUrl: true }, request({
      mode: "form",
      message: "Confirm",
      requestedSchema: { type: "object", properties: {} },
    }), controller.signal);

    controller.abort(new Error("task cancelled"));
    await expect(pending).rejects.toThrow("task cancelled");
    resolveSelection("Continue");
  });

  it("stops awaiting a URL browser handoff and does not accept it after task cancellation", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    let resolveOpen!: () => void;
    mocks.open.mockImplementationOnce(() => new Promise<void>(resolve => { resolveOpen = resolve; }));
    const onUrlAccepted = vi.fn();
    const ui = createUi({ select: vi.fn().mockResolvedValue("Open") });
    const controller = new AbortController();
    const pending = handleElicitationRequest({ serverName: "demo", ui, allowUrl: true, openUrl: mocks.open, onUrlAccepted }, request({
      mode: "url",
      message: "Authorize",
      elicitationId: "auth-cancelled",
      url: "https://example.com/authorize",
    }), controller.signal);

    await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
    controller.abort(new Error("task cancelled"));
    await expect(pending).rejects.toThrow("task cancelled");
    resolveOpen();
    await Promise.resolve();
    expect(onUrlAccepted).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("collects a form with stock Pi dialogs and lets the user review it before sending", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = createUi({
      select: vi.fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Enter value")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn().mockResolvedValueOnce("octocat"),
      notify: vi.fn(),
    });

    const result = await handleElicitationRequest(
      { serverName: "github", ui, allowUrl: true },
      request({
        mode: "form",
        message: "Please provide your GitHub username",
        requestedSchema: {
          type: "object",
          properties: {
            username: { type: "string", title: "GitHub username", minLength: 1 },
          },
          required: ["username"],
        },
      }),
    );

    expect(ui.select.mock.calls[0]).toEqual([
      "MCP Input Request\nServer: github\n\nPlease provide your GitHub username",
      ["Continue", "Decline"],
    ]);
    expect(ui.input).toHaveBeenCalledWith("GitHub username (required)", undefined);
    expect(ui.select.mock.calls[2][0]).toContain("GitHub username: octocat");
    expect(result).toEqual({ action: "accept", content: { username: "octocat" } });
  });

  it("lets the user edit a value from the review screen", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = createUi({
      select: vi.fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Enter value")
        .mockResolvedValueOnce("Edit")
        .mockResolvedValueOnce("Name (name)")
        .mockResolvedValueOnce("Enter value")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn().mockResolvedValueOnce("Old").mockResolvedValueOnce("New"),
      notify: vi.fn(),
    });

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: true },
      request({
        mode: "form",
        message: "Choose a name",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", title: "Name" } },
        },
      }),
    );

    expect(ui.input.mock.calls[1]).toEqual(["Name", "Old"]);
    expect(result).toEqual({ action: "accept", content: { name: "New" } });
  });

  it("validates form values and lets the user correct invalid input", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = createUi({
      select: vi.fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Enter value")
        .mockResolvedValueOnce("Enter value")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn()
        .mockResolvedValueOnce("not-an-email")
        .mockResolvedValueOnce("octocat@example.com"),
      notify: vi.fn(),
    });

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: true },
      request({
        mode: "form",
        message: "Contact details",
        requestedSchema: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
          },
          required: ["email"],
        },
      }),
    );

    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("email"), "error");
    expect(result).toEqual({ action: "accept", content: { email: "octocat@example.com" } });
  });

  it.each([
    ["number", false],
    ["number", true],
    ["integer", false],
    ["integer", true],
  ] as const)("rejects blank %s input and reprompts when required=%s", async (type, required) => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = createUi({
      select: vi.fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Enter value")
        .mockResolvedValueOnce("Enter value")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn().mockResolvedValueOnce("   ").mockResolvedValueOnce("7"),
      notify: vi.fn(),
    });

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: false },
      request({
        mode: "form",
        message: "Choose a quantity",
        requestedSchema: {
          type: "object",
          properties: { quantity: { type } },
          ...(required ? { required: ["quantity"] } : {}),
        },
      }),
    );

    expect(ui.notify).toHaveBeenCalledWith("Elicitation field quantity must be a number", "error");
    expect(ui.input).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ action: "accept", content: { quantity: 7 } });
  });

  it("uses one confirmation dialog for an empty form", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const params = request({
      mode: "form",
      message: "Confirm the operation",
      requestedSchema: { type: "object", properties: {} },
    });

    for (const [selection, expected] of [
      ["Continue", { action: "accept", content: {} }],
      ["Decline", { action: "decline" }],
      [undefined, { action: "cancel" }],
    ]) {
      const select = vi.fn().mockResolvedValue(selection);
      await expect(handleElicitationRequest({
        serverName: "demo",
        ui: createUi({ select }),
        allowUrl: true,
      }, params)).resolves.toEqual(expected);
      expect(select).toHaveBeenCalledOnce();
      expect(select).toHaveBeenCalledWith(
        "MCP Input Request\nServer: demo\n\nConfirm the operation",
        ["Continue", "Decline"],
      );
    }
  });

  it("does not open URL elicitations that are declined or dismissed", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const params = request({
      mode: "url",
      message: "Authorize",
      elicitationId: "auth-1",
      url: "https://example.com/authorize",
    });

    await expect(handleElicitationRequest({
      serverName: "demo",
      ui: createUi({ select: vi.fn().mockResolvedValue("Decline") }),
      allowUrl: true,
      openUrl: mocks.open,
    }, params)).resolves.toEqual({ action: "decline" });
    await expect(handleElicitationRequest({
      serverName: "demo",
      ui: createUi({ select: vi.fn().mockResolvedValue(undefined) }),
      allowUrl: true,
      openUrl: mocks.open,
    }, params)).resolves.toEqual({ action: "cancel" });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([24, 48, 80])("keeps the full elicitation URL clickable at width %i before opening it", async (width) => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const onUrlAccepted = vi.fn();
    const ui = createUi({
      select: vi.fn().mockResolvedValueOnce("Open"),
      input: vi.fn(),
      notify: vi.fn(),
    });
    const url = `https://checkout.example.com/authorize?state=a%2Fb&scope=${"a".repeat(100)}`;

    const result = await handleElicitationRequest(
      { serverName: "payments", ui, allowUrl: true, openUrl: mocks.open, onUrlAccepted },
      request({
        mode: "url",
        message: "Authorize the payment provider",
        elicitationId: "payment-1",
        url,
      }),
    );

    expect(ui.select).toHaveBeenCalledWith([
      "MCP Browser Request",
      "Server: payments",
      "",
      "Authorize the payment provider",
      "",
      "Host: checkout.example.com",
      `Full URL: \u001B]8;;${url}\u001B\\${url}\u001B]8;;\u001B\\`,
      "",
      "Open this URL in your browser?",
    ].join("\n"), ["Open", "Decline"]);
    const urlLine = String(ui.select.mock.calls[0][0]).split("\n")[6].slice("Full URL: ".length);
    const rows = new Text(urlLine, 1, 0).render(width);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(getOsc8LinkAtColumn(row, 1)).toBe(url);
    }
    expect(mocks.open).toHaveBeenCalledWith(url);
    expect(onUrlAccepted).toHaveBeenCalledWith("payment-1");
    expect(result).toEqual({ action: "accept" });
  });

  it.each([24, 48, 80, 120])("links every wrapped URL occurrence in the full prompt at width %i", async (width) => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const url = `https://auth.example.com/authorize?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3A${"a".repeat(100)}`;
    const ui = createUi({ select: vi.fn().mockResolvedValue("Decline") });

    await handleElicitationRequest({ serverName: "demo", ui, allowUrl: true, openUrl: mocks.open }, request({
      mode: "url",
      message: `Sign in at ${url}\nOr visit ${url} to continue.`,
      elicitationId: "auth-1",
      url,
    }));

    const prompt = String(ui.select.mock.calls[0][0]);
    const rows = new Text(prompt, 1, 0).render(width);
    const cells = rows.flatMap((row, rowIndex) => Array.from(stripTerminalSequences(row), (char, col) => ({
      char,
      row: rowIndex,
      col,
    })).filter(cell => cell.char.trim() !== ""));
    const visible = cells.map(cell => cell.char).join("");
    let occurrences = 0;
    for (let start = visible.indexOf(url); start !== -1; start = visible.indexOf(url, start + url.length)) {
      occurrences++;
      const urlCells = cells.slice(start, start + url.length);
      expect(new Set(urlCells.map(cell => cell.row)).size).toBeGreaterThan(1);
      for (const cell of urlCells) {
        expect(getOsc8LinkAtColumn(rows[cell.row], cell.col)).toBe(url);
      }
    }
    expect(occurrences).toBe(3);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    "?account=work",
    "#permissions",
    "/work",
    ".json",
    ".other/path",
    ")extra",
    "`extra",
    "?return_to=https://example.com/authorize",
  ])("does not link the requested URL as a prefix of a longer URL ending in %s", async (suffix) => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const url = "https://example.com/authorize";
    const longerUrl = `${url}${suffix}`;
    const ui = createUi({ select: vi.fn().mockResolvedValue("Decline") });

    await handleElicitationRequest({ serverName: "demo", ui, allowUrl: true, openUrl: mocks.open }, request({
      mode: "url",
      message: `Longer URL: ${longerUrl}\nExact URL: ${url}`,
      elicitationId: "auth-1",
      url,
    }));

    const prompt = String(ui.select.mock.calls[0][0]);
    expect(prompt).toContain(`Longer URL: ${longerUrl}\n`);
    expect(prompt).toContain(`Exact URL: \u001B]8;;${url}\u001B\\${url}\u001B]8;;\u001B\\`);
    expect(stripTerminalSequences(prompt)).toContain(`Longer URL: ${longerUrl}\nExact URL: ${url}`);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    ["Continue at ", ""],
    ["Continue at ", "."],
    ["Continue at (", ")."],
    ["Continue at `", "`."],
    ["Continue at [", "];"],
    ["Continue at <", ">"],
    ['Continue at "', '",'],
    ["Continue at ", "!"],
    ["Continue at ", "?"],
    ["Continue at ", ":"],
  ])("links message URLs surrounded by %j and %j", async (prefix, suffix) => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const url = "https://example.com/authorize";
    const ui = createUi({ select: vi.fn().mockResolvedValue("Decline") });

    await handleElicitationRequest({ serverName: "demo", ui, allowUrl: true, openUrl: mocks.open }, request({
      mode: "url",
      message: `${prefix}${url}${suffix}`,
      elicitationId: "auth-1",
      url,
    }));

    const messageLine = String(ui.select.mock.calls[0][0]).split("\n")[3];
    expect(messageLine).toBe(`${prefix}\u001B]8;;${url}\u001B\\${url}\u001B]8;;\u001B\\${suffix}`);
    const rows = new Text(messageLine, 1, 0).render(24);
    const linkedRows = rows.filter(row => {
      const targets = Array.from({ length: 24 }, (_, column) => getOsc8LinkAtColumn(row, column + 1))
        .filter(Boolean);
      for (const target of targets) expect(target).toBe(url);
      return targets.length > 0;
    });
    expect(linkedRows.length).toBeGreaterThan(1);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/authorize?next=(login)",
    "https://example.com/authorize.",
  ])("preserves punctuation in the target URL %s", async (url) => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = createUi({ select: vi.fn().mockResolvedValue("Decline") });

    await handleElicitationRequest({ serverName: "demo", ui, allowUrl: true }, request({
      mode: "url",
      message: `Continue at (${url}). Then use \`${url}\`.`,
      elicitationId: "auth-1",
      url,
    }));

    const link = `\u001B]8;;${url}\u001B\\${url}\u001B]8;;\u001B\\`;
    expect(String(ui.select.mock.calls[0][0]).split("\n")[3])
      .toBe(`Continue at (${link}). Then use \`${link}\`.`);
  });

  it("rejects URL mode when the client advertised form-only support", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = createUi();

    await expect(handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: false },
      request({
        mode: "url",
        message: "Authorize",
        elicitationId: "auth-1",
        url: "https://example.com/authorize",
      }),
    )).rejects.toMatchObject({ code: -32602 });
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("rejects URL schemes that cannot be opened safely in a browser", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = createUi();

    await expect(handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: true, openUrl: mocks.open },
      request({
        mode: "url",
        message: "Open a file",
        elicitationId: "file-1",
        url: "file:///etc/passwd",
      }),
    )).rejects.toMatchObject({ code: -32602 });
    expect(ui.select).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("cancels URL elicitation when the browser cannot be opened", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    mocks.open.mockRejectedValueOnce(new Error("no browser"));
    const ui = createUi({
      select: vi.fn().mockResolvedValueOnce("Open"),
      input: vi.fn(),
      notify: vi.fn(),
    });

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: true, openUrl: mocks.open },
      request({
        mode: "url",
        message: "Authorize",
        elicitationId: "auth-1",
        url: "https://example.com/authorize",
      }),
    );

    expect(result).toEqual({ action: "cancel" });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("no browser"), "error");
  });

  it("supports every primitive form field, defaults, and omission", async () => {
    const { handleElicitationRequest } = await import("../elicitation-handler.ts");
    const ui = createUi({
      select: vi.fn()
        .mockResolvedValueOnce("Continue")
        .mockResolvedValueOnce("Use default")
        .mockResolvedValueOnce("Medium (medium)")
        .mockResolvedValueOnce("No")
        .mockResolvedValueOnce("Enter value")
        .mockResolvedValueOnce("Choose values")
        .mockResolvedValueOnce("Red")
        .mockResolvedValueOnce("Done")
        .mockResolvedValueOnce("Omit")
        .mockResolvedValueOnce("Submit"),
      input: vi.fn().mockResolvedValueOnce("42"),
      notify: vi.fn(),
    });

    const result = await handleElicitationRequest(
      { serverName: "demo", ui, allowUrl: true },
      request({
        mode: "form",
        message: "Configure the operation",
        requestedSchema: {
          type: "object",
          properties: {
            title: { type: "string", default: "Untitled" },
            priority: {
              type: "string",
              oneOf: [
                { const: "low", title: "Low" },
                { const: "medium", title: "Medium" },
              ],
            },
            enabled: { type: "boolean" },
            count: { type: "integer", minimum: 1, maximum: 100 },
            colors: {
              type: "array",
              items: { type: "string", enum: ["Red", "Blue"] },
              minItems: 1,
            },
            note: { type: "string" },
          },
          required: ["priority", "enabled", "count", "colors"],
        },
      }),
    );

    expect(result).toEqual({
      action: "accept",
      content: {
        title: "Untitled",
        priority: "medium",
        enabled: false,
        count: 42,
        colors: ["Red"],
      },
    });
  });
});
