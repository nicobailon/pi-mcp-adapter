import { isServerDisabled } from "./types.js";
const DEFAULTS = { enabled: true, candidateLimit: 127, minProbability: 0.2 };
const ACCEPTED_KEYS = new Set(["allowedServers", "model", "candidateLimit", "minProbability"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
export function validateSemanticSearchSettings(value) {
    if (value === undefined)
        return { ...DEFAULTS, allowedServers: [] };
    if (value === false)
        return { ...DEFAULTS, enabled: false, allowedServers: [] };
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("settings.semanticSearch must be an object or false");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new Error("settings.semanticSearch must be a plain object");
    const input = value;
    for (const key of Object.keys(input))
        if (!ACCEPTED_KEYS.has(key))
            throw new Error(`settings.semanticSearch.${key} is not supported`);
    const { allowedServers = [], model, candidateLimit = DEFAULTS.candidateLimit, minProbability = DEFAULTS.minProbability } = input;
    if (!Array.isArray(allowedServers) || !allowedServers.every((name) => typeof name === "string" && name.length > 0 && !CONTROL_CHARACTERS.test(name))) {
        throw new Error("settings.semanticSearch.allowedServers must contain non-empty safe server names");
    }
    if (model !== undefined && (typeof model !== "string" || !/^[^/]+\/./s.test(model) || model.length > 256 || CONTROL_CHARACTERS.test(model))) {
        throw new Error('settings.semanticSearch.model must be a Pi classifier model as "provider/id"');
    }
    if (typeof candidateLimit !== "number" || !Number.isInteger(candidateLimit) || candidateLimit < 2 || candidateLimit > 127) {
        throw new Error("settings.semanticSearch.candidateLimit must be an integer from 2 to 127");
    }
    if (typeof minProbability !== "number" || !Number.isFinite(minProbability) || minProbability < 0 || minProbability > 1) {
        throw new Error("settings.semanticSearch.minProbability must be from 0 to 1");
    }
    return {
        enabled: true, allowedServers: [...new Set(allowedServers)],
        ...(model !== undefined ? { model } : {}),
        candidateLimit, minProbability,
    };
}
/** Without an explicit `allowedServers`, every enabled server may share its tool metadata. */
export function resolveSemanticSearchSettings(state) {
    const configured = state.config.settings?.semanticSearch;
    const settings = validateSemanticSearchSettings(configured);
    if (configured !== undefined && configured !== false && Object.hasOwn(configured, "allowedServers"))
        return settings;
    const allowedServers = Object.keys(state.config.mcpServers).filter((name) => !isServerDisabled(state.config.mcpServers[name]));
    return { ...settings, allowedServers };
}
//# sourceMappingURL=semantic-settings.js.map