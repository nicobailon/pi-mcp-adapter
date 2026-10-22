// metadata-cache.ts - Persistent MCP metadata cache
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.js";
import { createHash } from "node:crypto";
import { isBuiltInAgentPlugin } from "./agent-plugin-provenance.js";
import { getToolUiResourceUri } from "./ui-app-bridge-helpers.js";
import { createToolSelectorCandidateIndex, EXECUTOR_APP_TOOL_CAP, formatPromptCommandName, formatToolName, getToolNameCandidates, isServerDisabled, isToolAllowed, resolveToolPrefix, resolveUniqueNameOwnership } from "./types.js";
import { resourceNameToToolName } from "./resource-tools.js";
import { extractToolAnnotations, extractToolUiStreamMode, interpolateEnvRecord, interpolateEnvVars, resolveBearerToken, resolveConfigPath, resolveServerUrl, stableStringify, } from "./utils.js";
import { extractUiToolVisibility, isUiToolVisibleToModel } from "./ui-tool-visibility.js";
const CACHE_VERSION = 1;
export function getMetadataCachePath() {
    return getAgentPath("mcp-cache.json");
}
export function loadMetadataCache() {
    const cachePath = getMetadataCachePath();
    if (!existsSync(cachePath))
        return null;
    try {
        const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
        if (!raw || typeof raw !== "object")
            return null;
        if (raw.version !== CACHE_VERSION)
            return null;
        if (!raw.servers || typeof raw.servers !== "object")
            return null;
        return raw;
    }
    catch {
        return null;
    }
}
/**
 * The cache plus what this session already listed. Private or zero-TTL listings are never
 * persisted as valid, but this session's own listing still counts for this session.
 */
export function withSessionMetadata(cache, config, sessionMetadata) {
    if (!sessionMetadata?.size)
        return cache;
    const servers = { ...cache?.servers };
    for (const [serverName, entry] of sessionMetadata) {
        const definition = config.mcpServers[serverName];
        if (!definition || isServerDisabled(definition))
            continue;
        if (entry.configHash !== computeServerHash(definition))
            continue;
        const { ttlMs: _sessionTtl, cacheScope: _sessionScope, ...sessionEntry } = entry;
        servers[serverName] = { ...sessionEntry, cachedAt: Date.now() };
    }
    return { version: CACHE_VERSION, servers };
}
export function saveMetadataCache(cache, options = {}) {
    updateMetadataCacheFile(servers => {
        const next = { ...servers };
        for (const [name, listed] of Object.entries(cache.servers)) {
            const entry = withoutSessionOnlyCatalog(listed);
            // Startup batch: a catalog is written unless disk has a newer catalog for the same config, and keeps output shapes
            // saved meanwhile. A failure marker is written only if disk is unchanged since the startup snapshot, so it never
            // destroys what another session wrote during the pass.
            const disk = servers[name];
            if (!options.startupSnapshot) {
                next[name] = entry;
            }
            else if (entry.discoveryFailed) {
                if (JSON.stringify(disk) === JSON.stringify(options.startupSnapshot[name]))
                    next[name] = entry;
            }
            else if (disk && !disk.discoveryFailed && disk.configHash === entry.configHash) {
                if ((disk.cachedAt ?? 0) > entry.cachedAt)
                    continue;
                const outputShapes = { ...entry.outputShapes, ...keepOutputShapes(disk, entry.configHash, entry.tools) };
                const merged = Object.keys(outputShapes).length > 0 ? { ...entry, outputShapes } : entry;
                // An Executor app catalog another pass saved since the snapshot stays, unless this listing is session-only.
                next[name] = merged.executorApps === undefined && disk.executorApps !== undefined
                    ? withoutSessionOnlyCatalog({ ...merged, executorApps: disk.executorApps })
                    : merged;
            }
            else {
                next[name] = entry;
            }
        }
        return next;
    });
}
/** A private or zero-TTL listing's Executor app catalog stays in the session that fetched it. */
function withoutSessionOnlyCatalog(entry) {
    if (!entry.executorApps || (entry.cacheScope !== "private" && entry.ttlMs !== 0))
        return entry;
    const { executorApps: _sessionOnly, ...persisted } = entry;
    return persisted;
}
/** Reads the cache file, applies one update, and writes the result; an update returning undefined skips the write. */
function updateMetadataCacheFile(update) {
    const cachePath = getMetadataCachePath();
    const dir = dirname(cachePath);
    mkdirSync(dir, { recursive: true });
    let servers = {};
    try {
        if (existsSync(cachePath)) {
            const existing = JSON.parse(readFileSync(cachePath, "utf-8"));
            if (existing && existing.version === CACHE_VERSION && existing.servers) {
                servers = { ...existing.servers };
            }
        }
    }
    catch {
        // Ignore parse errors and proceed with empty cache
    }
    const next = update(servers);
    if (!next)
        return;
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ version: CACHE_VERSION, servers: next }), "utf-8");
    renameSync(tmpPath, cachePath);
}
export function computeServerHash(definition, environment = process.env) {
    // Hash only fields that affect server identity and tool/resource output.
    // Exclude lifecycle, idleTimeout, requestTimeoutMs, debug — those are runtime behavior settings
    // that don't change which tools a server exposes.
    const isStdio = !!definition.command;
    const literalEnv = isBuiltInAgentPlugin(definition, "env") || (isStdio && definition.literalEnv === true);
    const identity = {
        command: resolveConfigPath(definition.command, environment),
        args: definition.args,
        socket: resolveConfigPath(definition.socket, environment),
        env: literalEnv ? definition.env : interpolateEnvRecord(definition.env, environment),
        ...(isStdio ? { inheritEnv: definition.inheritEnv !== false, literalEnv } : {}),
        cwd: isBuiltInAgentPlugin(definition, "cwd") ? definition.cwd : resolveConfigPath(definition.cwd, environment),
        url: resolveServerUrl(definition, environment),
        headers: isBuiltInAgentPlugin(definition, "headers") ? definition.headers : interpolateEnvRecord(definition.headers, environment),
        requestHeadersCommand: definition.requestHeadersCommand
            ? {
                command: interpolateEnvVars(definition.requestHeadersCommand.command, environment),
                args: definition.requestHeadersCommand.args?.map((argument) => interpolateEnvVars(argument, environment)),
                env: interpolateEnvRecord(definition.requestHeadersCommand.env, environment),
                timeoutMs: definition.requestHeadersCommand.timeoutMs,
            }
            : undefined,
        auth: definition.auth,
        protocolVersion: definition.protocolVersion,
        bearerToken: resolveBearerToken(definition, environment),
        bearerTokenEnv: definition.bearerTokenEnv,
        exposeResources: definition.exposeResources,
        includeTools: definition.includeTools,
        excludeTools: definition.excludeTools,
        // Servers may list different tools when the host has no UI. Only false is hashed so other caches stay valid.
        ...(definition.openUi === false ? { openUi: false } : {}),
    };
    const normalized = stableStringify(identity);
    return createHash("sha256").update(normalized).digest("hex");
}
/**
 * Identifies the tool definition an output shape was learned against. A shape is only used or saved while
 * the tool's description and input schema still match, since a change there can mean a different result.
 */
export function outputShapeKey(tool) {
    return stableStringify({ description: tool.description ?? "", inputSchema: tool.inputSchema ?? null });
}
/**
 * Saves one tool's observed output shape into its server's cache entry, if the entry matches the running config
 * and tool. The entry comes from the same read the write replaces, so newer metadata from other Pi processes is kept.
 */
export function saveObservedOutput(serverName, definition, toolName, toolKey, output) {
    const configHash = computeServerHash(definition);
    updateMetadataCacheFile(servers => {
        const entry = servers[serverName];
        const cachedTool = entry?.tools?.find(tool => tool.name === toolName);
        if (!entry || !cachedTool || entry.configHash !== configHash || outputShapeKey(cachedTool) !== toolKey)
            return undefined;
        return { ...servers, [serverName]: { ...entry, outputShapes: { ...entry.outputShapes, [toolName]: output } } };
    });
}
/** Output shapes to carry into a rewritten cache entry: same config, not private, and only tools whose definition kept its shape key. */
export function keepOutputShapes(previous, configHash, tools) {
    if (!previous?.outputShapes || previous.configHash !== configHash || previous.cacheScope === "private")
        return undefined;
    const kept = Object.entries(previous.outputShapes).filter(([toolName]) => {
        const before = previous.tools?.find(tool => tool.name === toolName);
        const after = tools.find(tool => tool.name === toolName);
        return before !== undefined && after !== undefined && outputShapeKey(before) === outputShapeKey(after);
    });
    return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}
/** Adds an Executor server's app catalog to its cache entry on disk, if that entry is still the same, persistable listing. */
export function saveExecutorCatalog(serverName, configHash, catalog) {
    updateMetadataCacheFile(servers => {
        const entry = servers[serverName];
        if (!entry || entry.configHash !== configHash || entry.discoveryFailed || entry.cacheScope === "private" || entry.ttlMs === 0)
            return undefined;
        return { ...servers, [serverName]: { ...entry, executorApps: catalog } };
    });
}
/**
 * Adds one Executor app tool's full signature to the catalog on disk, if that entry is still the
 * same listing and its catalog still has the tool. Only that item changes, so a newer catalog
 * another session saved meanwhile is kept.
 * @internal
 */
export function saveExecutorSignature(serverName, configHash, path, signature) {
    updateMetadataCacheFile(servers => {
        const entry = servers[serverName];
        const catalog = entry?.executorApps;
        if (!entry || entry.configHash !== configHash || !Array.isArray(catalog?.tools))
            return undefined;
        const index = catalog.tools.findIndex(tool => isUsableCachedAppTool(tool) && tool.path === path);
        if (index === -1)
            return undefined;
        const tools = [...catalog.tools];
        tools[index] = { ...tools[index], signature };
        return { ...servers, [serverName]: { ...entry, executorApps: { ...catalog, tools } } };
    });
}
export function isServerCacheValid(entry, definition, 
// 0 means no age limit: without a server-declared TTL, an entry stays valid until the next connect refreshes it.
maxAgeMs = 0, environment = process.env) {
    let configHash;
    try {
        configHash = computeServerHash(definition, environment);
    }
    catch {
        return false;
    }
    if (!entry || entry.configHash !== configHash)
        return false;
    if (!entry.cachedAt || typeof entry.cachedAt !== "number")
        return false;
    // The persistent cache is not partitioned by authorization context.
    if (entry.cacheScope === "private")
        return false;
    if (entry.discoveryFailed)
        return false;
    const declaredTtlMs = entry.ttlMs;
    if (typeof declaredTtlMs === "number" && Number.isSafeInteger(declaredTtlMs) && declaredTtlMs >= 0) {
        if (declaredTtlMs === 0)
            return false;
        const ageMs = Date.now() - entry.cachedAt;
        const effectiveMaxAge = maxAgeMs > 0 ? Math.min(maxAgeMs, declaredTtlMs) : declaredTtlMs;
        return ageMs < effectiveMaxAge;
    }
    if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs)
        return false;
    return true;
}
export function parseDirectToolSelectors(selectors) {
    const servers = new Set();
    const tools = new Map();
    for (let selector of selectors) {
        selector = selector.replace(/\/+$/, "");
        if (selector.includes("/")) {
            const [server, tool] = selector.split("/", 2);
            if (server && tool) {
                const serverTools = tools.get(server) ?? new Set();
                serverTools.add(tool);
                tools.set(server, serverTools);
            }
            else if (server) {
                servers.add(server);
            }
        }
        else if (selector) {
            servers.add(selector);
        }
    }
    return { servers, tools };
}
export function getMissingConfiguredDirectToolServers(config, cache, envOverride) {
    const missing = [];
    const globalDirect = config.settings?.directTools;
    const envSelection = envOverride ? parseDirectToolSelectors(envOverride) : null;
    for (const [serverName, definition] of Object.entries(config.mcpServers)) {
        if (isServerDisabled(definition))
            continue;
        const hasDirectTools = envSelection
            ? envSelection.servers.has(serverName) || envSelection.tools.has(serverName)
            : definition.directTools !== undefined
                ? !!definition.directTools
                : !!globalDirect;
        if (!hasDirectTools)
            continue;
        const serverCache = cache?.servers?.[serverName];
        if (!serverCache || !isServerCacheValid(serverCache, definition)) {
            missing.push(serverName);
        }
    }
    return missing;
}
export function reconstructToolMetadata(serverName, entry, prefix, definition, configuredServers, cache, sharedSelectorCandidateIndex) {
    const metadata = [];
    const effectivePrefix = resolveToolPrefix(definition, prefix);
    const hasToolFilters = (Array.isArray(definition.includeTools) && definition.includeTools.length > 0) ||
        (Array.isArray(definition.excludeTools) && definition.excludeTools.length > 0);
    const selectorCandidateIndex = hasToolFilters
        ? sharedSelectorCandidateIndex ?? (configuredServers && cache
            ? createCachedToolSelectorCandidateIndex(configuredServers, cache, prefix)
            : undefined)
        : undefined;
    for (const tool of entry.tools ?? []) {
        if (!tool?.name)
            continue;
        if (!isUiToolVisibleToModel(tool.uiVisibility)) {
            continue;
        }
        if (!isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) {
            continue;
        }
        const name = formatToolName(tool.name, serverName, effectivePrefix);
        const annotations = extractToolAnnotations(tool.annotations);
        metadata.push({
            name,
            originalName: tool.name,
            description: tool.description ?? "",
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
            ...(tool.uiResourceUri !== undefined ? { uiResourceUri: tool.uiResourceUri } : {}),
            ...(tool.uiVisibility !== undefined ? { uiVisibility: tool.uiVisibility } : {}),
            ...(tool.uiStreamMode !== undefined ? { uiStreamMode: tool.uiStreamMode } : {}),
            ...(annotations !== undefined ? { annotations } : {}),
        });
    }
    if (definition.exposeResources !== false) {
        for (const resource of entry.resources ?? []) {
            if (!resource?.name || !resource?.uri)
                continue;
            const baseName = `read_${resourceNameToToolName(resource.name)}`;
            if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex)) {
                continue;
            }
            const name = formatToolName(baseName, serverName, effectivePrefix);
            metadata.push({
                name,
                originalName: baseName,
                description: resource.description ?? `Read resource: ${resource.uri}`,
                resourceUri: resource.uri,
            });
        }
    }
    const unique = resolveUniqueNameOwnership(metadata, (tool) => tool.name).unique;
    const takenNames = new Set(unique.map((tool) => tool.name));
    return [...unique, ...executorAppToolMetadata(serverName, entry, effectivePrefix, definition, selectorCandidateIndex, takenNames)];
}
/**
 * The tool metadata of an Executor server's cached app tools, named by canonical path, after
 * includeTools/excludeTools. Executor's own `tools.executor.*` tools are never app tools, and an
 * app tool never takes an adapter name in `takenNames` or one an earlier app tool took, so the
 * first in Executor's order wins; without `takenNames` (the Pi registry, which hashes shared
 * names) names are not checked. Executor gives no JSON Schema, so the input is any object and the
 * description carries the TypeScript input type. A corrupt cached item is skipped.
 */
export function executorAppToolMetadata(serverName, entry, effectivePrefix, definition, selectorCandidateIndex, takenNames) {
    const metadata = [];
    const taken = takenNames ? new Set(takenNames) : undefined;
    for (const tool of (entry.executorApps?.tools ?? []).slice(0, EXECUTOR_APP_TOOL_CAP)) {
        if (!isUsableCachedAppTool(tool) || !isExecutorAppToolAllowed(tool, serverName, effectivePrefix, definition, selectorCandidateIndex))
            continue;
        const name = formatToolName(tool.canonicalPath, serverName, effectivePrefix);
        if (taken) {
            if (taken.has(name))
                continue;
            taken.add(name);
        }
        metadata.push({
            name,
            originalName: tool.canonicalPath,
            description: `${tool.description ? `${tool.description}\n\n` : ""}Executor app tool ${tool.canonicalPath}. Input: ${tool.inputType}${tool.inputTruncated ? " (cut short by Executor)" : ""}`,
            inputSchema: { type: "object", properties: {} },
            executorPath: tool.path,
        });
    }
    return metadata;
}
/** A cached catalog item with the fields every reader needs; a corrupt cache file can hold anything. */
export function isUsableCachedAppTool(tool) {
    const candidate = tool;
    return typeof candidate?.canonicalPath === "string" && candidate.canonicalPath !== "" && typeof candidate.path === "string";
}
/** Executor lists its own admin API as `tools.executor.*`; those are never app tools. */
export function isExecutorOwnTool(tool) {
    return tool.canonicalPath.startsWith("executor.");
}
/** Whether one of an Executor server's catalog tools is an app tool its includeTools/excludeTools allow. */
export function isExecutorAppToolAllowed(tool, serverName, effectivePrefix, definition, selectorCandidateIndex) {
    return !isExecutorOwnTool(tool)
        && isToolAllowed(tool.canonicalPath, serverName, effectivePrefix, definition.includeTools, definition.excludeTools, selectorCandidateIndex);
}
export function createCachedToolSelectorCandidateIndex(configuredServers, cache, prefix) {
    const candidates = new Set();
    for (const [serverName, definition] of Object.entries(configuredServers)) {
        const entry = cache.servers[serverName];
        if (!entry || !isServerCacheValid(entry, definition) || isServerDisabled(definition))
            continue;
        const effectivePrefix = resolveToolPrefix(definition, prefix);
        for (const tool of entry.tools ?? []) {
            if (!isUiToolVisibleToModel(tool.uiVisibility))
                continue;
            for (const candidate of getToolNameCandidates(tool.name, serverName, effectivePrefix, false))
                candidates.add(candidate);
        }
        if (definition.exposeResources !== false) {
            for (const resource of entry.resources ?? []) {
                const baseName = `read_${resourceNameToToolName(resource.name)}`;
                for (const candidate of getToolNameCandidates(baseName, serverName, effectivePrefix, false))
                    candidates.add(candidate);
            }
        }
        for (const tool of (entry.executorApps?.tools ?? []).slice(0, EXECUTOR_APP_TOOL_CAP)) {
            if (!isUsableCachedAppTool(tool) || isExecutorOwnTool(tool))
                continue;
            for (const candidate of getToolNameCandidates(tool.canonicalPath, serverName, effectivePrefix, false))
                candidates.add(candidate);
        }
    }
    return createToolSelectorCandidateIndex(candidates);
}
export function serializeTools(tools) {
    return tools
        .filter(t => t?.name)
        .map(t => {
        const uiResourceUri = tryGetToolUiResourceUri(t);
        const uiVisibility = extractUiToolVisibility(t._meta);
        const uiStreamMode = extractToolUiStreamMode(t._meta);
        const annotations = extractToolAnnotations(t.annotations);
        return {
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
            ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
            ...(uiResourceUri !== undefined ? { uiResourceUri } : {}),
            ...(uiVisibility !== undefined ? { uiVisibility } : {}),
            ...(uiStreamMode !== undefined ? { uiStreamMode } : {}),
            ...(annotations !== undefined ? { annotations } : {}),
        };
    });
}
export function serializeResources(resources) {
    return resources
        .filter(r => r?.name && r?.uri)
        .map(r => ({
        uri: r.uri,
        name: r.name,
        ...(r.description !== undefined ? { description: r.description } : {}),
    }));
}
export function serializePrompts(prompts) {
    return (prompts ?? [])
        .filter(prompt => prompt?.name)
        .map(prompt => ({
        name: prompt.name,
        ...(prompt.title !== undefined ? { title: prompt.title } : {}),
        ...(prompt.description !== undefined ? { description: prompt.description } : {}),
        ...(Array.isArray(prompt.arguments)
            ? {
                arguments: prompt.arguments.filter(argument => argument?.name).map(argument => ({
                    name: argument.name,
                    ...(argument.description !== undefined ? { description: argument.description } : {}),
                    ...(argument.required !== undefined ? { required: argument.required } : {}),
                })),
            }
            : {}),
    }));
}
export function reconstructPromptMetadata(serverName, prompts, prefix, definition) {
    const effectivePrefix = resolveToolPrefix(definition, prefix);
    return (prompts ?? []).filter(prompt => prompt?.name).map(prompt => {
        const args = Array.isArray(prompt.arguments)
            ? prompt.arguments.filter(argument => argument?.name).map(argument => ({
                name: argument.name,
                ...(argument.description !== undefined ? { description: argument.description } : {}),
                ...(argument.required !== undefined ? { required: argument.required } : {}),
            }))
            : [];
        return {
            serverName,
            originalName: prompt.name,
            commandName: formatPromptCommandName(prompt.name, serverName, effectivePrefix),
            ...(prompt.title !== undefined ? { title: prompt.title } : {}),
            description: prompt.description ?? "",
            arguments: args,
        };
    });
}
function tryGetToolUiResourceUri(tool) {
    try {
        return getToolUiResourceUri({ _meta: tool._meta });
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=metadata-cache.js.map