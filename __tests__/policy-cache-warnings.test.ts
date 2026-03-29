// policy-cache-warnings.test.ts — RED phase: cache invalidation + startup warnings (Slice 5)
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeServerHash } from "../metadata-cache.js";
import type { ServerEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function entry(overrides: Partial<ServerEntry> = {}): ServerEntry {
  return { command: "node", args: ["server.js"], ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Cache invalidation: policy changes must change the hash
// ---------------------------------------------------------------------------
describe("computeServerHash: policy changes invalidate the cache", () => {
  it("adding allowedTools to policy changes the hash", () => {
    const base = entry();
    const withPolicy = entry({ policy: { allowedTools: ["read_file"] } } as any);
    expect(computeServerHash(withPolicy)).not.toBe(computeServerHash(base));
  });

  it("changing allowedTools changes the hash", () => {
    const a = entry({ policy: { allowedTools: ["read_file"] } } as any);
    const b = entry({ policy: { allowedTools: ["write_file"] } } as any);
    expect(computeServerHash(a)).not.toBe(computeServerHash(b));
  });

  it("changing allowedResources changes the hash", () => {
    const a = entry({ policy: { allowedResources: ["file:///a.md"] } } as any);
    const b = entry({ policy: { allowedResources: ["file:///b.md"] } } as any);
    expect(computeServerHash(a)).not.toBe(computeServerHash(b));
  });

  it("changing allowedPrompts changes the hash", () => {
    const a = entry({ policy: { allowedPrompts: ["summarize"] } } as any);
    const b = entry({ policy: { allowedPrompts: ["translate"] } } as any);
    expect(computeServerHash(a)).not.toBe(computeServerHash(b));
  });

  it("changing toolPolicies changes the hash", () => {
    const a = entry({ policy: { toolPolicies: { read_file: { requireKeys: ["path"] } } } } as any);
    const b = entry({ policy: { toolPolicies: { read_file: { requireKeys: ["dir"] } } } } as any);
    expect(computeServerHash(a)).not.toBe(computeServerHash(b));
  });

  it("removing the policy field entirely changes the hash", () => {
    const withPolicy = entry({ policy: { allowedTools: ["read_file"] } } as any);
    const noPolicy = entry();
    expect(computeServerHash(withPolicy)).not.toBe(computeServerHash(noPolicy));
  });

  it("same policy produces the same hash (deterministic)", () => {
    const a = entry({ policy: { allowedTools: ["read_file", "write_file"] } } as any);
    const b = entry({ policy: { allowedTools: ["read_file", "write_file"] } } as any);
    expect(computeServerHash(a)).toBe(computeServerHash(b));
  });
});

// ---------------------------------------------------------------------------
// 2. Startup warnings: non-existent allowlist entries are warned
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

import { buildToolMetadata } from "../tool-metadata.js";

describe("buildToolMetadata: warns when allowlist entries are not found on the server", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when allowedTools lists a tool not present on the server", () => {
    const tools = [{ name: "read_file", description: "Read" }];
    const definition: any = {
      command: "node",
      policy: { allowedTools: ["read_file", "nonexistent_tool"] },
    };
    buildToolMetadata(tools, [], definition, "myserver", "none");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/nonexistent_tool|allowedTools|not found/i)
    );
  });

  it("warns when allowedResources lists a URI not present on the server", () => {
    const resources = [{ uri: "file:///readme.md", name: "README" }];
    const definition: any = {
      command: "node",
      exposeResources: true,
      policy: { allowedResources: ["file:///readme.md", "file:///missing.txt"] },
    };
    buildToolMetadata([], resources, definition, "myserver", "none");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/missing\.txt|allowedResources|not found/i)
    );
  });

  it("warns when allowedPrompts lists a prompt not present on the server", async () => {
    const toolMetaModule = await import("../tool-metadata.js") as any;
    const checkFn = toolMetaModule.checkPolicyAllowlistWarnings;
    // If the function doesn't exist yet, the test fails — expected RED
    expect(typeof checkFn).toBe("function");
    checkFn(
      { allowedPrompts: ["summarize", "ghost_prompt"] },
      [],          // available tools
      [],          // available resources
      [{ name: "summarize" }], // available prompts
      "myserver"
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/ghost_prompt|allowedPrompts|not found/i)
    );
  });

  it("does not warn when all allowedTools entries exist on the server", () => {
    const tools = [
      { name: "read_file", description: "Read" },
      { name: "write_file", description: "Write" },
    ];
    const definition: any = {
      command: "node",
      policy: { allowedTools: ["read_file", "write_file"] },
    };
    buildToolMetadata(tools, [], definition, "myserver", "none");
    const policyWarns = warnSpy.mock.calls.filter(args =>
      /allowedTools|not found|nonexistent/i.test(String(args))
    );
    expect(policyWarns).toHaveLength(0);
  });
});
