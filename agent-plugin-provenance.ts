import type { ServerEntry } from "./types.ts";

const LITERAL_PLUGIN_FIELDS = ["args", "env", "cwd", "headers"] as const;
type LiteralPluginField = typeof LITERAL_PLUGIN_FIELDS[number];
const BUILT_IN_AGENT_PLUGIN = Symbol("built-in-agent-plugin");
type BuiltInAgentPluginEntry = ServerEntry & { [BUILT_IN_AGENT_PLUGIN]?: ReadonlySet<LiteralPluginField> };

/** @internal */
export function markBuiltInAgentPlugin(definition: ServerEntry, fields: LiteralPluginField[]): ServerEntry {
  (definition as BuiltInAgentPluginEntry)[BUILT_IN_AGENT_PLUGIN] = new Set(fields);
  return definition;
}

/** @internal */
export function isBuiltInAgentPlugin(definition: ServerEntry, field: LiteralPluginField): boolean {
  return (definition as BuiltInAgentPluginEntry)[BUILT_IN_AGENT_PLUGIN]?.has(field) === true;
}

/** @internal */
export function cloneBuiltInAgentPluginEntry(source: ServerEntry): ServerEntry | undefined {
  const fields = LITERAL_PLUGIN_FIELDS.filter(field => Object.hasOwn(source, field) && isBuiltInAgentPlugin(source, field));
  if (fields.length === 0) return undefined;
  return markBuiltInAgentPlugin(structuredClone(source), fields);
}

/** @internal */
export function mergeBuiltInAgentPluginEntries(base: ServerEntry, next: ServerEntry): ServerEntry {
  const merged = { ...base, ...next };
  delete (merged as BuiltInAgentPluginEntry)[BUILT_IN_AGENT_PLUGIN];
  const fields = LITERAL_PLUGIN_FIELDS.filter(field => {
    const owner = Object.hasOwn(next, field) ? next : base;
    return Object.hasOwn(owner, field) && isBuiltInAgentPlugin(owner, field);
  });
  if (fields.length > 0) markBuiltInAgentPlugin(merged, fields);
  return merged;
}
