// Verifies that adapter persistence defaults modern metadata to private.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateMetadataCache } from "../init.ts";
import { loadMetadataCache } from "../metadata-cache.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-modern-cache-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("modern metadata persistence", () => {
  it("persists public modern metadata until the server expiry", () => {
    const expiresAt = Date.now() + 60_000;
    const connection = {
      status: "connected",
      protocolEra: "modern",
      metadataCachePolicy: { cacheScope: "public", expiresAt },
      tools: [],
      resources: [],
      prompts: [],
      promptDiscoveryFailed: false,
    };
    const state = {
      manager: { getConnection: () => connection },
      config: { mcpServers: { demo: { command: "node" } } },
    };

    updateMetadataCache(state as never, "demo");

    expect(loadMetadataCache()?.servers.demo).toMatchObject({
      protocolEra: "modern",
      cacheScope: "public",
      expiresAt,
    });
  });

  it("does not persist metadata without an explicit public cache hint", () => {
    const connection = {
      status: "connected",
      protocolEra: "modern",
      tools: [],
      resources: [],
      prompts: [],
      promptDiscoveryFailed: false,
    };
    const state = {
      manager: { getConnection: () => connection },
      config: { mcpServers: { demo: { command: "node" } } },
    };

    updateMetadataCache(state as never, "demo");

    expect(loadMetadataCache()?.servers.demo).toBeUndefined();
  });
});
