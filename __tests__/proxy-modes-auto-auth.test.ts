import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  supportsOAuth: vi.fn(),
  lazyConnect: vi.fn(),
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  getFailureAgeSeconds: vi.fn(),
  updateStatusBar: vi.fn(),
}));

vi.mock("../mcp-auth-flow.js", () => ({
  authenticate: mocks.authenticate,
  supportsOAuth: mocks.supportsOAuth,
}));

vi.mock("../init.js", () => ({
  lazyConnect: mocks.lazyConnect,
  updateServerMetadata: mocks.updateServerMetadata,
  updateMetadataCache: mocks.updateMetadataCache,
  getFailureAgeSeconds: mocks.getFailureAgeSeconds,
  updateStatusBar: mocks.updateStatusBar,
}));

describe("proxy auto auth", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.authenticate.mockReset().mockResolvedValue("authenticated");
    mocks.supportsOAuth.mockReset().mockReturnValue(true);
    mocks.lazyConnect.mockReset().mockResolvedValue(false);
    mocks.updateServerMetadata.mockReset();
    mocks.updateMetadataCache.mockReset();
    mocks.getFailureAgeSeconds.mockReset().mockReturnValue(null);
    mocks.updateStatusBar.mockReset();
  });

  it("auto-authenticates and retries executeConnect once", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

    let current: any;
    const connected = {
      status: "connected",
      tools: [{ name: "search", description: "Search" }],
      resources: [],
    };

    const manager = {
      connect: vi
        .fn()
        .mockImplementationOnce(async () => {
          current = { status: "needs-auth" };
          return current;
        })
        .mockImplementationOnce(async () => {
          current = connected;
          return current;
        }),
      close: vi.fn(async () => {
        current = undefined;
      }),
      getConnection: vi.fn(() => current),
    };

    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map(),
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
    } as any;

    const result = await executeConnect(state, "demo");

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(manager.close).toHaveBeenCalledWith("demo");
    expect(manager.connect).toHaveBeenCalledTimes(2);
    expect(result.content[0].text).toContain("demo (1 tools)");
  });

  it("fails fast for non-ui browser auth when autoAuth is enabled", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

    const manager = {
      connect: vi.fn(async () => ({ status: "needs-auth" })),
      close: vi.fn(async () => {}),
      getConnection: vi.fn(() => ({ status: "needs-auth" })),
    };

    const state = {
      config: {
        settings: { autoAuth: true },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map(),
      failureTracker: new Map(),
      ui: undefined,
    } as any;

    const result = await executeConnect(state, "demo");

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("interactive session");
    expect(result.content[0].text).toContain("/mcp-auth demo");
  });

  it("uses custom authRequiredMessage for non-ui autoAuth failures", async () => {
    const { executeConnect } = await import("../proxy-modes.ts");

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
        connect: vi.fn(async () => ({ status: "needs-auth" })),
        close: vi.fn(async () => {}),
        getConnection: vi.fn(() => ({ status: "needs-auth" })),
      },
      toolMetadata: new Map(),
      failureTracker: new Map(),
      ui: undefined,
    } as any;

    const result = await executeConnect(state, "demo");

    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe("Reconnect demo from the host app.");
  });

  it("stores oversized proxy tool text in a temp file and keeps details bounded", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    const omittedPrefix = "proxy-prefix".repeat(6000);
    const visibleTail = "proxy-tail";
    const oversizedText = `${omittedPrefix}\n${visibleTail}`;
    const current = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [{ type: "text", text: oversizedText }],
        })),
      },
      tools: [{ name: "search", description: "Search" }],
      resources: [],
    };

    const manager = {
      connect: vi.fn(async () => current),
      close: vi.fn(async () => {}),
      getConnection: vi.fn(() => current),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map([
        [
          "demo",
          [
            {
              name: "demo_search",
              originalName: "search",
              description: "Search",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        ],
      ]),
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");
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
        mode: "call",
        mcpResult: {
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

  it("replaces oversized proxy image payloads with metadata and bounded details", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    const payload = "a".repeat(60000);
    const current = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [{ type: "image", data: payload, mimeType: "image/png" }],
        })),
      },
      tools: [{ name: "image", description: "Image" }],
      resources: [],
    };

    const manager = {
      connect: vi.fn(async () => current),
      close: vi.fn(async () => {}),
      getConnection: vi.fn(() => current),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map([
        [
          "demo",
          [
            {
              name: "demo_image",
              originalName: "image",
              description: "Image",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        ],
      ]),
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_image", {}, "demo");
    const text = result.content[0].text;
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(result.content[0].type).toBe("text");
      expect(text).toContain("[Image content: image/png");
      expect(text).not.toContain(payload);
      expect(JSON.stringify(result.details)).not.toContain(payload);
      expect(result.details).toMatchObject({
        mode: "call",
        mcpResult: {
          truncated: true,
          fullOutputPath,
        },
      });
      expect(fullOutputPath).toBeTruthy();
      expect(existsSync(fullOutputPath!)).toBe(true);
      expect(readFileSync(fullOutputPath!, "utf-8")).not.toContain(payload);
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("keeps oversized proxy error output within final Pi limits after schema text is appended", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    const omittedPrefix = "proxy-error-prefix".repeat(6000);
    const visibleTail = "proxy-error-tail";
    const oversizedText = `${omittedPrefix}\n${visibleTail}`;
    const largeInputSchema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 500 }, (_, index) => [`field_${index}`, { type: "string", description: "schema-description".repeat(10) }]),
      ),
    };
    const current = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: true,
          content: [{ type: "text", text: oversizedText }],
        })),
      },
      tools: [{ name: "search", description: "Search" }],
      resources: [],
    };

    const manager = {
      connect: vi.fn(async () => current),
      close: vi.fn(async () => {}),
      getConnection: vi.fn(() => current),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map([
        [
          "demo",
          [
            {
              name: "demo_search",
              originalName: "search",
              description: "Search",
              inputSchema: largeInputSchema,
            },
          ],
        ],
      ]),
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");
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
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("keeps thrown proxy call errors within final Pi limits", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    const omittedPrefix = "proxy-throw-prefix".repeat(6000);
    const visibleTail = "proxy-throw-tail";
    const current = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => {
          throw new Error(`${omittedPrefix}\n${visibleTail}`);
        }),
      },
      tools: [{ name: "search", description: "Search" }],
      resources: [],
    };

    const manager = {
      connect: vi.fn(async () => current),
      close: vi.fn(async () => {}),
      getConnection: vi.fn(() => current),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map([
        [
          "demo",
          [
            {
              name: "demo_search",
              originalName: "search",
              description: "Search",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        ],
      ]),
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");
    const text = result.content[0].text;
    const fullOutputPath = text.match(/Full output: (.+?)\]/)?.[1];

    try {
      expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(50 * 1024);
      expect(text).toContain("Failed to call tool:");
      expect(text).toContain(visibleTail);
      expect(text).not.toContain(omittedPrefix);
      expect(JSON.stringify(result.details)).not.toContain(omittedPrefix);
      expect(fullOutputPath).toBeTruthy();
      expect(existsSync(fullOutputPath!)).toBe(true);
    } finally {
      if (fullOutputPath && existsSync(fullOutputPath)) {
        unlinkSync(fullOutputPath);
      }
    }
  });

  it("auto-authenticates and retries executeCall once", async () => {
    const { executeCall } = await import("../proxy-modes.ts");

    let current: any = { status: "needs-auth" };
    const connected = {
      status: "connected",
      client: {
        callTool: vi.fn(async () => ({
          isError: false,
          content: [{ type: "text", text: "ok" }],
        })),
      },
      tools: [{ name: "search", description: "Search" }],
      resources: [],
    };

    const manager = {
      connect: vi.fn(async () => {
        current = connected;
        return connected;
      }),
      close: vi.fn(async () => {
        current = undefined;
      }),
      getConnection: vi.fn(() => current),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
      decrementInFlight: vi.fn(),
    };

    const state = {
      config: {
        settings: { autoAuth: true, toolPrefix: "server" },
        mcpServers: {
          demo: { url: "https://api.example.com/mcp", auth: "oauth" },
        },
      },
      manager,
      toolMetadata: new Map([
        [
          "demo",
          [
            {
              name: "demo_search",
              originalName: "search",
              description: "Search",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        ],
      ]),
      failureTracker: new Map(),
      ui: { setStatus: vi.fn() },
      completedUiSessions: [],
    } as any;

    const result = await executeCall(state, "demo_search", { q: "hello" }, "demo");

    expect(mocks.authenticate).toHaveBeenCalledWith(
      "demo",
      "https://api.example.com/mcp",
      state.config.mcpServers.demo,
    );
    expect(manager.connect).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("ok");
  });
});
