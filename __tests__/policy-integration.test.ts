// policy-integration.test.ts — RED phase: policy integration points (Slice 4)
import { describe, it, expect, vi, beforeAll } from "vitest";
import type { McpConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks for proxy-modes (must hoist before any imports that use init.js)
// ---------------------------------------------------------------------------
vi.mock("../init.js", () => ({
  lazyConnect: vi.fn(async () => true),
  updateServerMetadata: vi.fn(),
  updateMetadataCache: vi.fn(),
  getFailureAgeSeconds: vi.fn(() => null),
  updateStatusBar: vi.fn(),
}));

vi.mock("../metadata-cache.js", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  isServerCacheValid: vi.fn(() => true),
}));

import { resolveDirectTools } from "../direct-tools.js";
import { buildToolMetadata } from "../tool-metadata.js";
import { executeCall } from "../proxy-modes.js";

// ---------------------------------------------------------------------------
// 1. Config: validatePoliciesInConfig exported from config.ts
// ---------------------------------------------------------------------------
describe("Config integration: validatePoliciesInConfig", () => {
  it("is exported from config.ts as a callable function", async () => {
    const configModule = await import("../config.js");
    expect(typeof (configModule as any).validatePoliciesInConfig).toBe("function");
  });

  it("throws for a server entry whose policy has toolPolicies key not in allowedTools", async () => {
    const { validatePoliciesInConfig } = await import("../config.js") as any;
    const config: McpConfig = {
      mcpServers: {
        myserver: {
          command: "node",
          policy: {
            allowedTools: ["read_file"],
            toolPolicies: { write_file: {} }, // NOT in allowedTools
          },
        },
      } as any,
    };
    expect(() => validatePoliciesInConfig(config)).toThrow(/write_file|toolPolicies|allowedTools/i);
  });

  it("does not throw when all server policies are valid", async () => {
    const { validatePoliciesInConfig } = await import("../config.js") as any;
    const config: McpConfig = {
      mcpServers: {
        myserver: {
          command: "node",
          policy: {
            allowedTools: ["read_file"],
            toolPolicies: { read_file: { requireKeys: ["path"] } },
          },
        },
      } as any,
    };
    expect(() => validatePoliciesInConfig(config)).not.toThrow();
  });

  it("does not throw when no server has a policy field", async () => {
    const { validatePoliciesInConfig } = await import("../config.js") as any;
    const config: McpConfig = {
      mcpServers: { myserver: { command: "node" } },
    };
    expect(() => validatePoliciesInConfig(config)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Direct tools: resolveDirectTools respects policy.allowedTools
// ---------------------------------------------------------------------------
describe("Direct tools: resolveDirectTools respects policy.allowedTools", () => {
  const makeCache = (toolNames: string[]) => ({
    version: 1,
    servers: {
      myserver: {
        configHash: "any",
        cachedAt: Date.now(),
        tools: toolNames.map((n) => ({ name: n, description: n })),
        resources: [],
      },
    },
  });

  it("intersection: directTools=true + policy.allowedTools=['read_file'] → only read_file", () => {
    const config: any = {
      mcpServers: {
        myserver: {
          command: "node",
          directTools: true,
          policy: { allowedTools: ["read_file"] },
        },
      },
    };
    const specs = resolveDirectTools(config, makeCache(["read_file", "write_file", "delete_file"]), "none");
    const names = specs.map((s) => s.originalName);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("delete_file");
  });

  it("intersection: directTools=['read_file','write_file'] + policy.allowedTools=['read_file'] → only read_file", () => {
    const config: any = {
      mcpServers: {
        myserver: {
          command: "node",
          directTools: ["read_file", "write_file"],
          policy: { allowedTools: ["read_file"] },
        },
      },
    };
    const specs = resolveDirectTools(config, makeCache(["read_file", "write_file"]), "none");
    const names = specs.map((s) => s.originalName);
    expect(names).toEqual(["read_file"]);
  });

  it("policy.allowedTools alone does NOT promote tools to direct (directTools still required)", () => {
    const config: any = {
      mcpServers: {
        myserver: {
          command: "node",
          // no directTools — policy.allowedTools must not act as directTools
          policy: { allowedTools: ["read_file"] },
        },
      },
    };
    const specs = resolveDirectTools(config, makeCache(["read_file"]), "none");
    expect(specs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Metadata filtering: buildToolMetadata respects policy
// ---------------------------------------------------------------------------
describe("Metadata filtering: buildToolMetadata respects policy", () => {
  it("only includes allowed tools when policy.allowedTools is set (non-empty)", () => {
    const tools = [
      { name: "read_file", description: "Read" },
      { name: "write_file", description: "Write" },
      { name: "delete_file", description: "Delete" },
    ];
    const definition: any = {
      command: "node",
      policy: { allowedTools: ["read_file"] },
    };
    const { metadata } = buildToolMetadata(tools, [], definition, "myserver", "none");
    const names = metadata.map((m) => m.originalName);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("delete_file");
  });

  it("only includes allowed resources when policy.allowedResources is set (non-empty)", () => {
    const resources = [
      { uri: "file:///readme.md", name: "README" },
      { uri: "file:///secret.txt", name: "Secret" },
    ];
    const definition: any = {
      command: "node",
      exposeResources: true,
      policy: { allowedResources: ["file:///readme.md"] },
    };
    const { metadata } = buildToolMetadata([], resources, definition, "myserver", "none");
    const uris = metadata.map((m) => m.resourceUri).filter(Boolean);
    expect(uris).toContain("file:///readme.md");
    expect(uris).not.toContain("file:///secret.txt");
  });

  it("returns all tools when policy is absent (no regression)", () => {
    const tools = [
      { name: "read_file", description: "Read" },
      { name: "write_file", description: "Write" },
    ];
    const definition: any = { command: "node" };
    const { metadata } = buildToolMetadata(tools, [], definition, "myserver", "none");
    expect(metadata).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Proxy call enforcement: executeCall checks policy.allowedTools
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<any> = {}): any {
  return {
    config: {
      mcpServers: {
        myserver: {
          command: "node",
          policy: { allowedTools: ["read_file"] },
        },
      },
      settings: { toolPrefix: "none" },
    },
    toolMetadata: new Map([
      [
        "myserver",
        [
          { name: "read_file", originalName: "read_file", description: "Read" },
          { name: "write_file", originalName: "write_file", description: "Write" },
        ],
      ],
    ]),
    manager: {
      getConnection: vi.fn(() => null),
      decrementInFlight: vi.fn(),
      touch: vi.fn(),
      incrementInFlight: vi.fn(),
    },
    lifecycle: {},
    failureTracker: new Map(),
    completedUiSessions: [],
    consentManager: { needsConsent: vi.fn(() => false) },
    uiResourceHandler: {},
    uiServer: null,
    ...overrides,
  };
}

describe("Proxy call enforcement: executeCall checks policy.allowedTools", () => {
  it("returns a policy-violation error when tool is not in allowedTools", async () => {
    const state = makeState();
    const result = await executeCall(state, "write_file", {}, "myserver");
    // Should return a policy-violation error, not connect_failed or tool_not_found
    expect(result.details).toMatchObject({
      error: expect.stringMatching(/policy|not allowed|allowedTools/i),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/policy|not allowed|allowedTools/i),
    });
  });

  it("returns applyToolPolicy error when args violate the tool's toolPolicy", async () => {
    const state = makeState({
      config: {
        mcpServers: {
          myserver: {
            command: "node",
            policy: {
              allowedTools: ["read_file"],
              toolPolicies: { read_file: { requireKeys: ["path"] } },
            },
          },
        },
        settings: { toolPrefix: "none" },
      },
    });

    // Missing required "path" key — should fail policy, not proceed to connection
    const result = await executeCall(state, "read_file", {}, "myserver");
    expect(result.details).toMatchObject({
      error: expect.stringMatching(/policy|path|required/i),
    });
  });
});
