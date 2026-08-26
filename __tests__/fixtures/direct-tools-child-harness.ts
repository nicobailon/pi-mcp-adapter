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
  // Normal prompts emit input before agent_start, allowing config-selected
  // tools to finish loading. The env-only case still checks session startup.
  if (process.env.MCP_CHILD_INPUT) {
    await session.extensionRunner.emitInput(process.env.MCP_CHILD_INPUT, undefined, "interactive");
  }
  await session.extensionRunner.emit({ type: "agent_start" });
  const invoke = process.env.MCP_CHILD_INVOKE_TOOL;
  if (invoke) {
    const tool = session.getToolDefinition(invoke);
    if (!tool) throw new Error(`Direct tool was not registered with the agent: ${invoke}`);
    const result = await tool.execute("direct-tool-call", {}, undefined, undefined, session.extensionRunner.createContext());
    console.log(`DIRECT_TOOL_RESULT=${JSON.stringify(result.content)}`);
  }
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "test" });
  session.dispose();
}
