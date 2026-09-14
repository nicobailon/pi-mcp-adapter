const LITERAL_PLUGIN_FIELDS = ["args", "env", "cwd", "headers"];
const BUILT_IN_AGENT_PLUGIN = Symbol("built-in-agent-plugin");
/** @internal */
export function markBuiltInAgentPlugin(definition, fields) {
    definition[BUILT_IN_AGENT_PLUGIN] = new Set(fields);
    return definition;
}
/** @internal */
export function isBuiltInAgentPlugin(definition, field) {
    return definition[BUILT_IN_AGENT_PLUGIN]?.has(field) === true;
}
/** @internal */
export function cloneBuiltInAgentPluginEntry(source) {
    const fields = LITERAL_PLUGIN_FIELDS.filter(field => Object.hasOwn(source, field) && isBuiltInAgentPlugin(source, field));
    if (fields.length === 0)
        return undefined;
    return markBuiltInAgentPlugin(structuredClone(source), fields);
}
/** @internal */
export function mergeBuiltInAgentPluginEntries(base, next) {
    const merged = { ...base, ...next };
    delete merged[BUILT_IN_AGENT_PLUGIN];
    const fields = LITERAL_PLUGIN_FIELDS.filter(field => {
        const owner = Object.hasOwn(next, field) ? next : base;
        return Object.hasOwn(owner, field) && isBuiltInAgentPlugin(owner, field);
    });
    if (fields.length > 0)
        markBuiltInAgentPlugin(merged, fields);
    return merged;
}
//# sourceMappingURL=agent-plugin-provenance.js.map