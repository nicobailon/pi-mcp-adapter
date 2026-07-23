import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cachePath: "",
  cache: null as { version: 1; servers: Record<string, unknown> } | null,
  config: { settings: {}, mcpServers: {} } as any,
  manager: undefined as any,
  getMissingConfiguredDirectToolServers: vi.fn(() => [] as string[]),
  buildToolMetadata: vi.fn(() => ({ metadata: [], failedTools: [] })),
}));

vi.mock("../config.ts", () => ({
  loadMcpConfig: vi.fn(() => mocks.config),
  resolveConfiguredOAuthDir: vi.fn((raw, cwd = process.cwd()) => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") throw new Error("settings.oauthDir must be a string");
    const trimmed = raw.trim();
    return trimmed ? join(cwd, trimmed) : undefined;
  }),
}));

vi.mock("../metadata-cache.ts", () => ({
  computeServerHash: vi.fn(() => "hash"),
  getMetadataCachePath: vi.fn(() => mocks.cachePath),
  isServerCacheValid: vi.fn(() => false),
  loadMetadataCache: vi.fn(() => mocks.cache),
  reconstructToolMetadata: vi.fn(() => []),
  saveMetadataCache: vi.fn((cache) => {
    mocks.cache = cache;
  }),
  serializeResources: vi.fn(() => []),
  serializeTools: vi.fn(() => []),
}));

vi.mock("../server-manager.ts", () => ({
  McpServerManager: vi.fn(() => mocks.manager),
}));

vi.mock("../tool-metadata.ts", () => ({
  buildToolMetadata: mocks.buildToolMetadata,
  totalToolCount: vi.fn(() => 0),
}));

vi.mock("../direct-tools.ts", () => ({
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
}));

function createManager() {
  const connection = {
    status: "connected" as const,
    tools: [],
    resources: [],
  };
  let current: typeof connection | undefined;
  const manager = {
    setDefaultRequestTimeoutMs: vi.fn(),
    setAuthStorageOptions: vi.fn(),
    setSamplingConfig: vi.fn(),
    setElicitationConfig: vi.fn(),
    getConnection: vi.fn(() => current),
    getAllConnections: vi.fn(() => current ? new Map([["srv", current]]) : new Map()),
    connect: vi.fn(async () => {
      current = connection;
      return connection;
    }),
    isIdle: vi.fn(() => false),
    closeAll: vi.fn(),
    close: vi.fn(async () => {
      current = undefined;
    }),
    clear: () => {
      current = undefined;
    },
  };
  return manager;
}

describe("lazy-keep-alive initializeMcp integration", () => {
  const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
  let tempDir: string;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.MCP_DIRECT_TOOLS;
    tempDir = mkdtempSync(join(tmpdir(), "pi-mcp-lifecycle-init-"));
    mocks.cachePath = join(tempDir, "mcp-cache.json");
    mocks.cache = { version: 1, servers: {} };
    mocks.config = {
      settings: {},
      mcpServers: { srv: { command: "demo", lifecycle: "lazy-keep-alive", directTools: true } },
    };
    mocks.manager = createManager();
    mocks.getMissingConfiguredDirectToolServers.mockReset().mockReturnValue([]);
    mocks.buildToolMetadata.mockClear();
  });

  afterEach(() => {
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("marks no-cache bootstrap spawns for health-check reconnects", async () => {
    mocks.cache = null;
    const { initializeMcp } = await import("../init.ts");

    const state = await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: false,
      mode: "headless",
      signal: undefined,
    } as any);

    mocks.manager.clear();
    await (state.lifecycle as any).checkConnections();

    expect(mocks.manager.connect).toHaveBeenCalledTimes(2);
  });

  it("marks direct-tool metadata bootstrap spawns for health-check reconnects", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["srv"]);
    const { initializeMcp } = await import("../init.ts");

    const state = await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: false,
      mode: "headless",
      signal: undefined,
    } as any);

    mocks.manager.clear();
    await (state.lifecycle as any).checkConnections();

    expect(mocks.manager.connect).toHaveBeenCalledTimes(2);
  });
});
