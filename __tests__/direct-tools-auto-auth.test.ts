import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lazyConnect: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
}));

vi.mock("../init.js", () => ({
  lazyConnect: mocks.lazyConnect,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
}));

vi.mock("../mcp-auth-flow.js", () => ({
  authenticate: mocks.authenticate,
  supportsOAuth: mocks.supportsOAuth,
}));

describe("direct tools auto auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.lazyConnect.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
  });

  it("auto-authenticates and retries direct tool execution once", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    let connection: any = { status: "needs-auth" };
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [{ type: "text", text: "ok" }],
        })),
      },
    };

    mocks.lazyConnect
      .mockImplementationOnce(async () => false)
      .mockImplementationOnce(async () => {
        connection = connected;
        return true;
      });

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {
          connection = undefined;
        }),
        getConnection: vi.fn(() => connection),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const result = await executor("id", { q: "hello" }, undefined as any, () => {}, undefined as any);

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(state.manager.close).toHaveBeenCalledWith("demo");
    expect(result.content[0].text).toContain("ok");
  });

  it("stores oversized direct tool text in a temp file and returns a bounded preview", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const omittedPrefix = "omitted-prefix".repeat(6000);
    const visibleTail = "visible-tail";
    const oversizedText = `${omittedPrefix}\n${visibleTail}`;
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [{ type: "text", text: oversizedText }],
        })),
      },
    };

    mocks.lazyConnect.mockResolvedValue(true);

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => connected),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const result = await executor("id", { q: "hello" }, undefined as any, () => {}, undefined as any);
    const text = result.content[0].text;
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(text.length).toBeLessThan(oversizedText.length);
      expect(text).not.toContain(omittedPrefix);
      expect(text).toContain(visibleTail);
      expect(fullOutputPath).toBeTruthy();
      expect(existsSync(fullOutputPath!)).toBe(true);
      expect(readFileSync(fullOutputPath!, "utf-8")).toContain(oversizedText);
      expect(JSON.stringify(result.details)).not.toContain(omittedPrefix);
      expect(result.details).toMatchObject({
        server: "demo",
        tool: "search",
        output: {
          truncated: true,
          fullOutputPath,
        },
      });
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("stores oversized direct resource text in a temp file and returns a bounded preview", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const omittedPrefix = "resource-prefix".repeat(6000);
    const visibleTail = "resource-tail";
    const oversizedText = `${omittedPrefix}\n${visibleTail}`;
    const connected = {
      status: "connected",
      client: {
        readResource: vi.fn(async () => ({
          contents: [{ uri: "demo://large", text: oversizedText }],
        })),
      },
    };

    mocks.lazyConnect.mockResolvedValue(true);

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => connected),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "large_resource",
        prefixedName: "demo_large_resource",
        description: "Large resource",
        resourceUri: "demo://large",
      },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);
    const text = result.content[0].text;
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(text.length).toBeLessThan(oversizedText.length);
      expect(text).not.toContain(omittedPrefix);
      expect(text).toContain(visibleTail);
      expect(fullOutputPath).toBeTruthy();
      expect(existsSync(fullOutputPath!)).toBe(true);
      expect(readFileSync(fullOutputPath!, "utf-8")).toContain(oversizedText);
      expect(JSON.stringify(result.details)).not.toContain(omittedPrefix);
      expect(result.details).toMatchObject({
        server: "demo",
        resourceUri: "demo://large",
        output: {
          truncated: true,
          fullOutputPath,
        },
      });
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("keeps oversized direct error output within final Pi limits after schema text is appended", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const omittedPrefix = "direct-error-prefix".repeat(6000);
    const visibleTail = "direct-error-tail";
    const oversizedText = `${omittedPrefix}\n${visibleTail}`;
    const largeInputSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => [`field_${index}`, { type: "string", description: "schema-description".repeat(10) }]),
      ),
    };
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: true,
          content: [{ type: "text", text: oversizedText }],
        })),
      },
    };

    mocks.lazyConnect.mockResolvedValue(true);

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => connected),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
        inputSchema: largeInputSchema,
      },
    );

    const result = await executor("id", { q: "hello" }, undefined as any, () => {}, undefined as any);
    const text = result.content[0].text;
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(50 * 1024);
      expect(text.split("\n").length).toBeLessThanOrEqual(2000);
      expect(text).toContain("Error:");
      expect(text).toContain("Expected parameters:");
      expect(text).toContain(visibleTail);
      expect(text).not.toContain(omittedPrefix);
      expect(fullOutputPath).toBeTruthy();
      expect(existsSync(fullOutputPath!)).toBe(true);
      expect(JSON.stringify(result.details)).not.toContain(omittedPrefix);
      expect(result.details).toMatchObject({
        error: "tool_error",
        server: "demo",
        output: {
          truncated: true,
          fullOutputPath,
        },
      });
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("keeps thrown direct call errors within final Pi limits", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const omittedPrefix = "direct-throw-prefix".repeat(6000);
    const visibleTail = "direct-throw-tail";
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => {
          throw new Error(`${omittedPrefix}\n${visibleTail}`);
        }),
      },
    };

    mocks.lazyConnect.mockResolvedValue(true);

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => connected),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const result = await executor("id", { q: "hello" }, undefined as any, () => {}, undefined as any);
    const text = result.content[0].text;
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(50 * 1024);
      expect(text).toContain("Failed to call tool:");
      expect(text).toContain(visibleTail);
      expect(text).not.toContain(omittedPrefix);
      expect(fullOutputPath).toBeTruthy();
      expect(existsSync(fullOutputPath!)).toBe(true);
      expect(JSON.stringify(result.details)).not.toContain(omittedPrefix);
      expect(result.details).toMatchObject({
        error: "call_failed",
        server: "demo",
        output: {
          truncated: true,
          fullOutputPath,
        },
      });
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("replaces oversized direct image payloads with metadata", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const payload = "a".repeat(60000);
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [{ type: "image", data: payload, mimeType: "image/png" }],
        })),
      },
    };

    mocks.lazyConnect.mockResolvedValue(true);

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => connected),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "image",
        prefixedName: "demo_image",
        description: "Image",
      },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);
    const text = result.content[0].text;
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(result.content[0].type).toBe("text");
      expect(text).toContain("[Image content: image/png");
      expect(text).not.toContain(payload);
      expect(fullOutputPath).toBeTruthy();
      expect(existsSync(fullOutputPath!)).toBe(true);
      expect(readFileSync(fullOutputPath!, "utf-8")).not.toContain(payload);
      expect(JSON.stringify(result.details)).not.toContain(payload);
      expect(result.details).toMatchObject({
        server: "demo",
        tool: "image",
        output: {
          truncated: true,
          fullOutputPath,
        },
      });
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("omits resource blob payloads and sanitizes audio MIME labels in direct tool results", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const blobPayload = "base64-secret-ABC123";
    const unsafeMimeType = "audio-secret\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007";
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [
            { type: "resource", mimeType: unsafeMimeType, resource: { uri: "demo://blob", blob: blobPayload } },
            { type: "audio", mimeType: unsafeMimeType, data: blobPayload },
          ],
        })),
      },
    };

    mocks.lazyConnect.mockResolvedValue(true);

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => connected),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "media",
        prefixedName: "demo_media",
        description: "Media",
      },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);
    const text = result.content.map((block: any) => block.text ?? "").join("\n");

    expect(text).toContain("[Resource: demo://blob]");
    expect(text).toContain("[Binary data: application/octet-stream");
    expect(text).toContain("[Audio content: audio/*]");
    expect(text).not.toContain(blobPayload);
    expect(text).not.toContain("audio-secret");
    expect(text).not.toContain("https://example.com");
  });

  it("fails fast in non-ui context for browser-based OAuth", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => ({ status: "needs-auth" })),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: undefined,
      completedUiSessions: [],
    } as any;

    mocks.lazyConnect.mockResolvedValue(false);

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("interactive session");
    expect(result.content[0].text).toContain("/mcp-auth demo");
  });

  it("uses custom authRequiredMessage in non-ui direct tool auth failures", async () => {
    const { createDirectToolExecutor } = await import("../direct-tools.ts");

    const state = {
      config: {
        settings: {
          autoAuth: true,
          authRequiredMessage: "Reconnect ${server} from the host app.",
        },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager: {
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => ({ status: "needs-auth" })),
        touch: vi.fn(),
        incrementInFlight: vi.fn(),
        decrementInFlight: vi.fn(),
      },
      failureTracker: new Map(),
      ui: undefined,
      completedUiSessions: [],
    } as any;

    mocks.lazyConnect.mockResolvedValue(false);

    const executor = createDirectToolExecutor(
      () => state,
      () => null,
      {
        serverName: "demo",
        originalName: "search",
        prefixedName: "demo_search",
        description: "Search",
      },
    );

    const result = await executor("id", {}, undefined as any, () => {}, undefined as any);

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Reconnect demo from the host app.");
  });
});
