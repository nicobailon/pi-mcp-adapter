import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentPath } from "./agent-dir.ts";
import type { LoadedMcpConfig } from "./config.ts";
import type { McpConfig, ProjectServerBlock, ProjectServerBlockReason, ServerDefinition } from "./types.ts";

const APPROVALS_VERSION = 1;
const APPROVALS_FILE = "mcp-project-approvals.json";
const MCP_CONFIG_SOURCE_METADATA = Symbol.for("pi-mcp-adapter/config-source-metadata");

interface ApprovalRecord {
  projectRoot: string;
  serverName: string;
  definitionHash: string;
  approvedAt: string;
}

interface ApprovalStore {
  version: 1;
  approvals: ApprovalRecord[];
}

export interface ProjectTrustResult {
  config: McpConfig;
  blockedServers: Map<string, ProjectServerBlock>;
}

export function describeProjectServerBlock(reason: ProjectServerBlockReason): string {
  switch (reason) {
    case "untrusted":
      return "blocked by project trust — trust the project to review and approve this server";
    case "approval-required":
      return "blocked: project server approval required — approve it in a trusted interactive session or set user-global settings.projectServers to \"allow\"";
    case "denied":
      return "blocked: project server approval denied — reload in a trusted interactive session to approve it";
  }
}

/** Why a disabled server is unavailable: its project-trust block, or the manual disable. */
export function disabledServerReason(blocked: ReadonlyMap<string, ProjectServerBlock> | undefined, name: string): string {
  const block = blocked?.get(name);
  return block ? describeProjectServerBlock(block.reason) : `disabled. Run /mcp-adapter enable ${name} and /reload to enable it.`;
}

type ConfigWithSourceMetadata = McpConfig & {
  [MCP_CONFIG_SOURCE_METADATA]?: Pick<LoadedMcpConfig, "projectServers" | "projectServerPolicy">;
};

function asLoadedConfig(config: McpConfig): LoadedMcpConfig {
  const metadata = (config as ConfigWithSourceMetadata)[MCP_CONFIG_SOURCE_METADATA];
  return {
    config,
    projectServers: metadata?.projectServers ?? new Map(),
    projectServerPolicy: metadata?.projectServerPolicy ?? "ask",
  };
}

export function hasProjectServerDefinitions(config: McpConfig): boolean {
  return asLoadedConfig(config).projectServers.size > 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
}

export function hashProjectServerDefinition(definition: ServerDefinition): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(definition))).digest("hex");
}

export function canonicalProjectRoot(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

function approvalPath(): string {
  return getAgentPath(APPROVALS_FILE);
}

function loadApprovals(): ApprovalStore {
  const path = approvalPath();
  if (!existsSync(path)) return { version: APPROVALS_VERSION, approvals: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ApprovalStore>;
    if (parsed.version !== APPROVALS_VERSION || !Array.isArray(parsed.approvals)) throw new Error("invalid format");
    const approvals = parsed.approvals.filter((entry): entry is ApprovalRecord =>
      !!entry && typeof entry.projectRoot === "string" && typeof entry.serverName === "string"
      && typeof entry.definitionHash === "string" && typeof entry.approvedAt === "string");
    return { version: APPROVALS_VERSION, approvals };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`MCP: ignoring invalid project-server approval store ${path}: ${detail}`);
    return { version: APPROVALS_VERSION, approvals: [] };
  }
}

function saveApproval(record: ApprovalRecord): void {
  const path = approvalPath();
  const store = loadApprovals();
  store.approvals = store.approvals.filter(entry =>
    entry.projectRoot !== record.projectRoot || entry.serverName !== record.serverName);
  store.approvals.push(record);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function approveProjectServer(cwd: string, serverName: string, definition: ServerDefinition): void {
  saveApproval({
    projectRoot: canonicalProjectRoot(cwd),
    serverName,
    definitionHash: hashProjectServerDefinition(definition),
    approvedAt: new Date().toISOString(),
  });
}

function describeServer(definition: ServerDefinition): string {
  if (definition.command) {
    return [definition.command, ...(definition.args ?? [])].map(value => JSON.stringify(value)).join(" ");
  }
  if (definition.url) return definition.url;
  if (definition.socket) return definition.socket;
  return "(no command or endpoint)";
}

function block(config: McpConfig, name: string): void {
  const definition = config.mcpServers[name];
  if (definition) config.mcpServers[name] = { ...definition, disabled: true };
}

export async function applyProjectServerTrust(
  loaded: LoadedMcpConfig,
  ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui" | "isProjectTrusted">,
): Promise<ProjectTrustResult> {
  const config: McpConfig = { ...loaded.config, mcpServers: { ...loaded.config.mcpServers } };
  const blockedServers = new Map<string, ProjectServerBlock>();
  if (loaded.projectServers.size === 0) return { config, blockedServers };

  let projectTrusted = false;
  try {
    projectTrusted = ctx.isProjectTrusted();
  } catch {
    projectTrusted = false;
  }
  const projectRoot = canonicalProjectRoot(ctx.cwd);
  const approvals = loadApprovals();

  for (const [name, source] of loaded.projectServers) {
    const definition = config.mcpServers[name];
    if (!definition) continue;
    const definitionHash = hashProjectServerDefinition(definition);
    const approved = approvals.approvals.some(entry =>
      entry.projectRoot === projectRoot && entry.serverName === name && entry.definitionHash === definitionHash);
    if (projectTrusted && (approved || (!ctx.hasUI && loaded.projectServerPolicy === "allow"))) continue;

    if (!projectTrusted) {
      const reason = "untrusted" as const;
      block(config, name);
      blockedServers.set(name, { reason, source });
      continue;
    }

    if (!ctx.hasUI) {
      const reason = "approval-required" as const;
      block(config, name);
      blockedServers.set(name, { reason, source });
      continue;
    }

    const allowed = await ctx.ui.confirm(
      `Allow project MCP server “${name}”?`,
      `Source: ${source.path}\nEndpoint: ${describeServer(definition)}\n\nThis server can run local commands or make network requests with your user permissions.`,
    );
    if (!allowed) {
      const reason = "denied" as const;
      block(config, name);
      blockedServers.set(name, { reason, source });
      continue;
    }
    approveProjectServer(projectRoot, name, definition);
  }

  return { config, blockedServers };
}

export function applyProjectServerTrustToConfig(
  config: McpConfig,
  ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "ui" | "isProjectTrusted">,
): Promise<ProjectTrustResult> {
  return applyProjectServerTrust(asLoadedConfig(config), ctx);
}

/** Remove project-derived servers before an ExtensionContext exists. */
export function excludeProjectServersAtLoadTime(loadedOrConfig: LoadedMcpConfig | McpConfig): McpConfig {
  const loaded = "config" in loadedOrConfig && "projectServers" in loadedOrConfig
    ? loadedOrConfig as LoadedMcpConfig
    : asLoadedConfig(loadedOrConfig as McpConfig);
  const config: McpConfig = { ...loaded.config, mcpServers: { ...loaded.config.mcpServers } };
  for (const name of loaded.projectServers.keys()) delete config.mcpServers[name];
  return config;
}
