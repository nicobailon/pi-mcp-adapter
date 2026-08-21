import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cachePath: "",
  cache: null as { version: 1; servers: Record<string, unknown> } | null,
  config: { settings: {}, mcpServers: {} } as any,
  manager: undefined as any,
  createCachedToolSelectorCandidateIndex: vi.fn(() => undefined),
  getMissingConfiguredDirectToolServers: vi.fn(() => [] as string[]),
  isServerCacheValid: vi.fn(() => false),
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
  createCachedToolSelectorCandidateIndex: mocks.createCachedToolSelectorCandidateIndex,
  getMetadataCachePath: vi.fn(() => mocks.cachePath),
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
  isServerCacheValid: mocks.isServerCacheValid,
  loadMetadataCache: vi.fn(() => mocks.cache),
  reconstructToolMetadata: vi.fn(() => []),
  reconstructPromptMetadata: vi.fn(() => []),
  saveMetadataCache: vi.fn((cache) => {
    mocks.cache = cache;
  }),
  serializeResources: vi.fn(() => []),
  serializeTools: vi.fn(() => []),
  serializePrompts: vi.fn(() => []),
}));

vi.mock("../server-manager.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server-manager.ts")>();
  return {
    ...actual,
    McpServerManager: vi.fn(() => mocks.manager),
  };
});

vi.mock("../tool-metadata.ts", () => ({
  buildToolMetadata: mocks.buildToolMetadata,
  totalToolCount: vi.fn(() => 0),
}));

vi.mock("../direct-tools.ts", () => ({
  getMissingConfiguredDirectToolServers: mocks.getMissingConfiguredDirectToolServers,
}));

function createManager() {
  let metadataListChanged: ((serverName: string, reason: string) => void) | undefined;
  const connection = {
    status: "connected" as const,
    tools: [],
    resources: [],
  };
  let current: typeof connection | undefined;
  const manager = {
    setDefaultRequestTimeoutMs: vi.fn(),
    setAuthStorageOptions: vi.fn(),
    setMetadataListChangedListener: vi.fn((listener) => {
      metadataListChanged = listener;
    }),
    emitMetadataListChanged: (serverName = "srv", reason = "resources-list-changed") => metadataListChanged?.(serverName, reason),
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
    mocks.createCachedToolSelectorCandidateIndex.mockClear();
    mocks.isServerCacheValid.mockReset().mockReturnValue(false);
    mocks.buildToolMetadata.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDirectTools === undefined) {
      delete process.env.MCP_DIRECT_TOOLS;
    } else {
      process.env.MCP_DIRECT_TOOLS = originalDirectTools;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("provides all successful startup metadata for collision filtering", async () => {
    mocks.cache = null;
    mocks.config = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        "my-server": { command: "hyphen", lifecycle: "eager", excludeTools: ["search_records"] },
        my_2d_server: { command: "escaped", lifecycle: "eager" },
      },
    };
    mocks.manager = {
      ...createManager(),
      connect: vi.fn(async (name: string) => ({
        status: "connected",
        tools: [{ name: name === "my-server" ? "search-records" : "search_records", description: name }],
        resources: [],
      })),
      getAllConnections: vi.fn(() => new Map()),
    };
    const { initializeMcp } = await import("../init.ts");

    await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: false,
      mode: "headless",
    } as any);

    const knownMetadata = mocks.buildToolMetadata.mock.calls[0]?.[6] as Map<string, { originalName: string }[]>;
    expect(knownMetadata.get("my-server")?.map(tool => tool.originalName)).toEqual(["search-records"]);
    expect(knownMetadata.get("my_2d_server")?.map(tool => tool.originalName)).toEqual(["search_records"]);
    expect(mocks.buildToolMetadata.mock.calls[0]?.[7]).toBe(true);
  });

  it("does not treat cached lazy metadata as successful startup metadata", async () => {
    mocks.isServerCacheValid.mockReturnValue(true);
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.cache = {
      version: 1,
      servers: {
        my_server: {
          configHash: "hash",
          cachedAt: Date.now(),
          tools: [{ name: "other", description: "Cached lazy tool" }],
          resources: [],
        },
      },
    };
    mocks.config = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        "my-server": { command: "eager", lifecycle: "eager", excludeTools: ["my_server_do_thing"] },
        my_server: { command: "lazy" },
      },
    };
    mocks.manager = {
      ...createManager(),
      connect: vi.fn(async () => ({
        status: "connected",
        tools: [{ name: "do_thing", description: "Startup tool" }],
        resources: [],
      })),
      getAllConnections: vi.fn(() => new Map()),
    };
    const { initializeMcp } = await import("../init.ts");

    await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: false,
      mode: "headless",
    } as any);

    const knownMetadata = mocks.buildToolMetadata.mock.calls[0]?.[6] as Map<string, { originalName: string }[]>;
    expect(knownMetadata.get("my-server")?.map(tool => tool.originalName)).toEqual(["do_thing"]);
    expect(knownMetadata.has("my_server")).toBe(false);
    expect(mocks.buildToolMetadata.mock.calls[0]?.[7]).toBe(true);
  });

  it("does not index cached candidates when filtered metadata is invalid", async () => {
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.cache = {
      version: 1,
      servers: {
        srv: { configHash: "stale", cachedAt: Date.now(), tools: [], resources: [] },
      },
    };
    mocks.config = {
      settings: { toolPrefix: "server" },
      mcpServers: { srv: { command: "demo", includeTools: ["*"] } },
    };
    const { initializeMcp } = await import("../init.ts");

    await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: false,
      mode: "headless",
    } as any);

    expect(mocks.createCachedToolSelectorCandidateIndex).not.toHaveBeenCalled();
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

  it("records direct-tool bootstrap failures", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.config = {
      settings: {},
      mcpServers: { srv: { command: "demo", lifecycle: "lazy", directTools: true } },
    };
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["srv"]);
    mocks.manager.connect.mockRejectedValueOnce(new Error("bootstrap failed"));
    const { initializeMcp } = await import("../init.ts");

    const state = await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: false,
      mode: "headless",
      signal: undefined,
    } as any);

    expect(state.failureTracker.has("srv")).toBe(true);
    expect(state.failureMessages.get("srv")).toBe("bootstrap failed");
  });

  it("clears stale startup diagnostics when direct-tool bootstrap recovers", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.config = {
      settings: {},
      mcpServers: { srv: { command: "demo", lifecycle: "keep-alive", directTools: true } },
    };
    mocks.getMissingConfiguredDirectToolServers.mockReturnValue(["srv"]);
    mocks.manager.connect.mockRejectedValueOnce(new Error("startup failed"));
    const { initializeMcp } = await import("../init.ts");

    const state = await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: false,
      mode: "headless",
      signal: undefined,
    } as any);

    expect(mocks.manager.connect).toHaveBeenCalledTimes(2);
    expect(state.failureTracker.has("srv")).toBe(false);
    expect(state.failureMessages.has("srv")).toBe(false);
  });

  it("sanitizes captured diagnostics in startup notifications and terminal logs", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.config = {
      settings: {},
      mcpServers: { srv: { command: "demo", lifecycle: "eager" } },
    };
    mocks.manager.connect.mockRejectedValueOnce(new Error("stderr \x1b]52;c;clipboard-secret\x07startup failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { initializeMcp } = await import("../init.ts");
    const ui = { setStatus: vi.fn(), notify: vi.fn() };

    const state = await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: true,
      mode: "tui",
      ui,
      signal: undefined,
    } as any);

    expect(state.failureMessages.get("srv")).toContain("clipboard-secret");
    expect(ui.notify).toHaveBeenCalledWith("MCP: Failed to connect to srv: stderr startup failed", "error");
    expect(consoleError).toHaveBeenCalledWith("MCP: Failed to connect to srv: stderr startup failed");
  });

  it("honors the status icon opt-out during eager startup", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.config = {
      settings: { showStatusIcon: false },
      mcpServers: { srv: { command: "demo", lifecycle: "eager" } },
    };
    const { initializeMcp } = await import("../init.ts");
    const ui = { setStatus: vi.fn(), notify: vi.fn() };

    await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: true,
      mode: "tui",
      ui,
    } as any);

    expect(ui.setStatus).toHaveBeenCalledWith("mcp", "MCP: connecting to 1 servers...");
  });

  it("suppresses successful startup notices when configured", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.config = {
      settings: { notifyOnStartupConnect: false },
      mcpServers: { srv: { command: "demo", lifecycle: "eager" } },
    };
    const { initializeMcp } = await import("../init.ts");
    const ui = { setStatus: vi.fn(), notify: vi.fn() };

    await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: true,
      mode: "tui",
      ui,
    } as any);

    expect(ui.notify).not.toHaveBeenCalledWith("MCP: 1 servers connected (0 tools)", "info");
  });

  it("keeps startup notices enabled independently of the footer setting by default", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.config = {
      settings: { mcpFooterStatus: "off" },
      mcpServers: { srv: { command: "demo", lifecycle: "eager" } },
    };
    const { initializeMcp } = await import("../init.ts");
    const ui = { setStatus: vi.fn(), notify: vi.fn() };

    await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: true,
      mode: "tui",
      ui,
    } as any);

    expect(ui.notify).toHaveBeenCalledWith("MCP: 1 servers connected (0 tools)", "info");
    expect(ui.setStatus).toHaveBeenCalledWith("mcp", undefined);
  });

  it("keeps startup connection failures visible when success notices are suppressed", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.config = {
      settings: { notifyOnStartupConnect: false },
      mcpServers: { srv: { command: "demo", lifecycle: "eager" } },
    };
    mocks.manager.connect.mockRejectedValueOnce(new Error("startup failed"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { initializeMcp } = await import("../init.ts");
    const ui = { setStatus: vi.fn(), notify: vi.fn() };

    await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: true,
      mode: "tui",
      ui,
    } as any);

    expect(ui.notify).toHaveBeenCalledWith("MCP: Failed to connect to srv: startup failed", "error");
    expect(consoleError).toHaveBeenCalledWith("MCP: Failed to connect to srv: startup failed");
  });

  it("does not record or notify an aborted eager startup", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mocks.cachePath, JSON.stringify({ version: 1, servers: {} }));
    mocks.config = {
      settings: {},
      mcpServers: { srv: { command: "demo", lifecycle: "eager" } },
    };
    const controller = new AbortController();
    mocks.manager.connect.mockImplementationOnce(async () => {
      controller.abort(new Error("startup cancelled"));
      throw new Error("startup cancelled");
    });
    const { initializeMcp } = await import("../init.ts");
    const ui = { setStatus: vi.fn(), notify: vi.fn() };

    const state = await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: true,
      mode: "tui",
      ui,
      signal: controller.signal,
    } as any);

    expect(state.failureTracker.size).toBe(0);
    expect(state.failureMessages.size).toBe(0);
    expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Failed to connect"), "error");
  });

  it("does not preserve stale cached resources after authoritative list-change removal", async () => {
    const { initializeMcp, updateMetadataCache } = await import("../init.ts");

    const state = await initializeMcp({ getFlag: vi.fn(() => undefined) } as any, {
      cwd: tempDir,
      hasUI: false,
      mode: "headless",
      signal: undefined,
    } as any);

    mocks.cache = {
      version: 1,
      servers: {
        srv: {
          configHash: "hash",
          tools: [],
          resources: [{ uri: "ui://old", name: "Old resource" }],
          cachedAt: Date.now(),
        },
      },
    };

    updateMetadataCache(state, "srv");
    expect((mocks.cache?.servers.srv as any).resources).toEqual([{ uri: "ui://old", name: "Old resource" }]);

    updateMetadataCache(state, "srv", { preserveEmptyResources: false });
    expect((mocks.cache?.servers.srv as any).resources).toEqual([]);
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

  it("waits for keep-alive convergence before adapter-triggered model turns", async () => {
    const { initializeMcp } = await import("../init.ts");
    const sendMessage = vi.fn();
    const state = await initializeMcp({
      getFlag: vi.fn(() => undefined),
      sendMessage,
    } as any, {
      cwd: tempDir,
      hasUI: false,
      mode: "headless",
      signal: undefined,
    } as any);
    let finishConvergence!: () => void;
    vi.spyOn(state.lifecycle, "ensureConverged").mockReturnValue(new Promise<void>((resolve) => {
      finishConvergence = resolve;
    }));
    const message = {
      customType: "mcp-ui-prompt",
      content: [{ type: "text" as const, text: "continue" }],
    };

    state.sendMessage?.(message, { triggerTurn: true });
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();

    finishConvergence();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(message, { triggerTurn: true }));
  });
});
