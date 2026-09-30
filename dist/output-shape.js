import { logger } from "./logger.js";
import { outputShapeKey, saveObservedOutput } from "./metadata-cache.js";
import { formatPropertyName } from "./ts-shape.js";
const MAX_DEPTH = 6;
const MAX_ARRAY_SAMPLE = 5;
// Objects wider than this, or with any key that does not look like a field name, are treated as maps
// keyed by data (ids, emails, dates), so their keys are not kept.
const MAX_OBJECT_KEYS = 40;
const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,39}$/;
const MAX_UNION = 4;
const MAX_NODES_PER_CALL = 1000;
// Sizes count UTF-16 code units (string length), not bytes.
const MAX_SHAPE_CHARS = 4 * 1024;
const MAX_JSON_TEXT_CHARS = 256 * 1024;
// Object shapes at least this long that appear more than once are written once as a named type.
const MIN_ALIAS_CHARS = 80;
const SHAPE_TYPES = new Set(["null", "boolean", "number", "string", "object", "array"]);
/**
 * Looks the tool up when the call starts, so its result is recorded against the definition it was
 * requested under even if a tools/list_changed refresh replaces that definition mid-call.
 */
export function observedOutputRecorder(state, serverName, toolName) {
    const tool = findTool(state, serverName, toolName);
    const listingIsPrivate = () => state.manager.getConnection(serverName)?.toolListHints?.cacheScope === "private";
    const privateAtStart = listingIsPrivate();
    return result => recordObservedOutput(state, serverName, tool, privateAtStart || listingIsPrivate(), result);
}
function recordObservedOutput(state, serverName, tool, observedPrivately, result) {
    if (!tool || tool.outputSchema !== undefined)
        return;
    const toolName = tool.originalName;
    const observed = readResultValue(result);
    if (!observed)
        return;
    const definition = state.config.mcpServers[serverName];
    if (!definition)
        return;
    const shape = inferShape(observed.value, 0, { nodes: MAX_NODES_PER_CALL });
    const byTool = observedOutputsFor(state, definition);
    const toolKey = outputShapeKey(tool);
    const previous = byTool.get(toolName);
    const mergeable = previous?.source === observed.source && previous.toolKey === toolKey;
    const next = {
        source: observed.source,
        shape: fitShape(mergeable ? mergeShapes(previous.shape, shape) : shape),
        toolKey,
        private: observedPrivately || (mergeable && previous.private),
    };
    byTool.set(toolName, next);
    // Skip unchanged shapes to avoid repeated cache writes; sessions without mcpScript never write.
    if (state.scriptTool === true && !next.private && JSON.stringify(next) !== JSON.stringify(previous)) {
        try {
            saveObservedOutput(serverName, definition, toolName, toolKey, { source: next.source, shape: next.shape });
        }
        catch (error) {
            // The shape stays in memory for this session; only later sessions miss it.
            logger.debug(`MCP: failed to save output shape for ${serverName}/${toolName}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
/** Adds shapes from a cache entry, tagged with the entry's own tool definitions, unless this session already has one for that definition. */
export function seedObservedOutputs(state, serverName, entry) {
    const definition = state.config.mcpServers[serverName];
    const saved = entry.outputShapes;
    if (!definition || typeof saved !== "object" || saved === null)
        return;
    const byTool = observedOutputsFor(state, definition);
    for (const [toolName, value] of Object.entries(saved)) {
        const cachedTool = Array.isArray(entry.tools) ? entry.tools.find(tool => tool?.name === toolName) : undefined;
        if (!cachedTool || typeof value !== "object" || value === null)
            continue;
        const toolKey = outputShapeKey(cachedTool);
        if (byTool.get(toolName)?.toolKey === toolKey)
            continue;
        const { source, shape } = value;
        if (source !== "structuredContent" && source !== "jsonText")
            continue;
        const parsed = readSavedShape(shape, 0);
        if (parsed && !isUnknown(parsed))
            byTool.set(toolName, { source, shape: fitShape(parsed), toolKey, private: false });
    }
}
export function getObservedOutput(state, serverName, tool) {
    if (tool.outputSchema !== undefined)
        return undefined;
    const definition = state.config.mcpServers[serverName];
    const observed = definition && state.observedOutputs?.get(definition)?.get(tool.originalName);
    return observed && observed.toolKey === outputShapeKey(tool) && !isUnknown(observed.shape) ? observed : undefined;
}
export function renderOutputShape(shape) {
    // First pass: each object's full text, counted, so APIs that repeat a wide object (a user under
    // user, assignee, and assignees) show its fields once instead of three times.
    const plain = new Map();
    const uses = new Map();
    const once = renderShape(shape, "item", (node, field, text) => {
        plain.set(node, text);
        const use = uses.get(text);
        if (use)
            use.count++;
        else
            uses.set(text, { count: 1, field });
        return text;
    });
    const names = new Map();
    const taken = new Set(["Record"]);
    for (const [text, use] of uses) {
        if (use.count < 2 || text.length < MIN_ALIAS_CHARS)
            continue;
        const words = use.field.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join("");
        const base = /^[A-Za-z]/.test(words) ? words : `T${words}`;
        let name = base;
        for (let suffix = 2; taken.has(name); suffix++)
            name = `${base}${suffix}`;
        taken.add(name);
        names.set(text, name);
    }
    if (names.size === 0)
        return once;
    const definitions = new Map();
    const main = renderShape(shape, "item", (node, _field, text) => {
        const name = names.get(plain.get(node));
        if (!name)
            return text;
        if (!definitions.has(name))
            definitions.set(name, text);
        return name;
    });
    return [...[...definitions].map(([name, body]) => `type ${name} = ${body};`), main].join("\n");
}
function renderShape(shape, field, onObject) {
    if (shape.anyOf)
        return shape.anyOf.map(variant => renderShape(variant, field, onObject)).join(" | ");
    switch (shape.type) {
        case undefined:
            return "unknown";
        case "object": {
            if (shape.additionalProperties)
                return `Record<string, ${renderShape(shape.additionalProperties, field, onObject)}>`;
            const required = new Set(shape.required);
            const properties = Object.entries(shape.properties ?? {})
                .map(([name, property]) => `${formatPropertyName(name)}${required.has(name) ? "" : "?"}: ${renderShape(property, name, onObject)};`);
            return onObject(shape, field, properties.length === 0 ? "{}" : `{ ${properties.join(" ")} }`);
        }
        case "array": {
            if (!shape.items)
                return "unknown[]";
            const item = renderShape(shape.items, field, onObject);
            return shape.items.anyOf ? `(${item})[]` : `${item}[]`;
        }
        default:
            return shape.type;
    }
}
function observedOutputsFor(state, definition) {
    const observedOutputs = state.observedOutputs ??= new WeakMap();
    let byTool = observedOutputs.get(definition);
    if (!byTool)
        observedOutputs.set(definition, byTool = new Map());
    return byTool;
}
/** Rebuilds a shape read from the cache file, or returns undefined when any part is not something inferShape writes. */
function readSavedShape(value, depth) {
    if (typeof value !== "object" || value === null || Array.isArray(value) || depth > MAX_DEPTH)
        return undefined;
    const raw = value;
    if (raw.anyOf !== undefined) {
        // Inference writes flat unions only; rejecting nested ones first keeps recursion bounded by MAX_DEPTH.
        if (!Array.isArray(raw.anyOf) || raw.anyOf.length < 2 || raw.anyOf.length > MAX_UNION
            || raw.anyOf.some(variant => typeof variant !== "object" || variant === null || "anyOf" in variant))
            return undefined;
        const variants = raw.anyOf.map(variant => readSavedShape(variant, depth));
        return variants.every(variant => variant?.type !== undefined) ? { anyOf: variants } : undefined;
    }
    if (raw.type === undefined)
        return {};
    if (typeof raw.type !== "string" || !SHAPE_TYPES.has(raw.type))
        return undefined;
    const shape = { type: raw.type };
    for (const key of ["items", "additionalProperties"]) {
        if (raw[key] === undefined)
            continue;
        const child = readSavedShape(raw[key], depth + 1);
        if (!child)
            return undefined;
        shape[key] = child;
    }
    if (raw.properties !== undefined) {
        if (typeof raw.properties !== "object" || raw.properties === null || Array.isArray(raw.properties))
            return undefined;
        const entries = Object.entries(raw.properties);
        if (entries.length > MAX_OBJECT_KEYS)
            return undefined;
        const properties = {};
        for (const [key, child] of entries) {
            const property = key !== "__proto__" && FIELD_NAME.test(key) ? readSavedShape(child, depth + 1) : undefined;
            if (!property)
                return undefined;
            properties[key] = property;
        }
        shape.properties = properties;
        shape.required = Array.isArray(raw.required)
            ? raw.required.filter((key) => typeof key === "string" && Object.hasOwn(properties, key))
            : [];
    }
    return shape;
}
function findTool(state, serverName, toolName) {
    return state.toolMetadata.get(serverName)?.find(tool => tool.originalName === toolName && !tool.resourceUri);
}
function readResultValue(result) {
    const structured = result.structuredContent;
    if (typeof structured === "object" && structured !== null)
        return { source: "structuredContent", value: structured };
    const content = result.content;
    if (!Array.isArray(content) || content.length !== 1)
        return undefined;
    const block = content[0];
    if (block.type !== "text" || typeof block.text !== "string" || block.text.length > MAX_JSON_TEXT_CHARS)
        return undefined;
    const text = block.text.trim();
    if (!text.startsWith("{") && !text.startsWith("["))
        return undefined;
    try {
        return { source: "jsonText", value: JSON.parse(text) };
    }
    catch {
        return undefined;
    }
}
function inferShape(value, depth, budget) {
    if (--budget.nodes < 0)
        return {};
    if (value === null)
        return { type: "null" };
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string")
        return { type: typeof value };
    if (typeof value !== "object" || depth >= MAX_DEPTH)
        return {};
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ARRAY_SAMPLE).map(item => inferShape(item, depth + 1, budget));
        return items.length === 0 ? { type: "array" } : { type: "array", items: items.reduce(mergeShapes) };
    }
    const record = value;
    const keys = [];
    let isMap = false;
    // Stops at the first key that makes this a map, so a huge object costs O(MAX_OBJECT_KEYS) here.
    for (const key in record) {
        if (!Object.hasOwn(record, key))
            continue;
        keys.push(key);
        // An own "__proto__" key would set the prototype of the shape's properties object instead of adding a field.
        if (keys.length > MAX_OBJECT_KEYS || !FIELD_NAME.test(key) || /\d{4}/.test(key) || key === "__proto__") {
            isMap = true;
            break;
        }
    }
    if (isMap) {
        const values = keys.slice(0, MAX_ARRAY_SAMPLE).map(key => inferShape(record[key], depth + 1, budget));
        return { type: "object", additionalProperties: values.reduce(mergeShapes) };
    }
    const properties = {};
    for (const key of keys)
        properties[key] = inferShape(record[key], depth + 1, budget);
    return { type: "object", properties, required: keys };
}
function isUnknown(shape) {
    return shape.type === undefined && shape.anyOf === undefined;
}
function mergeShapes(left, right) {
    if (isUnknown(left) || isUnknown(right))
        return {};
    const variants = [...(left.anyOf ?? [left])];
    for (const variant of right.anyOf ?? [right]) {
        const index = variants.findIndex(existing => existing.type === variant.type);
        if (index === -1)
            variants.push(variant);
        else
            variants[index] = mergeSameType(variants[index], variant);
    }
    if (variants.length > MAX_UNION)
        return {};
    return variants.length === 1 ? variants[0] : { anyOf: variants };
}
function mergeSameType(left, right) {
    if (left.type === "array") {
        const items = left.items && right.items ? mergeShapes(left.items, right.items) : left.items ?? right.items;
        return items ? { type: "array", items } : { type: "array" };
    }
    if (left.type !== "object")
        return left;
    const keys = new Set([...Object.keys(left.properties ?? {}), ...Object.keys(right.properties ?? {})]);
    if (left.additionalProperties || right.additionalProperties || keys.size > MAX_OBJECT_KEYS) {
        const values = [
            left.additionalProperties,
            right.additionalProperties,
            ...Object.values(left.properties ?? {}),
            ...Object.values(right.properties ?? {}),
        ].filter((shape) => shape !== undefined);
        return { type: "object", additionalProperties: values.reduce(mergeShapes) };
    }
    const properties = {};
    for (const key of keys) {
        const leftProperty = left.properties?.[key];
        const rightProperty = right.properties?.[key];
        properties[key] = leftProperty && rightProperty ? mergeShapes(leftProperty, rightProperty) : (leftProperty ?? rightProperty);
    }
    const rightRequired = new Set(right.required);
    return { type: "object", properties, required: (left.required ?? []).filter(key => rightRequired.has(key)) };
}
/** Drops nesting from the deepest level up until the rendered shape, which is what describe shows, fits the size bound. */
function fitShape(shape) {
    for (let depth = MAX_DEPTH; depth > 0; depth--) {
        const pruned = pruneShape(shape, depth);
        if (renderOutputShape(pruned).length <= MAX_SHAPE_CHARS)
            return pruned;
    }
    return {};
}
function pruneShape(shape, depth) {
    if (shape.anyOf) {
        const variants = shape.anyOf.map(variant => pruneShape(variant, depth));
        return variants.some(isUnknown) ? {} : { anyOf: variants };
    }
    if (shape.type !== "object" && shape.type !== "array")
        return shape;
    if (depth === 0)
        return {};
    const prune = (child) => pruneShape(child, depth - 1);
    return {
        ...shape,
        ...(shape.properties
            ? { properties: Object.fromEntries(Object.entries(shape.properties).map(([key, child]) => [key, prune(child)])) }
            : {}),
        ...(shape.items ? { items: prune(shape.items) } : {}),
        ...(shape.additionalProperties ? { additionalProperties: prune(shape.additionalProperties) } : {}),
    };
}
//# sourceMappingURL=output-shape.js.map