import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentPluginConfigs } from "../agent-plugin-loader.ts";
import { isBuiltInAgentPlugin, mergeBuiltInAgentPluginEntries } from "../agent-plugin-provenance.ts";
import { cloneMcpConfig, loadMcpConfig } from "../config.ts";
import { computeServerHash } from "../metadata-cache.ts";
import { McpServerManager } from "../server-manager.ts";

const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const argvEchoServer = resolve(import.meta.dirname, "fixtures", "argv-echo-server.mjs");
const originalCwd = process.cwd();
const originalEnv = { ...process.env };

function temp(prefix = "pi-agent-plugin-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writePlugin(root: string, servers: Record<string, unknown>, manifest: Record<string, unknown> = {}): void {
  mkdirSync(root, { recursive: true });
  writeJson(join(root, "plugin.json"), { $schema: PLUGIN_SCHEMA, name: "test.plugin", ...manifest });
  writeJson(join(root, "mcp.json"), { $schema: MCP_SCHEMA, mcpServers: servers });
}

function onlyServer(root: string) {
  const server = Object.values(loadAgentPluginConfigs([root], root).mcpServers)[0];
  if (!server) throw new Error("expected one Agent Plugin server");
  return server;
}

function firstText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("expected a tool result with content");
  }
  const first = result.content[0];
  if (!first || typeof first !== "object" || !("type" in first) || first.type !== "text" || !("text" in first) || typeof first.text !== "string") {
    throw new Error("expected text tool content");
  }
  return first.text;
}

afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("built-in Agent Plugin conformance", () => {
  it("keeps cloned programmatic plugin stdio values literal at runtime", async () => {
    const parent = temp();
    const root = join(parent, "${PLUGIN_DATA}");
    process.env.HOME = temp("pi-agent-plugin-home-");
    process.env.PI_CODING_AGENT_DIR = join(process.env.HOME, "agent");
    process.env.PLUGIN_DATA = "rescanned";
    process.env.PLUGIN_LITERAL_ENV_HOST = "leaked";
    writePlugin(root, {
      echo: {
        type: "stdio",
        command: "node",
        args: [argvEchoServer, "${PLUGIN_ROOT}", "${PLUGIN_LITERAL_ENV_HOST}"],
        env: Object.fromEntries([
          ["PLUGIN_LITERAL_ENV", "${PLUGIN_LITERAL_ENV_HOST}"],
          ["__proto__", "literal-proto-env"],
        ]),
        cwd: "${PLUGIN_ROOT}",
      },
    });

    const definition = cloneMcpConfig({ mcpServers: { echo: onlyServer(root) } }).mcpServers.echo;
    const manager = new McpServerManager(root);
    try {
      const connection = await manager.connect("test_plugin__echo", definition);
      const result = await connection.client.callTool({ name: "echo", arguments: {} });
      const seen = JSON.parse(firstText(result));
      expect(seen).toEqual({
        argv: [realpathSync(root), "${PLUGIN_LITERAL_ENV_HOST}"],
        cwd: realpathSync(root),
        literalEnv: "${PLUGIN_LITERAL_ENV_HOST}",
        protoEnv: "literal-proto-env",
      });
    } finally {
      await manager.close();
    }
  });

  it("keeps cloned programmatic plugin headers literal and native headers dynamic", async () => {
    process.env.PLUGIN_HTTP_SECRET = "leaked";
    const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((request, response) => {
      seenHeaders.push(request.headers);
      response.writeHead(500).end("stop");
    });
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const root = temp();
    writePlugin(root, {
      remote: {
        type: "streamable-http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: Object.fromEntries([
          ["X-Command", "!printf command-value"],
          ["X-Env", "${PLUGIN_HTTP_SECRET}"],
          ["__proto__", "literal-proto-header"],
        ]),
      },
    });
    const definition = cloneMcpConfig({ mcpServers: { remote: onlyServer(root) } }).mcpServers.remote;
    if (!definition.headers) throw new Error("expected Agent Plugin headers");
    expect(Object.hasOwn(definition.headers, "__proto__")).toBe(true);
    expect(definition.headers["__proto__"]).toBe("literal-proto-header");
    const manager = new McpServerManager(root);
    try {
      await manager.connect("test_plugin__remote", definition).catch(() => undefined);
      expect(seenHeaders.some(headers => headers["x-command"] === "!printf command-value")).toBe(true);
      expect(seenHeaders.some(headers => headers["x-env"] === "${PLUGIN_HTTP_SECRET}")).toBe(true);

      seenHeaders.length = 0;
      const native = cloneMcpConfig({
        mcpServers: {
          native: {
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: { "X-Command": "!printf command-value", "X-Env": "${PLUGIN_HTTP_SECRET}" },
          },
        },
      }).mcpServers.native;
      await manager.connect("native", native).catch(() => undefined);
      expect(seenHeaders.some(headers => headers["x-command"] === "command-value")).toBe(true);
      expect(seenHeaders.some(headers => headers["x-env"] === "leaked")).toBe(true);
    } finally {
      await manager.close();
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    }
  });

  it("cannot transfer literal header trust from a built-in donor to unrelated values", async () => {
    const root = temp();
    writePlugin(root, {
      remote: { type: "streamable-http", url: "https://example.test/mcp", headers: { "X-Test": "literal" } },
    });
    const donor = onlyServer(root);
    const attacker = { url: "https://evil.test", headers: { "X-Test": "!printf attacker" } };

    expect(isBuiltInAgentPlugin(mergeBuiltInAgentPluginEntries(donor, { auth: false }), "headers")).toBe(true);
    expect(isBuiltInAgentPlugin(mergeBuiltInAgentPluginEntries(donor, attacker), "headers")).toBe(false);
    expect("preserveBuiltInAgentPluginFields" in await import("../agent-plugin-loader.ts")).toBe(false);
  });

  it.each([false, "oauth"] as const)("keeps inherited plugin headers literal across an auth override: %s", async auth => {
    const home = temp("pi-agent-plugin-home-");
    const project = temp("pi-agent-plugin-project-");
    const root = join(project, "plugin");
    process.env.HOME = home;
    process.env.PLUGIN_HTTP_SECRET = "leaked";
    process.chdir(project);
    const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer((request, response) => {
      seenHeaders.push(request.headers);
      response.writeHead(500).end("stop");
    });
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    writePlugin(root, {
      remote: {
        type: "streamable-http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { "X-Command": "!printf command-value", "X-Env": "${PLUGIN_HTTP_SECRET}" },
      },
    });
    writeJson(join(project, ".mcp.json"), {
      settings: { agentPluginPaths: [root] },
      mcpServers: { test_plugin__remote: { auth } },
    });

    const manager = new McpServerManager(project);
    try {
      const definition = cloneMcpConfig(loadMcpConfig()).mcpServers.test_plugin__remote;
      expect(computeServerHash(definition, { PLUGIN_HTTP_SECRET: "one" }))
        .toBe(computeServerHash(definition, { PLUGIN_HTTP_SECRET: "two" }));
      await manager.connect("test_plugin__remote", definition).catch(() => undefined);
      expect(seenHeaders.some(headers => headers["x-command"] === "!printf command-value")).toBe(true);
      expect(seenHeaders.some(headers => headers["x-env"] === "${PLUGIN_HTTP_SECRET}")).toBe(true);
    } finally {
      await manager.close();
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    }
  });

  it("keeps native stdio interpolation unchanged", async () => {
    process.env.NATIVE_PLUGIN_TEST = "expanded";
    const root = temp();
    const manager = new McpServerManager(root);
    try {
      const definition = cloneMcpConfig({ mcpServers: { native: {
        command: "node",
        args: [argvEchoServer, "${NATIVE_PLUGIN_TEST}"],
        env: { PLUGIN_LITERAL_ENV: "${NATIVE_PLUGIN_TEST}" },
        cwd: root,
      } } }).mcpServers.native;
      const connection = await manager.connect("native", definition);
      const result = await connection.client.callTool({ name: "echo", arguments: {} });
      const seen = JSON.parse(firstText(result));
      expect(seen.argv).toEqual(["expanded"]);
      expect(seen.literalEnv).toBe("expanded");
    } finally {
      await manager.close();
    }
  });

  it("rejects plugin files and paths that resolve outside the plugin root", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outside = temp();
    writeJson(join(outside, "plugin.json"), { $schema: PLUGIN_SCHEMA, name: "escaped.plugin" });
    writeJson(join(outside, "mcp.json"), { $schema: MCP_SCHEMA, mcpServers: { escaped: { type: "stdio", command: "node" } } });
    writeFileSync(join(outside, "server"), "#!/bin/sh\n");
    mkdirSync(join(outside, "cwd"));

    const manifestRoot = temp();
    symlinkSync(join(outside, "plugin.json"), join(manifestRoot, "plugin.json"));
    writeJson(join(manifestRoot, "mcp.json"), { $schema: MCP_SCHEMA, mcpServers: {} });
    expect(loadAgentPluginConfigs([manifestRoot], manifestRoot).mcpServers).toEqual({});

    const mcpRoot = temp();
    writeJson(join(mcpRoot, "plugin.json"), { $schema: PLUGIN_SCHEMA, name: "escaped.mcp" });
    symlinkSync(join(outside, "mcp.json"), join(mcpRoot, "mcp.json"));
    expect(loadAgentPluginConfigs([mcpRoot], mcpRoot).mcpServers).toEqual({});

    const commandRoot = temp();
    writePlugin(commandRoot, { escaped: { type: "stdio", command: "./server" } });
    symlinkSync(join(outside, "server"), join(commandRoot, "server"));
    expect(loadAgentPluginConfigs([commandRoot], commandRoot).mcpServers).toEqual({});

    const cwdRoot = temp();
    writePlugin(cwdRoot, { escaped: { type: "stdio", command: "node", cwd: "./cwd" } });
    symlinkSync(join(outside, "cwd"), join(cwdRoot, "cwd"));
    expect(loadAgentPluginConfigs([cwdRoot], cwdRoot).mcpServers).toEqual({});
    expect(warning).toHaveBeenCalled();
  });

  it("allows symlinks whose resolved target remains inside the plugin root", () => {
    const root = temp();
    writePlugin(root, { valid: { type: "stdio", command: "./server-link", cwd: "./cwd-link" } });
    writeFileSync(join(root, "server"), "#!/bin/sh\n");
    mkdirSync(join(root, "cwd"));
    symlinkSync(join(root, "server"), join(root, "server-link"));
    symlinkSync(join(root, "cwd"), join(root, "cwd-link"));
    expect(onlyServer(root)).toMatchObject({ command: join(root, "server"), cwd: join(root, "cwd") });
  });

  it("rejects PLUGIN_DATA symlink escapes and allows missing or contained data cwd", async () => {
    const home = temp("pi-agent-plugin-home-");
    const root = temp();
    process.env.PI_CODING_AGENT_DIR = join(home, "agent");
    const dataBase = join(home, "agent", "agent-plugin-data");
    const dataDir = join(dataBase, "test.plugin");
    process.env.HOME = home;
    mkdirSync(dataBase, { recursive: true });
    symlinkSync(temp("pi-agent-plugin-outside-"), dataDir);
    writePlugin(root, { escaped: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}" } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadAgentPluginConfigs([root], root).mcpServers).toEqual({});

    const childRoot = temp();
    const childDataDir = join(dataBase, "child.plugin");
    mkdirSync(childDataDir);
    symlinkSync(temp("pi-agent-plugin-outside-child-"), join(childDataDir, "work"));
    writePlugin(childRoot, { escaped: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/work" } }, { name: "child.plugin" });
    expect(loadAgentPluginConfigs([childRoot], childRoot).mcpServers).toEqual({});

    const secondRoot = temp();
    writePlugin(secondRoot, { valid: { type: "stdio", command: "node", args: [argvEchoServer], cwd: "${PLUGIN_DATA}/work" } }, { name: "second.plugin" });
    const secondDataDir = join(dataBase, "second.plugin");
    const definition = onlyServer(secondRoot);
    expect(definition.cwd).toBe(join(secondDataDir, "work"));
    mkdirSync(join(secondDataDir, "work"), { recursive: true });
    const manager = new McpServerManager(secondRoot);
    try {
      const connection = await manager.connect("second_plugin__valid", definition);
      const result = await connection.client.callTool({ name: "echo", arguments: {} });
      expect(JSON.parse(firstText(result)).cwd).toBe(realpathSync(join(secondDataDir, "work")));
    } finally {
      await manager.close();
    }
  });

  it("expands every cwd placeholder once before containment", () => {
    const home = temp("pi-agent-plugin-home-");
    const root = temp();
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = join(home, "agent");
    const dataDir = join(home, "agent", "agent-plugin-data", "test.plugin");
    const expanded = `${root}/nested/${dataDir}`;
    mkdirSync(expanded, { recursive: true });
    writePlugin(root, { valid: { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}/nested/${PLUGIN_DATA}" } });
    expect(onlyServer(root).cwd).toBe(realpathSync(expanded));
  });

  it.each([
    ["version", 123],
    ["keywords", "not-an-array"],
    ["author", { unexpected: true }],
  ])("rejects an invalid known manifest field %s", (field, value) => {
    const root = temp();
    writePlugin(root, { valid: { type: "stdio", command: "node" } }, { [field]: value });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadAgentPluginConfigs([root], root).mcpServers).toEqual({});
  });

  it("accepts non-semver string metadata and preserves permissive extension handling", () => {
    const root = temp();
    writePlugin(root, { valid: { type: "stdio", command: "node" } }, {
      version: "not semver",
      extensions: "ignored",
      futureField: true,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(Object.keys(loadAgentPluginConfigs([root], root).mcpServers)).toEqual(["test_plugin__valid"]);
  });

  it("hashes plugin literals without host interpolation and drops provenance on native overrides", () => {
    const home = temp("pi-agent-plugin-home-");
    const project = temp("pi-agent-plugin-project-");
    const root = join(project, "plugin");
    process.env.HOME = home;
    process.chdir(project);
    writePlugin(root, {
      remote: { type: "streamable-http", url: "https://example.test/mcp", headers: { "X-Test": "${HASH_VALUE}" } },
    });
    writeJson(join(project, ".mcp.json"), {
      settings: { agentPluginPaths: [root] },
      mcpServers: { test_plugin__remote: { disabled: false } },
    });

    let definition = loadMcpConfig().mcpServers.test_plugin__remote;
    expect(computeServerHash(definition, { HASH_VALUE: "one" })).toBe(computeServerHash(definition, { HASH_VALUE: "two" }));

    writeJson(join(project, ".mcp.json"), {
      settings: { agentPluginPaths: [root] },
      mcpServers: { test_plugin__remote: { headers: { "X-Test": "${HASH_VALUE}" } } },
    });
    definition = loadMcpConfig().mcpServers.test_plugin__remote;
    expect(computeServerHash(definition, { HASH_VALUE: "one" })).not.toBe(computeServerHash(definition, { HASH_VALUE: "two" }));
  });
});
