import { Check, Errors } from "typebox/value";
import type { DirectToolSpec, McpConfig, ServerCacheEntry, ServerEntry, ToolPrefix, ToolSelectorCandidateIndex } from "./types.ts";
import { createToolSelectorCandidateIndex, EXECUTOR_APP_TOOL_CAP, formatToolName, getToolNameCandidates, isServerDisabled, isToolAllowed, resolveToolPrefix, resolveUniqueNameOwnership } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { isExecutorOwnTool, isServerCacheValid, isUsableCachedAppTool, parseDirectToolSelectors } from "./metadata-cache.ts";
export { getMissingConfiguredDirectToolServers } from "./metadata-cache.ts";
import { isUiToolVisibleToModel } from "./ui-tool-visibility.ts";
import { resourceNameToToolName } from "./resource-tools.ts";

const BUILTIN_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "mcp"]);
export const DIRECT_TOOLS_ADVISORY_THRESHOLD = 75;

export function getLargeDirectToolsAdvisory(config: McpConfig, specs: readonly DirectToolSpec[]): string | undefined {
  if (config.settings?.warnOnLargeDirectTools === false) return undefined;
  const eagerCount = specs.filter((spec) => !spec.lazy).length;
  if (eagerCount < DIRECT_TOOLS_ADVISORY_THRESHOLD) return undefined;
  return `MCP: ${eagerCount} direct tools resolved. Each direct tool adds prompt context; the direct tools guide in docs/tools.md recommends targeted sets of 5-20 tools and using the proxy or an explicit string[] when 75+ direct tools would be registered. Set settings.warnOnLargeDirectTools to false to hide this advisory.`;
}

/**
 * Recover one model-emitted JSON layer for schema-declared object and array
 * properties, then validate the complete input against the same schema.
 */
export function prepareDirectToolArguments(inputSchema: unknown, args: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return args;
  const schema = inputSchema as Record<string, unknown>;
  if (schema.type !== "object") return args;
  const input = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : null;
  const properties = schema.properties;
  let prepared: Record<string, unknown> | undefined;

  if (input && properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(input, name) || typeof input[name] !== "string"
        || !propertySchema || typeof propertySchema !== "object" || Array.isArray(propertySchema)) continue;
      // A valid string may be intentional (for example, string | object).
      // Only recover JSON when the advertised property rejects the raw value.
      if (Check(propertySchema as never, input[name])) continue;
      try {
        const parsed: unknown = JSON.parse(input[name] as string);
        const isContainer = Array.isArray(parsed)
          || (parsed !== null && typeof parsed === "object");
        if (isContainer && Check(propertySchema as never, parsed)) {
          prepared ??= { ...input };
          prepared[name] = parsed;
        }
      } catch {
        // Validation below reports malformed or shape-incompatible values.
      }
    }
  }

  const candidate = prepared ?? args;
  if (!Check(inputSchema as never, candidate)) {
    const errors = Errors(inputSchema as never, candidate);
    const issues = errors.slice(0, 8).map((error) => ({
      instancePath: error.instancePath || "/",
      keyword: error.keyword,
      message: error.message,
    }));
    throw new TypeError(`MCP direct tool arguments do not match the advertised input schema: ${JSON.stringify({
      issues,
      total: errors.length,
      truncated: errors.length > issues.length,
    })}`);
  }
  return candidate;
}

function createSelectorCandidateIndex(config: McpConfig, cache: MetadataCache, prefix: ToolPrefix): ToolSelectorCandidateIndex {
  const candidates = new Set<string>();
  for (const [otherServerName, otherDefinition] of Object.entries(config.mcpServers)) {
    const otherCache = cache.servers[otherServerName];
    if (!otherCache || !isServerCacheValid(otherCache, otherDefinition) || isServerDisabled(otherDefinition)) continue;
    const otherPrefix = resolveToolPrefix(otherDefinition, prefix);
    for (const otherTool of otherCache.tools ?? []) {
      if (!isUiToolVisibleToModel(otherTool.uiVisibility)) continue;
      for (const candidate of getToolNameCandidates(otherTool.name, otherServerName, otherPrefix, false)) candidates.add(candidate);
    }
    if (otherDefinition.exposeResources !== false) {
      for (const resource of otherCache.resources ?? []) {
        const baseName = `read_${resourceNameToToolName(resource.name)}`;
        for (const candidate of getToolNameCandidates(baseName, otherServerName, otherPrefix, false)) candidates.add(candidate);
      }
    }
    for (const tool of (otherCache.executorApps?.tools ?? []).slice(0, EXECUTOR_APP_TOOL_CAP)) {
      if (!isUsableCachedAppTool(tool) || isExecutorOwnTool(tool)) continue;
      for (const candidate of getToolNameCandidates(tool.canonicalPath, otherServerName, otherPrefix, false)) candidates.add(candidate);
    }
  }
  return createToolSelectorCandidateIndex(candidates);
}

/** Builds the cross-server includeTools/excludeTools candidate index once, and only for a server that has filters. */
export function createServerSelectorIndexResolver(config: McpConfig, cache: MetadataCache, prefix: ToolPrefix): (definition: ServerEntry) => ToolSelectorCandidateIndex | undefined {
  let index: ToolSelectorCandidateIndex | undefined;
  return (definition) => {
    const hasToolFilters =
      (Array.isArray(definition.includeTools) && definition.includeTools.length > 0) ||
      (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0);
    if (!hasToolFilters) return undefined;
    index ??= createSelectorCandidateIndex(config, cache, prefix);
    return index;
  };
}

/**
 * The model-visible tools and resource tools of one enabled server with valid
 * cached metadata, after `selection` and includeTools/excludeTools. App-only UI
 * tools never qualify.
 */
export function resolveServerToolSpecs(
  serverName: string,
  definition: ServerEntry,
  serverCache: ServerCacheEntry,
  prefix: ToolPrefix,
  selection: true | string[],
  selectorIndex: ToolSelectorCandidateIndex | undefined,
  lazy = false,
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  for (const tool of serverCache.tools ?? []) {
    if (!isUiToolVisibleToModel(tool.uiVisibility)) continue;
    if (selection !== true && !selection.includes(tool.name)) continue;
    if (!isToolAllowed(tool.name, serverName, prefix, definition.includeTools, definition.excludeTools, selectorIndex)) continue;
    specs.push({
      ...(lazy ? { lazy: true } : {}),
      serverName,
      originalName: tool.name,
      prefixedName: formatToolName(tool.name, serverName, prefix),
      description: tool.description ?? "",
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.uiResourceUri !== undefined ? { uiResourceUri: tool.uiResourceUri } : {}),
      ...(tool.uiStreamMode !== undefined ? { uiStreamMode: tool.uiStreamMode } : {}),
    });
  }

  if (definition.exposeResources !== false) {
    for (const resource of serverCache.resources ?? []) {
      const baseName = `read_${resourceNameToToolName(resource.name)}`;
      if (selection !== true && !selection.includes(baseName)) continue;
      if (!isToolAllowed(baseName, serverName, prefix, definition.includeTools, definition.excludeTools, selectorIndex)) continue;
      specs.push({
        ...(lazy ? { lazy: true } : {}),
        serverName,
        originalName: baseName,
        prefixedName: formatToolName(baseName, serverName, prefix),
        description: resource.description ?? `Read resource: ${resource.uri}`,
        resourceUri: resource.uri,
      });
    }
  }
  return specs;
}

export function resolveDirectTools(
  config: McpConfig,
  cache: MetadataCache | null,
  prefix: ToolPrefix,
  envOverride?: string[],
  unavailableServers: ReadonlySet<string> = new Set(),
  reservedNames?: Set<string>,
): DirectToolSpec[] {
  const specs: DirectToolSpec[] = [];
  if (!cache) return specs;

  const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;
  const globalDirect = config.settings?.directTools;
  const selectorIndexFor = createServerSelectorIndexResolver(config, cache, prefix);

  for (const [serverName, definition] of Object.entries(config.mcpServers)) {
    if (isServerDisabled(definition)) continue;
    const serverCache = cache.servers[serverName];
    if (!serverCache || !isServerCacheValid(serverCache, definition)) continue;

    let toolFilter: true | string[] | false = false;
    let lazy = false;

    if (envSelection) {
      if (envSelection.servers.has(serverName)) {
        toolFilter = true;
      } else if (envSelection.tools.has(serverName)) {
        toolFilter = [...envSelection.tools.get(serverName)!];
      }
    } else {
      const selected = definition.directTools !== undefined ? definition.directTools : globalDirect;
      if (selected === "search") {
        // Real tools with real schemas, but registered inactive; the model
        // reaches them through mcp({ search }), which activates the matches.
        toolFilter = true;
        lazy = true;
      } else if (selected !== undefined) {
        toolFilter = selected;
      }
    }

    if (!toolFilter) continue;

    const effectivePrefix = resolveToolPrefix(definition, prefix);
    for (const spec of resolveServerToolSpecs(serverName, definition, serverCache, effectivePrefix, toolFilter, selectorIndexFor(definition), lazy)) {
      if (BUILTIN_NAMES.has(spec.prefixedName)) {
        console.warn(`MCP: skipping direct ${spec.resourceUri !== undefined ? "resource " : ""}tool "${spec.prefixedName}" (collides with builtin)`);
        continue;
      }
      specs.push(spec);
    }
  }

  const ownership = resolveUniqueNameOwnership(specs, (spec) => spec.prefixedName);
  for (const [name, colliding] of ownership.collisions) {
    console.warn(`MCP: skipping colliding direct name "${name}" from ${colliding.map((spec) => `"${spec.serverName}"`).join(", ")}`);
  }
  const uniqueSpecs = ownership.unique;
  for (const spec of uniqueSpecs) reservedNames?.add(spec.prefixedName);

  const emittedSpecs = unavailableServers.size === 0
    ? uniqueSpecs
    : uniqueSpecs.filter((spec) => !unavailableServers.has(spec.serverName));

  return emittedSpecs;
}

/**
 * Pure function of config: the description must stay byte-stable across
 * runtime metadata changes (tool counts, instructions, connection state) so
 * re-registering the proxy tool never rewrites the cached prompt prefix.
 * Live counts/status belong to `mcp({ })`, full instructions to
 * `mcp({ instructions })`.
 */
export function buildProxyDescription(config: McpConfig): string {
  let desc = "MCP gateway — URL installation, server status, tool search/describe, auth, and single MCP tool calls. When a user supplies an MCP endpoint URL, install it with the install action. Non-MCP Pi tools should be called directly, not through mcp.\n";

  const serverNames = Object.keys(config.mcpServers)
    .filter((serverName) => !isServerDisabled(config.mcpServers[serverName]));
  if (serverNames.length > 0) {
    desc += `\nServers: ${serverNames.join(", ")}\n`;
  }

  // Search-mode tools are real tools held inactive. Say how they wake up, or
  // the model reads mcp({ tool }) as the only way in and never gets a schema.
  const searchModeServers = serverNames.filter((serverName) => {
    const definition = config.mcpServers[serverName];
    const selected = definition?.directTools !== undefined ? definition.directTools : config.settings?.directTools;
    return selected === "search";
  });
  if (searchModeServers.length > 0) {
    desc += `\nSearch-mode servers (${searchModeServers.join(", ")}): their tools become real, schema-backed tools the first time mcp({ search }) matches them or mcp({ tool }) calls them — after that, call them directly by name.\n`;
  }

  const disabledServers = Object.entries(config.mcpServers)
    .filter(([, definition]) => isServerDisabled(definition))
    .map(([serverName]) => serverName);
  if (disabledServers.length > 0) {
    desc += `\nDisabled servers (enable with /mcp-adapter enable <server> and /reload): ${disabledServers.join(", ")}\n`;
  }

  desc += `\nUsage:\n`;
  desc += `  mcp({ action: "install", url: "https://example.com/mcp" }) → Install, connect, and authenticate an MCP URL\n`;
  desc += `  mcp({ })                              → Show server status and tool counts\n`;
  desc += `  mcp({ server: "name" })               → List tools from server\n`;
  desc += `  mcp({ search: "query" })              → Search MCP tools by name/description\n`;
  desc += `  mcp({ describe: "tool_name" })        → Show tool details and parameters\n`;
  desc += `  mcp({ instructions: "name" })         → Show full server usage instructions\n`;
  desc += `  mcp({ connect: "server-name" })       → Connect to a server and refresh metadata\n`;
  desc += `  mcp({ tool: "name", args: { key: "value" } })         → Call a tool (object args; JSON string also accepted)\n`;
  desc += `  mcp({ action: "ui-messages" })        → Retrieve accumulated messages from completed UI sessions\n`;
  if (config.settings?.allowScriptToolSave !== false) {
    desc += `  mcp({ action: "save-script", args: { name, description, code, inputSchema } }) → Save a script as a reusable tool (asks you first)\n`;
  }
  desc += `  mcp({ action: "auth-start", server: "name" })      → Open OAuth and watch for completion\n`;
  desc += `  mcp({ action: "auth-complete", server: "name", args: { redirectUrl: "..." } }) → Complete manual OAuth\n`;
  desc += `\nMode: action > tool (call) > connect > describe > instructions > search > server (list) > nothing (status)`;

  return desc;
}
