import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildProxyDescription, resolveDirectTools } from "../direct-tools.js";
import { computeServerHash, type MetadataCache } from "../metadata-cache.js";
import { buildToolMetadata } from "../tool-metadata.js";
import type { McpConfig } from "../types.js";
import { reconstructToolMetadata } from "../metadata-cache.js";

const originalHashEnv = {
  MCP_HASH_CWD: process.env.MCP_HASH_CWD,
  MCP_HASH_ENV: process.env.MCP_HASH_ENV,
  MCP_HASH_HEADER: process.env.MCP_HASH_HEADER,
  MCP_HASH_TOKEN: process.env.MCP_HASH_TOKEN,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalHashEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("buildProxyDescription", () => {
  it("documents the ui-messages action", () => {
    const config: McpConfig = {
      mcpServers: {
        demo: {
          command: "npx",
          args: ["-y", "demo-server"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        demo: {
          configHash: "hash",
          cachedAt: Date.now(),
          tools: [
            {
              name: "launch_app",
              description: "Launch the demo app",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          resources: [],
        },
      },
    };

    const description = buildProxyDescription(config, cache, []);

    expect(description).toContain('mcp({ action: "ui-messages" })');
    expect(description).toContain("Retrieve accumulated messages from completed UI sessions");
    expect(description).toContain("Search MCP tools by name/description");
    expect(description).toContain("Non-MCP Pi tools should be called directly, not through mcp.");
    expect(description).not.toContain("MCP + pi");
  });

  it("excludes configured tools from proxy summaries", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          excludeTools: ["get_figjam", "figma_get_screenshot"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Take screenshot" },
            { name: "get_nodes", description: "Get nodes" },
          ],
          resources: [
            { name: "figjam", uri: "ui://figjam", description: "FigJam" },
          ],
        },
      },
    };

    const description = buildProxyDescription(config, cache, []);

    expect(description).toContain("Servers: figma (1 tools)");
    expect(description).not.toContain("figma (3 tools)");
  });
});

describe("metadata cache hashing", () => {
  it("hashes interpolated cwd", () => {
    process.env.MCP_HASH_CWD = "/tmp/mcp-one";
    const first = computeServerHash({ command: "node", cwd: "${MCP_HASH_CWD}/server" });

    process.env.MCP_HASH_CWD = "/tmp/mcp-two";
    const second = computeServerHash({ command: "node", cwd: "${MCP_HASH_CWD}/server" });

    expect(first).not.toBe(second);
    expect(computeServerHash({ command: "node", cwd: "${MCP_HASH_CWD}/server" })).toBe(
      computeServerHash({ command: "node", cwd: "/tmp/mcp-two/server" }),
    );
  });

  it("hashes interpolated env values", () => {
    process.env.MCP_HASH_ENV = "/tmp/data-one";
    const first = computeServerHash({ command: "node", env: { DATA_DIR: "${MCP_HASH_ENV}" } });

    process.env.MCP_HASH_ENV = "/tmp/data-two";
    const second = computeServerHash({ command: "node", env: { DATA_DIR: "${MCP_HASH_ENV}" } });

    expect(first).not.toBe(second);
    expect(computeServerHash({ command: "node", env: { DATA_DIR: "${MCP_HASH_ENV}" } })).toBe(
      computeServerHash({ command: "node", env: { DATA_DIR: "/tmp/data-two" } }),
    );
  });

  it("hashes interpolated header values", () => {
    process.env.MCP_HASH_HEADER = "header-one";
    const first = computeServerHash({ url: "https://example.test/mcp", headers: { "x-root": "$env:MCP_HASH_HEADER" } });

    process.env.MCP_HASH_HEADER = "header-two";
    const second = computeServerHash({ url: "https://example.test/mcp", headers: { "x-root": "$env:MCP_HASH_HEADER" } });

    expect(first).not.toBe(second);
    expect(computeServerHash({ url: "https://example.test/mcp", headers: { "x-root": "$env:MCP_HASH_HEADER" } })).toBe(
      computeServerHash({ url: "https://example.test/mcp", headers: { "x-root": "header-two" } }),
    );
  });

  it("hashes tilde cwd as the home directory", () => {
    expect(computeServerHash({ command: "node", cwd: "~/server" })).toBe(
      computeServerHash({ command: "node", cwd: join(homedir(), "server") }),
    );
  });

  it("hashes the effective bearerTokenEnv value", () => {
    process.env.MCP_HASH_TOKEN = "token-one";
    const first = computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerTokenEnv: "MCP_HASH_TOKEN" });

    process.env.MCP_HASH_TOKEN = "token-two";
    const second = computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerTokenEnv: "MCP_HASH_TOKEN" });

    expect(first).not.toBe(second);
    expect(computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerTokenEnv: "MCP_HASH_TOKEN" })).toBe(
      computeServerHash({ url: "https://example.test/mcp", auth: "bearer", bearerToken: "token-two", bearerTokenEnv: "MCP_HASH_TOKEN" }),
    );
  });

  it("hashes interpolated bearerToken values", () => {
    process.env.MCP_HASH_INLINE_TOKEN = "token-one";
    const first = computeServerHash({
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerToken: "${MCP_HASH_INLINE_TOKEN}",
    });

    process.env.MCP_HASH_INLINE_TOKEN = "token-two";
    const second = computeServerHash({
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerToken: "${MCP_HASH_INLINE_TOKEN}",
    });

    expect(first).not.toBe(second);
    expect(computeServerHash({
      url: "https://example.test/mcp",
      auth: "bearer",
      bearerToken: "${MCP_HASH_INLINE_TOKEN}",
    })).toBe(
      computeServerHash({
        url: "https://example.test/mcp",
        auth: "bearer",
        bearerToken: "token-two",
      }),
    );
  });
});

describe("excludeTools filtering", () => {
  it("filters excluded tools from live and cached metadata", () => {
    const definition = {
      command: "npx",
      args: ["-y", "figma"],
      excludeTools: ["figma_get_screenshot", "get_figjam"],
    };

    const { metadata } = buildToolMetadata(
      [
        { name: "get_screenshot", description: "Screenshot" },
        { name: "get_nodes", description: "Nodes" },
      ] as any,
      [
        { name: "figjam", uri: "ui://figjam", description: "FigJam" },
      ] as any,
      definition,
      "figma",
      "server",
    );

    expect(metadata.map((tool) => tool.name)).toEqual(["figma_get_nodes"]);

    const reconstructed = reconstructToolMetadata(
      "figma",
      {
        configHash: computeServerHash(definition),
        cachedAt: Date.now(),
        tools: [
          { name: "get_screenshot", description: "Screenshot" },
          { name: "get_nodes", description: "Nodes" },
        ],
        resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
      },
      "server",
      definition,
    );

    expect(reconstructed.map((tool) => tool.name)).toEqual(["figma_get_nodes"]);
  });

  it("filters excluded tools during direct tool registration from cache", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "server" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          excludeTools: ["figma_get_screenshot", "get_figjam"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [
            { name: "figjam", uri: "ui://figjam", description: "FigJam" },
          ],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "server");

    expect(specs.map((spec) => spec.prefixedName)).toEqual(["figma_get_nodes"]);
  });

  it("matches prefixed exclusions even when toolPrefix is none", () => {
    const config: McpConfig = {
      settings: { toolPrefix: "none" },
      mcpServers: {
        figma: {
          command: "npx",
          args: ["-y", "figma"],
          directTools: true,
          excludeTools: ["figma_get_screenshot"],
        },
      },
    };

    const cache: MetadataCache = {
      version: 1,
      servers: {
        figma: {
          configHash: computeServerHash(config.mcpServers.figma),
          cachedAt: Date.now(),
          tools: [
            { name: "get_screenshot", description: "Screenshot" },
            { name: "get_nodes", description: "Nodes" },
          ],
          resources: [],
        },
      },
    };

    const specs = resolveDirectTools(config, cache, "none");

    expect(specs.map((spec) => spec.prefixedName)).toEqual(["get_nodes"]);
  });
});
