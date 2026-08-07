import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const agentDir = process.env.PI_CODING_AGENT_DIR;
const configPath = process.env.MCP_CHILD_CONFIG;
const projectDir = process.env.MCP_CHILD_PROJECT_DIR;
const adapterPath = process.env.MCP_CHILD_ADAPTER_PATH;
const probePath = process.env.MCP_CHILD_PROBE_PATH;
if (!agentDir || !configPath || !projectDir || !adapterPath || !probePath) {
  throw new Error("Missing direct-tool child harness environment");
}

process.argv.push("--mcp-config", configPath);
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({
  cwd: projectDir,
  agentDir,
  settingsManager,
  additionalExtensionPaths: [adapterPath, probePath],
});
await loader.reload();
const { session } = await createAgentSession({
  cwd: projectDir,
  agentDir,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(projectDir),
  settingsManager,
  tools: ["demo_reload_identity"],
});
await session.bindExtensions({ mode: "print", onError: error => console.error(error.error) });

try {
  await session.reload();
  await session.extensionRunner.emit({ type: "agent_start" });
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
  session.dispose();
}
