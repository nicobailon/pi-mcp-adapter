/** Versioned shared-event-bus channel for read-only MCP runtime snapshots. */
export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
export const MCP_STATUS_SNAPSHOT_VERSION = 1;
// Re-export stream types from the shared lightweight module.
// This allows the example package to import stream schemas without pulling the full types.ts dependency graph.
export { UI_STREAM_HOST_CONTEXT_KEY, UI_STREAM_REQUEST_META_KEY, UI_STREAM_RESULT_PATCH_METHOD, SERVER_STREAM_RESULT_PATCH_METHOD, UI_STREAM_STRUCTURED_CONTENT_KEY, uiStreamModeSchema, visualizationStreamPhaseSchema, visualizationStreamFrameTypeSchema, visualizationStreamStatusSchema, uiStreamHostContextSchema, visualizationStreamEnvelopeSchema, uiStreamCallToolResultSchema, uiStreamResultPatchNotificationSchema, serverStreamResultPatchNotificationSchema, getUiStreamHostContext, getVisualizationStreamEnvelope, } from "./ui-stream-types.js";
/**
 * Extract prompt text from either legacy MCP UI message shapes or native AppBridge user messages.
 */
export function extractUiPromptText(params) {
    if (params.type === "prompt" || params.prompt) {
        const prompt = params.prompt ?? String(params.message ?? "");
        return prompt || undefined;
    }
    if (params.role === "user" && Array.isArray(params.content)) {
        const text = params.content
            .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text ?? "") : ""))
            .filter(Boolean)
            .join("\n\n");
        return text || undefined;
    }
    return undefined;
}
/**
 * Parse a canonical named UI handoff encoded as `intent\n{json}`.
 */
export function parseUiPromptHandoff(prompt) {
    const newlineIndex = prompt.indexOf("\n");
    if (newlineIndex <= 0) {
        return undefined;
    }
    const intent = prompt.slice(0, newlineIndex).trim();
    const payloadText = prompt.slice(newlineIndex + 1).trim();
    if (!intent || !payloadText) {
        return undefined;
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(intent)) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(payloadText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return undefined;
        }
        return {
            intent,
            params: parsed,
            raw: prompt,
        };
    }
    catch {
        return undefined;
    }
}
export function createUiModelContextUpdate(params, maxChars = 12_000) {
    const payload = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
    if (Object.keys(payload).length === 0)
        return undefined;
    const serialized = JSON.stringify(payload);
    if (serialized.length <= maxChars) {
        return { payload, summary: serialized, truncated: false };
    }
    return {
        summary: `${serialized.slice(0, Math.max(0, maxChars - 1))}…`,
        truncated: true,
    };
}
/** Only the literal boolean `true` disables a server. */
export function isServerDisabled(definition) {
    return definition?.disabled === true;
}
const ENCODED_SERVER_NAMESPACE_MARKER = "_mcpns_";
export function formatServerNamespace(serverName) {
    const normalized = serverName.replace(/-/g, "_");
    if (normalized === "" || (/^[A-Za-z0-9_]+$/.test(normalized) && !normalized.startsWith(ENCODED_SERVER_NAMESPACE_MARKER))) {
        return normalized;
    }
    const codePoints = Array.from(normalized, character => character.codePointAt(0).toString(16)).join("_");
    return `${ENCODED_SERVER_NAMESPACE_MARKER}${codePoints}`;
}
export const MCP_TOOL_APPROVAL_REQUEST_EVENT = "pi-mcp-adapter:tool-approval-request";
/**
 * Get server prefix based on tool prefix mode.
 */
function sanitizeServerPrefix(serverName, preserveProviderValid = true) {
    const validCharacters = preserveProviderValid ? /^[A-Za-z0-9_-]$/ : /^[A-Za-z0-9]$/;
    return Array.from(serverName, char => validCharacters.test(char) ? char : `_${char.codePointAt(0).toString(16)}_`).join("");
}
export function getServerPrefix(serverName, mode) {
    if (mode === "none")
        return "";
    if (mode === "short") {
        let short = sanitizeServerPrefix(serverName.replace(/-?mcp$/i, ""));
        if (!short)
            short = "mcp";
        return short;
    }
    if (mode === "mcp")
        return `mcp__${sanitizeServerPrefix(serverName)}`;
    return sanitizeServerPrefix(serverName);
}
/**
 * Format a tool name with server prefix.
 */
export function formatToolName(toolName, serverName, prefix) {
    const p = getServerPrefix(serverName, prefix);
    const sanitized = toolName.replace(/\./g, "_");
    return p ? `${p}_${sanitized}` : sanitized;
}
export function resolveToolPrefix(definition, globalPrefix) {
    return definition?.toolPrefix ?? globalPrefix ?? "server";
}
/**
 * Resolve a configured MCP server name from a prefixed tool name.
 *
 * When the proxy tool is addressed with a fully-qualified name such as
 * `searxng_searxng_web_search`, downstream policy systems (for example a
 * permission gate) need to recover the owning server so they can evaluate
 * server-scoped rules against the bare server name. This performs the inverse
 * of {@link getServerPrefix}: it finds the longest configured server prefix
 * that the tool name starts with and returns that server's name.
 *
 * @param toolName - the tool name as passed to the proxy `mcp({ tool })` call.
 * @param serverNames - the configured MCP server names (keys of `mcpServers`).
 * @param prefix - the active tool-prefix mode.
 * @returns the resolved server name, or `undefined` when no prefix matches or
 *   the prefix mode is `"none"`.
 */
export function resolveServerFromToolName(toolName, serverNames, prefix) {
    if (prefix === "none")
        return undefined;
    const candidates = [];
    for (const name of serverNames) {
        const p = getServerPrefix(name, prefix);
        if (p && toolName.startsWith(p + "_"))
            candidates.push({ name, prefix: p });
    }
    if (candidates.length === 0)
        return undefined;
    candidates.sort((a, b) => b.prefix.length - a.prefix.length);
    const best = candidates[0];
    // Fail safe: short mode can intentionally map names such as foo and foo-mcp
    // to the same prefix. Return undefined so a downstream permission gate uses
    // its existing wildcard path rather than enforcing a rule against the wrong server.
    if (candidates.some((c) => c.prefix === best.prefix && c.name !== best.name)) {
        return undefined;
    }
    return best?.name;
}
export function sanitizePromptName(name) {
    const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
    if (!cleaned)
        return "prompt";
    return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}
export function formatPromptCommandName(promptName, serverName, prefix) {
    const serverPart = getServerPrefix(serverName, prefix) || sanitizeServerPrefix(serverName) || "server";
    return `mcp__${serverPart}__${sanitizePromptName(promptName)}`;
}
function getLegacyServerPrefix(serverName, mode) {
    if (mode === "none")
        return "";
    if (mode === "short")
        return sanitizeServerPrefix(serverName.replace(/-?mcp$/i, ""), false) || "mcp";
    if (mode === "mcp")
        return `mcp__${sanitizeServerPrefix(serverName, false)}`;
    return sanitizeServerPrefix(serverName, false);
}
function formatLegacyToolName(toolName, serverName, prefix) {
    const serverPrefix = getLegacyServerPrefix(serverName, prefix);
    const sanitizedToolName = toolName.replace(/[.-]/g, "_");
    return serverPrefix ? `${serverPrefix}_${sanitizedToolName}` : sanitizedToolName;
}
export function getToolNameCandidates(toolName, serverName, prefix, includeLegacy = true) {
    const candidates = new Set([
        toolName,
        formatToolName(toolName, serverName, prefix),
        formatToolName(toolName, serverName, "server"),
        formatToolName(toolName, serverName, "short"),
        formatToolName(toolName, serverName, "mcp"),
    ]);
    if (includeLegacy) {
        const legacyToolName = toolName.replace(/-/g, "_");
        candidates.add(legacyToolName);
        candidates.add(formatToolName(legacyToolName, serverName, prefix));
        candidates.add(formatToolName(legacyToolName, serverName, "server"));
        candidates.add(formatToolName(legacyToolName, serverName, "short"));
        candidates.add(formatToolName(legacyToolName, serverName, "mcp"));
        candidates.add(formatLegacyToolName(toolName, serverName, prefix));
        candidates.add(formatLegacyToolName(toolName, serverName, "server"));
        candidates.add(formatLegacyToolName(toolName, serverName, "short"));
        candidates.add(formatLegacyToolName(toolName, serverName, "mcp"));
        candidates.add(formatToolName(toolName, serverName, prefix).replace(/-/g, "_"));
        candidates.add(formatToolName(toolName, serverName, "server").replace(/-/g, "_"));
        candidates.add(formatToolName(toolName, serverName, "short").replace(/-/g, "_"));
        candidates.add(formatToolName(toolName, serverName, "mcp").replace(/-/g, "_"));
    }
    return candidates;
}
function globToRegExp(pattern) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
}
export function createToolSelectorCandidateIndex(allCurrentCandidates, additionalCurrentCandidatesByToolName) {
    return {
        allCurrentCandidates,
        matchingCountByPattern: new Map(),
        matcherByPattern: new Map(),
        ...(additionalCurrentCandidatesByToolName ? { additionalCurrentCandidatesByToolName } : {}),
    };
}
export function matchesToolPattern(candidates, patterns) {
    if (!Array.isArray(patterns) || patterns.length === 0)
        return false;
    for (const pattern of patterns) {
        if (typeof pattern !== "string")
            continue;
        if (!pattern.includes("*") && !pattern.includes("?") && candidates.has(pattern)) {
            return true;
        }
        if ((pattern.includes("*") || pattern.includes("?")) && [...candidates].some(candidate => globToRegExp(pattern).test(candidate))) {
            return true;
        }
    }
    return false;
}
function indexHasOtherCurrentMatch(index, toolName, currentCandidates, pattern) {
    const additionalCandidates = index.additionalCurrentCandidatesByToolName?.get(toolName);
    const hasCandidate = (candidate) => index.allCurrentCandidates.has(candidate) || additionalCandidates?.has(candidate) === true;
    const isGlob = pattern.includes("*") || pattern.includes("?");
    if (!isGlob) {
        return hasCandidate(pattern) && !currentCandidates.has(pattern);
    }
    let matcher = index.matcherByPattern.get(pattern);
    if (!matcher) {
        matcher = globToRegExp(pattern);
        index.matcherByPattern.set(pattern, matcher);
    }
    let matchingCount = index.matchingCountByPattern.get(pattern);
    if (matchingCount === undefined) {
        matchingCount = 0;
        for (const candidate of index.allCurrentCandidates) {
            if (matcher.test(candidate))
                matchingCount++;
        }
        index.matchingCountByPattern.set(pattern, matchingCount);
    }
    let totalMatchingCount = matchingCount;
    if (additionalCandidates) {
        for (const candidate of additionalCandidates) {
            if (!index.allCurrentCandidates.has(candidate) && matcher.test(candidate))
                totalMatchingCount++;
        }
    }
    if (totalMatchingCount === 0)
        return false;
    let currentMatchingCount = 0;
    for (const candidate of currentCandidates) {
        if (hasCandidate(candidate) && matcher.test(candidate))
            currentMatchingCount++;
    }
    return totalMatchingCount > currentMatchingCount;
}
function matchesToolSelector(toolName, serverName, prefix, patterns, otherCurrentCandidates) {
    if (!Array.isArray(patterns) || patterns.length === 0)
        return false;
    const currentCandidates = getToolNameCandidates(toolName, serverName, prefix, false);
    if (matchesToolPattern(currentCandidates, patterns))
        return true;
    if (!otherCurrentCandidates)
        return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), patterns);
    const legacyCandidates = getToolNameCandidates(toolName, serverName, prefix);
    for (const candidate of currentCandidates)
        legacyCandidates.delete(candidate);
    return patterns.some(pattern => {
        if (typeof pattern !== "string" || !matchesToolPattern(legacyCandidates, [pattern]))
            return false;
        const hasCollision = otherCurrentCandidates instanceof Set
            ? matchesToolPattern(otherCurrentCandidates, [pattern])
            : indexHasOtherCurrentMatch(otherCurrentCandidates, toolName, currentCandidates, pattern);
        return !hasCollision;
    });
}
export function isToolIncluded(toolName, serverName, prefix, includeTools, otherCurrentCandidates) {
    if (!Array.isArray(includeTools) || includeTools.length === 0)
        return true;
    return matchesToolSelector(toolName, serverName, prefix, includeTools, otherCurrentCandidates);
}
export function isToolExcluded(toolName, serverName, prefix, excludeTools, otherCurrentCandidates) {
    return matchesToolSelector(toolName, serverName, prefix, excludeTools, otherCurrentCandidates);
}
export function isToolAllowed(toolName, serverName, prefix, includeTools, excludeTools, otherCurrentCandidates) {
    return isToolIncluded(toolName, serverName, prefix, includeTools, otherCurrentCandidates)
        && !isToolExcluded(toolName, serverName, prefix, excludeTools, otherCurrentCandidates);
}
//# sourceMappingURL=types.js.map