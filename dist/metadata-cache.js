// metadata-cache.ts - Persistent MCP metadata cache
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentPath } from "./agent-dir.js";
import { createHash } from "node:crypto";
import { isBuiltInAgentPlugin } from "./agent-plugin-provenance.js";
import { getToolUiResourceUri } from "./ui-app-bridge-helpers.js";
import { createToolSelectorCandidateIndex, formatPromptCommandName, formatToolName, getToolNameCandidates, isServerDisabled, isToolAllowed, resolveToolPrefix, resolveUniqueNameOwnership } from "./types.js";
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
export function saveMetadataCache(cache, options = {}) {
    updateMetadataCacheFile(servers => {
        const next = { ...servers };
        for (const [name, entry] of Object.entries(cache.servers)) {
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
                next[name] = Object.keys(outputShapes).length > 0 ? { ...entry, outputShapes } : entry;
            }
            else {
                next[name] = entry;
            }
        }
        return next;
    });
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
    return resolveUniqueNameOwnership(metadata, (tool) => tool.name).unique;
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