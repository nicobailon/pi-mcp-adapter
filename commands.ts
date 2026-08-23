import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import type { McpExtensionState } from "./state.ts";
import { isServerDisabled, type McpAuthResult, type McpConfig, type McpPanelCallbacks, type McpPanelResult, type ImportKind } from "./types.ts";
import {
  ensureCompatibilityImports,
  getMcpDiscoverySummary,
  getMcpStandardConfigSummary,
  getProjectConfigPath,
  type KnownServerPreset,
  getServerProvenance,
  previewCompatibilityImports,
  previewSharedServerEntry,
  previewStarterProjectConfig,
  writeDirectToolsConfig,
  writeSharedServerEntry,
  writeStarterProjectConfig,
} from "./config.ts";
import { markKeepAliveAfterConnect, notifyToolMetadataUpdated, updateMetadataCache, updateStatusBar, getFailureAgeSeconds, getFailureMessage, clearFailure, recordFailure } from "./init.ts";
import { isServerInActiveFailureBackoff } from "./failure-backoff.ts";
import { loadMetadataCache, reconstructPromptMetadata } from "./metadata-cache.ts";
import { buildToolMetadata } from "./tool-metadata.ts";
import { supportsOAuth, authenticate, removeAuth, type McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { getAuthStorageOptions, inspectAuthForUrl } from "./mcp-auth.ts";
import { inspectBearerTokenForUrl, removeBearerToken } from "./mcp-bearer-store.ts";
import { loadOnboardingState, markSetupCompleted as persistSetupCompleted, markSharedConfigHintShown } from "./onboarding-state.ts";
import { openPath, resolveServerUrl, sanitizeTerminalText } from "./utils.ts";
import { isAbortError } from "./runtime-owner.ts";

function terminalHyperlink(label: string, url: string): string {
  return `\u001B]8;;${sanitizeTerminalText(url)}\u001B\\${sanitizeTerminalText(label)}\u001B]8;;\u001B\\`;
}

/**
 * True when this run mode can display a `ctx.ui.custom()` overlay.
 *
 * `ctx.hasUI` only reports that *some* UI context is bound. In rpc/print mode
 * that context is a headless stub whose `custom()` returns immediately without
 * ever invoking the factory or the `done` callback, so a panel awaited through
 * `new Promise(resolve => ctx.ui.custom(...))` never settles and the command
 * hangs. Overlay panels therefore additionally require `ctx.mode === "tui"`.
 */
function canRenderPanel(ctx: ExtensionContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const lines: string[] = ["MCP Server Status:", ""];

  for (const name of Object.keys(state.config.mcpServers)) {
    const definition = state.config.mcpServers[name];
    if (isServerDisabled(definition)) {
      lines.push(`⊘ ${name}: disabled (run /mcp enable ${name}, then /reload)`);
      continue;
    }
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    let statusIcon = "○";
    let failed = false;

    if (connection?.status === "connected") {
      status = "connected";
      statusIcon = "✓";
    } else if (connection?.status === "needs-auth") {
      status = "needs auth";
      statusIcon = "⚠";
    } else if (failedAgo !== null) {
      const reason = sanitizeTerminalText(getFailureMessage(state, name) ?? "");
      status = reason ? `failed ${failedAgo}s ago — ${reason}` : `failed ${failedAgo}s ago`;
      statusIcon = "✗";
      failed = true;
    } else if (metadata !== undefined) {
      status = "cached";
    }

    const toolSuffix = failed ? "" : ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`;
    lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`);
  }

  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
    lines.push("Run /mcp setup to adopt imports or scaffold a starter .mcp.json");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showPrompts(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  const allPrompts = [...(state.promptMetadata?.values() ?? [])].flat();
  const failedPromptServers = [...(state.manager.getAllConnections?.() ?? [])]
    .filter(([, connection]) => connection.status === "connected" && connection.promptDiscoveryFailed)
    .map(([serverName]) => serverName)
    .sort();
  if (allPrompts.length === 0) {
    const failureNote = failedPromptServers.length > 0
      ? ` Prompt discovery failed for: ${failedPromptServers.join(", ")}.`
      : "";
    ctx.ui.notify(`No MCP prompts available. Prompts are discovered when servers with the \`prompts\` capability connect.${failureNote}`, "info");
    return;
  }
  const lines = ["MCP Prompts:", ""];
  const grouped = new Map<string, typeof allPrompts>();
  for (const prompt of allPrompts) {
    const list = grouped.get(prompt.serverName) ?? [];
    list.push(prompt);
    grouped.set(prompt.serverName, list);
  }
  for (const [serverName, prompts] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${serverName}:`);
    for (const prompt of prompts.sort((a, b) => a.commandName.localeCompare(b.commandName))) {
      const args = prompt.arguments.map(argument => argument.required ? `<${argument.name}>` : `[${argument.name}]`).join(" ");
      lines.push(`  /${prompt.commandName}${args ? ` ${args}` : ""}`);
      if (prompt.description) lines.push(`      ${prompt.description}`);
    }
    lines.push("");
  }
  lines.push(`Total: ${allPrompts.length} prompt${allPrompts.length === 1 ? "" : "s"}`);
  if (failedPromptServers.length > 0) {
    lines.push(`Prompt discovery failed for: ${failedPromptServers.join(", ")}. Cached prompt metadata may be stale.`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const allTools = [...state.toolMetadata.entries()]
    .filter(([serverName]) => !isServerDisabled(state.config.mcpServers[serverName]))
    .filter(([serverName]) => !isServerInActiveFailureBackoff(state, serverName))
    .flatMap(([, metadata]) => metadata.map(m => m.name));

  if (allTools.length === 0) {
    ctx.ui.notify("No MCP tools available", "info");
    return;
  }

  const lines = [
    "MCP Tools:",
    "",
    ...allTools.map(t => `  ${t}`),
    "",
    `Total: ${allTools.length} tools`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function reconnectServer(
  state: McpExtensionState,
  ctx: ExtensionContext,
  name: string,
): Promise<boolean> {
  const definition = state.config.mcpServers[name];
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const signal = state.owner?.signal;
  if (!definition) {
    if (ui) {
      ui.notify(`Server "${name}" not found in config`, "error");
    }
    return false;
  }
  if (isServerDisabled(definition)) {
    if (ui) ui.notify(`MCP: ${name} is disabled. Run /mcp enable ${name}, then /reload.`, "warning");
    return false;
  }

  try {
    await state.manager.close(name);
    state.owner?.throwIfInactive();
    const connection = signal
      ? await state.manager.connect(name, definition, signal)
      : await state.manager.connect(name, definition);
    state.owner?.throwIfInactive();
    if (connection.status === "needs-auth") {
      if (ui) {
        ui.notify(`MCP: ${name} requires OAuth. Run /mcp-auth ${name} first.`, "warning");
      }
      updateStatusBar(state);
      return false;
    }

    const prefix = state.config.settings?.toolPrefix ?? "server";
    const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix, state.config.mcpServers, state.toolMetadata);
    state.toolMetadata.set(name, metadata);
    if (!connection.promptDiscoveryFailed) {
      state.promptMetadata?.set(name, reconstructPromptMetadata(name, connection.prompts ?? [], prefix, definition));
      state.promptMetadataLive?.add(name);
    }
    if (connection.instructions) {
      state.serverInstructions.set(name, connection.instructions);
    } else {
      state.serverInstructions.delete(name);
    }
    updateMetadataCache(state, name);
    const restored = clearFailure(state, name, "command-reconnect");
    if (!restored) notifyToolMetadataUpdated(state, name, "command-reconnect");
    markKeepAliveAfterConnect(state, name);

    if (ui) {
      ui.notify(
        `MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
        "info"
      );
      if (failedTools.length > 0) {
        ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
      }
    }
    updateStatusBar(state);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAbortError(error, signal)) throw error;
    recordFailure(state, name, message);
    if (ui) {
      ui.notify(`MCP: Failed to reconnect to ${name}: ${sanitizeTerminalText(message)}`, "error");
    }
    updateStatusBar(state);
    return false;
  }
}

export async function reconnectServers(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer?: string
): Promise<void> {
  if (targetServer && !state.config.mcpServers[targetServer]) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    }
    return;
  }

  const names = targetServer ? [targetServer] : Object.keys(state.config.mcpServers);
  for (const name of names) {
    await reconnectServer(state, ctx, name);
  }

  updateStatusBar(state);
}

export async function authenticateServer(
  serverName: string,
  config: McpConfig,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  runtime?: McpOAuthRuntime,
): Promise<McpAuthResult> {
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const cwd = ctx.cwd;
  signal ??= ctx.signal;
  if (!ui) return { ok: false, message: "OAuth authentication requires an interactive session." };

  const definition = config.mcpServers[serverName];
  if (!definition) {
    const message = `Server "${serverName}" not found in config`;
    ui.notify(message, "error");
    return { ok: false, message };
  }
  if (isServerDisabled(definition)) {
    const message = `Server "${serverName}" is disabled. Run /mcp enable ${serverName}, then /reload.`;
    ui.notify(message, "warning");
    return { ok: false, message };
  }

  if (!supportsOAuth(definition)) {
    const message = `Server "${serverName}" does not use OAuth authentication. Set "auth": "oauth" or omit auth for auto-detection.`;
    ui.notify(
      `Server "${serverName}" does not use OAuth authentication.\n` +
      `Set "auth": "oauth" or omit auth for auto-detection.`,
      "error"
    );
    return { ok: false, message };
  }

  try {
    const serverUrl = resolveServerUrl(definition);
    if (!serverUrl) {
      const message = `Server "${serverName}" has no URL configured (OAuth requires HTTP transport)`;
      ui.notify(message, "error");
      return { ok: false, message };
    }

    ui.setStatus("mcp-auth", `Authenticating ${serverName}...`);
    const authStorageOptions = getAuthStorageOptions(config.settings?.oauthDir, cwd);
    const status = await authenticate(serverName, serverUrl, definition, {
      ...(authStorageOptions.baseDir ? { authStorageOptions } : {}),
      onAuthorizationUrl: () => {},
      onAuthorizationInput: async (authorizationUrl, inputSignal) => {
        if (inputSignal.aborted) return undefined;
        return ui.input(
          `Complete ${serverName} OAuth\n\n` +
            `${terminalHyperlink("Open authorization page", authorizationUrl)}\n${authorizationUrl}\n\n` +
            "Approve access, then paste the full localhost callback URL below.",
          undefined,
          { signal: inputSignal },
        );
      },
      ...(signal ? { signal } : {}),
      ...(runtime ? { runtime } : {}),
    });
    if (signal?.aborted) signal.throwIfAborted();

    if (status === "authenticated") {
      const message = `OAuth authentication successful for "${serverName}".`;
      ui.notify(message, "info");
      return { ok: true, message };
    }

    const message = `OAuth authentication failed for "${serverName}".`;
    ui.notify(message, "error");
    return { ok: false, message };
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    ui.notify(`Failed to authenticate "${serverName}": ${message}`, "error");
    return { ok: false, message };
  } finally {
    if (!signal?.aborted) ui.setStatus("mcp-auth", undefined);
  }
}

export async function logoutServer(
  serverName: string,
  state: McpExtensionState,
  ctx: ExtensionContext
): Promise<{ ok: boolean; message: string }> {
  const definition = state.config.mcpServers[serverName];
  const ui = ctx.hasUI ? ctx.ui : undefined;
  if (!definition) {
    const message = `Server "${serverName}" not found in config`;
    if (ui) ui.notify(message, "error");
    return { ok: false, message };
  }

  const signal = state.owner?.signal;
  try {
    await removeAuth(serverName, { authStorageOptions: state.authStorageOptions, signal, runtime: state.oauthRuntime });
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (ui) {
      ui.notify(`Failed to clear OAuth credentials for "${serverName}": ${sanitizeTerminalText(message)}`, "error");
    }
    return { ok: false, message };
  }

  state.owner?.throwIfInactive();
  try {
    await state.manager.close(serverName);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (ui) {
      ui.notify(
        `OAuth credentials were cleared for "${serverName}", but its connection could not be closed: ${sanitizeTerminalText(message)}`,
        "error",
      );
    }
    return { ok: false, message };
  }

  state.owner?.throwIfInactive();
  updateStatusBar(state);

  const message = `OAuth credentials cleared for "${serverName}". Run /mcp-auth ${serverName} to authenticate again.`;
  if (ui) ui.notify(message, "info");
  return { ok: true, message };
}

function validateBearerTokenStoreServer(
  serverName: string,
  state: McpExtensionState,
): { ok: true; serverUrl: string } | { ok: false; message: string; type: "error" | "warning" } {
  const safeName = sanitizeTerminalText(serverName);
  const definition = state.config.mcpServers[serverName];
  if (!definition) return { ok: false, message: `Server "${safeName}" not found in config`, type: "error" };
  if (isServerDisabled(definition)) return { ok: false, message: `Server "${safeName}" is disabled. Run /mcp enable ${safeName}, then /reload.`, type: "warning" };
  if (definition.auth !== "bearer" || definition.bearerTokenStore !== true) {
    return { ok: false, message: `Server "${safeName}" is not configured for bearerTokenStore.`, type: "error" };
  }
  // resolveServerUrl embeds the interpolated URL in its exceptions; redact it
  // because the URL can carry userinfo or interpolated secrets.
  let serverUrl: string | undefined;
  try {
    serverUrl = resolveServerUrl(definition);
  } catch {
    return { ok: false, message: `Server "${safeName}" has an invalid or unresolvable URL.`, type: "error" };
  }
  if (!serverUrl) return { ok: false, message: `Server "${safeName}" has no URL configured.`, type: "error" };
  return { ok: true, serverUrl };
}

export async function manageBearerToken(
  action: "set" | "remove" | "status",
  serverName: string,
  state: McpExtensionState,
  ctx: ExtensionContext,
): Promise<{ ok: boolean; message: string }> {
  const ui = ctx.hasUI ? ctx.ui : undefined;
  const safeName = sanitizeTerminalText(serverName);
  const validation = validateBearerTokenStoreServer(serverName, state);
  if (!validation.ok) {
    if (ui) ui.notify(validation.message, validation.type);
    return { ok: false, message: validation.message };
  }

  if (action === "set") {
    const message = `Cannot store bearer token here: Pi extension UI has no masked secret input primitive. Run \`pi-mcp-adapter token set ${safeName}\` in a terminal; it reads the token from stdin only.`;
    if (ui) ui.notify(message, "error");
    return { ok: false, message };
  }

  if (action === "status") {
    const status = inspectBearerTokenForUrl(serverName, validation.serverUrl);
    const message = status.status === "present"
      ? `Bearer token is stored for "${safeName}".`
      : status.status === "url-mismatch"
        ? `Bearer token is stored for "${safeName}", but its URL does not match the current server URL.`
        : status.status === "unavailable"
          ? status.message
          : `No bearer token is stored for "${safeName}".`;
    if (ui) ui.notify(message, status.status === "unavailable" ? "error" : "info");
    return { ok: status.status !== "unavailable", message };
  }

  try {
    removeBearerToken(serverName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ui) ui.notify(`Failed to remove bearer token for "${safeName}": ${sanitizeTerminalText(message)}`, "error");
    return { ok: false, message };
  }

  const message = `Bearer token removed for "${safeName}".`;
  if (ui) ui.notify(message, "info");
  return { ok: true, message };
}

export interface PanelFlowResult {
  configChanged: boolean;
}

function buildSharedConfigNoticeLines(configOverridePath: string | undefined, cwd: string): { lines: string[]; fingerprint: string | null } {
  const discovery = getMcpStandardConfigSummary(configOverridePath, cwd);
  const onboardingState = loadOnboardingState();
  if (!discovery.hasSharedServers || onboardingState.sharedConfigHintShown) {
    return { lines: [], fingerprint: null };
  }

  const sharedSources = discovery.sources.filter((source) => source.kind === "shared" && source.serverCount > 0);
  const sourceList = sharedSources.map((source) => source.path).join(", ");
  return {
    lines: [
      `Using standard MCP config from ${sourceList}.`,
      "Pi only writes compatibility imports and adapter-specific overrides into Pi-owned files when needed.",
    ],
    fingerprint: discovery.fingerprint,
  };
}

export async function openMcpSetup(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
  mode: "empty" | "setup" = "setup",
  options: { includeHostConfigs?: boolean } = {},
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };
  if (!canRenderPanel(ctx)) {
    ctx.ui.notify(`The interactive MCP setup panel is only available in the terminal UI (current mode: ${ctx.mode}). Edit .mcp.json directly, or run /mcp status to review servers.`, "info");
    return { configChanged: false };
  }
  if (state.programmaticConfig) {
    ctx.ui.notify("MCP setup is unavailable when config is supplied by createMcpAdapter().", "info");
    return { configChanged: false };
  }

  const discovery = getMcpDiscoverySummary(configOverridePath, ctx.cwd, options);
  const onboardingState = loadOnboardingState();
  const { createMcpSetupPanel } = await import("./mcp-setup-panel.ts");
  let configChanged = false;

  const callbacks = {
    previewImports: (imports: ImportKind[]) => previewCompatibilityImports(imports, configOverridePath),
    previewStarterProject: () => previewStarterProjectConfig(ctx.cwd),
    previewRepoPrompt: () => {
      const repoPrompt = getMcpDiscoverySummary(configOverridePath, ctx.cwd, options).repoPrompt;
      if (!repoPrompt.entry || !repoPrompt.targetPath || !repoPrompt.serverName) return null;
      return previewSharedServerEntry(repoPrompt.targetPath, repoPrompt.serverName, repoPrompt.entry);
    },
    previewKnownServer: (preset: KnownServerPreset) => previewSharedServerEntry(getProjectConfigPath(ctx.cwd), preset.id, preset.entry),
    adoptImports: async (imports: ImportKind[]) => {
      const result = ensureCompatibilityImports(imports, configOverridePath);
      if (result.added.length > 0) configChanged = true;
      return result;
    },
    scaffoldProjectConfig: async () => {
      const path = writeStarterProjectConfig(ctx.cwd);
      configChanged = true;
      return { path };
    },
    addRepoPrompt: async () => {
      const repoPrompt = getMcpDiscoverySummary(configOverridePath, ctx.cwd, options).repoPrompt;
      if (!repoPrompt.entry || !repoPrompt.targetPath || !repoPrompt.serverName) {
        throw new Error("RepoPrompt is not available to add from this setup screen.");
      }
      const path = writeSharedServerEntry(repoPrompt.targetPath, repoPrompt.serverName, repoPrompt.entry);
      configChanged = true;
      return { path, serverName: repoPrompt.serverName };
    },
    addKnownServer: async (preset: KnownServerPreset) => {
      const path = writeSharedServerEntry(getProjectConfigPath(ctx.cwd), preset.id, preset.entry);
      configChanged = true;
      return { path, serverName: preset.name };
    },
    openPath: async (targetPath: string) => {
      await openPath(pi, targetPath);
    },
    markSetupCompleted: () => {
      persistSetupCompleted(discovery.fingerprint);
    },
  };

  return new Promise<PanelFlowResult>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, keybindings, done) => {
        return createMcpSetupPanel(discovery, callbacks, { mode, onboardingState, keybindings }, tui, () => {
          done(undefined);
          resolve({ configChanged });
        });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: 92 } },
    );
  });
}

function buildMcpPanelCallbacks(
  state: McpExtensionState,
  config: McpConfig,
  ctx: ExtensionContext,
  getOverlayHandle?: () => OverlayHandle | undefined,
): McpPanelCallbacks {
  // Panel-only diagnostics keep status inspection from mutating connection
  // failure state while allowing the existing panel failure UI to show why the
  // credential store could not be inspected.
  const authStatusFailures = new Map<string, string>();

  return {
    reconnect: (serverName: string) => reconnectServer(state, ctx, serverName),
    canAuthenticate: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      return definition ? !isServerDisabled(definition) && supportsOAuth(definition) : false;
    },
    authenticate: async (serverName: string) => {
      const overlay = getOverlayHandle?.();
      overlay?.setHidden(true);
      try {
        return await authenticateServer(serverName, config, ctx, state.owner?.signal, state.oauthRuntime);
      } finally {
        overlay?.setHidden(false);
        overlay?.focus();
      }
    },
    getConnectionStatus: (serverName: string) => {
      authStatusFailures.delete(serverName);
      const definition = config.mcpServers[serverName];
      if (isServerDisabled(definition)) return "disabled";
      const connection = state.manager.getConnection(serverName);
      let serverUrl: string | undefined;
      try {
        serverUrl = definition ? resolveServerUrl(definition) : undefined;
      } catch {
        return "failed";
      }
      if (
        definition?.auth === "oauth"
        && serverUrl
        && definition.oauth !== false
        && definition.oauth?.grantType !== "client_credentials"
      ) {
        const authStatus = inspectAuthForUrl(serverName, serverUrl, state.authStorageOptions);
        if (authStatus.status === "unavailable") {
          authStatusFailures.set(serverName, authStatus.message);
          return "failed";
        }
        if (authStatus.status === "absent" || !authStatus.entry.tokens) {
          return "needs-auth";
        }
      }
      if (connection?.status === "needs-auth") return "needs-auth";
      if (connection?.status === "connected") return "connected";
      if (getFailureAgeSeconds(state, serverName) !== null) return "failed";
      return "idle";
    },
    getFailureMessage: (serverName: string) => authStatusFailures.get(serverName) ?? getFailureMessage(state, serverName),
    refreshCacheAfterReconnect: (serverName: string) => {
      const freshCache = loadMetadataCache();
      return freshCache?.servers?.[serverName] ?? null;
    },
  };
}

export async function openMcpPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
  onDirectToolsConfigChanged?: (changes: Map<string, true | string[] | false>) => void | Promise<void>,
): Promise<PanelFlowResult> {
  if (state.programmaticConfig) {
    if (ctx.hasUI) {
      ctx.ui.notify("MCP status is shown from the in-memory SDK config; configuration discovery is unavailable.", "info");
      await showStatus(state, ctx);
    }
    return { configChanged: false };
  }
  if (!canRenderPanel(ctx)) {
    // No overlay here, but the same information is available as text.
    await showStatus(state, ctx);
    return { configChanged: false };
  }
  if (Object.keys(state.config.mcpServers).length === 0) {
    return openMcpSetup(state, pi, ctx, configOverridePath, "empty", { includeHostConfigs: false });
  }

  const config = state.config;
  const cache = loadMetadataCache();
  const configPath = pi.getFlag("mcp-config") as string | undefined ?? configOverridePath;
  const provenanceMap = getServerProvenance(configPath, ctx.cwd);
  const { lines: noticeLines, fingerprint } = buildSharedConfigNoticeLines(configPath, ctx.cwd);

  let overlayHandle: OverlayHandle | undefined;
  const callbacks = buildMcpPanelCallbacks(state, config, ctx, () => overlayHandle);

  const { createMcpPanel } = await import("./mcp-panel.ts");
  let configChanged = false;

  await new Promise<void>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, keybindings, done) => {
        return createMcpPanel(config, cache, provenanceMap, callbacks, tui, (result: McpPanelResult) => {
          void (async () => {
            if (!result.cancelled && result.changes.size > 0) {
              writeDirectToolsConfig(result.changes, provenanceMap, config);
              await onDirectToolsConfigChanged?.(result.changes);
              ctx.ui.notify("Direct tools updated for this session.", "info");
            }
            done(undefined);
            resolve();
          })().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(`Direct tools updated, but live refresh failed: ${message}`, "error");
            configChanged = true;
            done(undefined);
            resolve();
          });
        }, { noticeLines, keybindings });
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: 82 },
        onHandle: (handle) => { overlayHandle = handle; },
      },
    );
  });

  if (noticeLines.length > 0 && fingerprint) {
    markSharedConfigHintShown(fingerprint);
  }

  return { configChanged };
}

export async function openMcpAuthPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };
  if (!canRenderPanel(ctx)) {
    ctx.ui.notify(`The interactive MCP auth panel is only available in the terminal UI (current mode: ${ctx.mode}). Use /mcp-auth <server> to authenticate a specific server.`, "info");
    return { configChanged: false };
  }
  if (state.programmaticConfig) {
    ctx.ui.notify("Use /mcp-auth <server> to authenticate a server from the in-memory SDK config.", "info");
    return { configChanged: false };
  }

  const config = state.config;
  const oauthServers = Object.entries(config.mcpServers).filter(
    ([, definition]) => !isServerDisabled(definition) && supportsOAuth(definition),
  );
  if (oauthServers.length === 0) {
    ctx.ui.notify("No OAuth-capable MCP servers are configured.", "warning");
    return { configChanged: false };
  }

  const cache = loadMetadataCache();
  const configPath = pi.getFlag("mcp-config") as string | undefined ?? configOverridePath;
  const provenanceMap = getServerProvenance(configPath, ctx.cwd);
  let overlayHandle: OverlayHandle | undefined;
  const callbacks = buildMcpPanelCallbacks(state, config, ctx, () => overlayHandle);
  const { createMcpPanel } = await import("./mcp-panel.ts");

  await new Promise<void>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, keybindings, done) => {
        return createMcpPanel(config, cache, provenanceMap, callbacks, tui, () => {
          done(undefined);
          resolve();
        }, {
          authOnly: true,
          keybindings,
          noticeLines: ["Select an OAuth MCP server and press Enter or ctrl+a to authenticate."],
        });
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: 82 },
        onHandle: (handle) => { overlayHandle = handle; },
      },
    );
  });

  return { configChanged: false };
}
