import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("direct tools in child Pi processes", () => {
  it.each(["env", "config"])("registers and invokes a cold-cache tool selected by %s", async selection => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-direct-tool-child-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(projectDir)]);
    const configPath = join(agentDir, "mcp.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        demo: {
          command: process.execPath,
          args: [resolve("__tests__/fixtures/delayed-mcp-server.mjs")],
          ...(selection === "config" ? { directTools: true } : {}),
        },
      },
    }));

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", resolve("__tests__/fixtures/direct-tools-child-harness.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          MCP_CHILD_CONFIG: configPath,
          MCP_CHILD_PROJECT_DIR: projectDir,
          MCP_CHILD_ADAPTER_PATH: resolve("index.ts"),
          MCP_CHILD_PROBE_PATH: resolve("__tests__/fixtures/direct-tools-agent-start-probe.ts"),
          MCP_CHILD_INVOKE_TOOL: "demo_reload_identity",
          MCP_CHILD_INPUT: selection === "config" ? "Call the demo tool." : undefined,
          MCP_DIRECT_TOOLS: selection === "env" ? "demo/reload_identity" : undefined,
        },
        timeout: 15_000,
      },
    );

    expect(stderr).not.toContain("MCP initialization failed");
    const toolsLine = stdout.split("\n").find(line => line.startsWith("DIRECT_TOOLS_AT_AGENT_START="));
    expect(toolsLine).toBeDefined();
    expect(JSON.parse(toolsLine!.slice("DIRECT_TOOLS_AT_AGENT_START=".length))).toContain("demo_reload_identity");
    const resultLine = stdout.split("\n").find(line => line.startsWith("DIRECT_TOOL_RESULT="));
    expect(resultLine, stderr).toBeDefined();
    expect(JSON.parse(resultLine!.slice("DIRECT_TOOL_RESULT=".length))).toEqual([
      { type: "text", text: "fixture evidence visible to the model" },
    ]);
  }, 20_000);
});
