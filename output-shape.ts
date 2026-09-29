import type { McpExtensionState } from "./state.ts";
import { formatPropertyName } from "./ts-shape.ts";
import type { ToolMetadata } from "./types.ts";

/**
 * Session-only output shapes for tools that declare no outputSchema.
 * Field names and broad JSON types only, never values; every dimension is
 * bounded because inference runs on arbitrary upstream payloads after each call.
 */
export interface OutputShape {
  type?: "null" | "boolean" | "number" | "string" | "object" | "array";
  properties?: Record<string, OutputShape>;
  required?: string[];
  items?: OutputShape;
  additionalProperties?: OutputShape;
  anyOf?: OutputShape[];
}

export interface ObservedOutput {
  source: "structuredContent" | "jsonText";
  shape: OutputShape;
  calls: number;
}

const MAX_DEPTH = 6;
const MAX_ARRAY_SAMPLE = 5;
// Objects wider than this are treated as maps keyed by data (ids, emails, dates), so their keys are not kept.
const MAX_OBJECT_KEYS = 40;
const MAX_UNION = 4;
const MAX_NODES_PER_CALL = 1000;
const MAX_SHAPE_BYTES = 4 * 1024;
const MAX_JSON_TEXT_BYTES = 256 * 1024;

export function recordObservedOutput(
  state: McpExtensionState,
  serverName: string,
  toolName: string,
  result: Record<string, unknown>,
): void {
  if (findTool(state, serverName, toolName)?.outputSchema !== undefined) return;
  const observed = readResultValue(result);
  if (!observed) return;
  const shape = inferShape(observed.value, 0, { nodes: MAX_NODES_PER_CALL });
  const observedOutputs = state.observedOutputs ??= new Map();
  const key = JSON.stringify([serverName, toolName]);
  const previous = observedOutputs.get(key);
  observedOutputs.set(key, previous?.source === observed.source
    ? { source: observed.source, shape: fitShape(mergeShapes(previous.shape, shape)), calls: previous.calls + 1 }
    : { source: observed.source, shape: fitShape(shape), calls: 1 });
}

export function getObservedOutput(
  state: McpExtensionState,
  serverName: string,
  tool: Pick<ToolMetadata, "originalName" | "outputSchema">,
): ObservedOutput | undefined {
  if (tool.outputSchema !== undefined) return undefined;
  const observed = state.observedOutputs?.get(JSON.stringify([serverName, tool.originalName]));
  return observed && !isUnknown(observed.shape) ? observed : undefined;
}

export function renderOutputShape(shape: OutputShape): string {
  if (shape.anyOf) return shape.anyOf.map(renderOutputShape).join(" | ");
  switch (shape.type) {
    case undefined:
      return "unknown";
    case "object": {
      if (shape.additionalProperties) return `Record<string, ${renderOutputShape(shape.additionalProperties)}>`;
      const required = new Set(shape.required);
      const properties = Object.entries(shape.properties ?? {})
        .map(([name, property]) => `${formatPropertyName(name)}${required.has(name) ? "" : "?"}: ${renderOutputShape(property)};`);
      return properties.length === 0 ? "{}" : `{ ${properties.join(" ")} }`;
    }
    case "array": {
      if (!shape.items) return "unknown[]";
      const item = renderOutputShape(shape.items);
      return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
    }
    default:
      return shape.type;
  }
}

function findTool(state: McpExtensionState, serverName: string, toolName: string): ToolMetadata | undefined {
  return state.toolMetadata.get(serverName)?.find(tool => tool.originalName === toolName && !tool.resourceUri);
}

function readResultValue(result: Record<string, unknown>): { source: ObservedOutput["source"]; value: unknown } | undefined {
  const structured = result.structuredContent;
  if (typeof structured === "object" && structured !== null) return { source: "structuredContent", value: structured };
  const content = result.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const block = content[0] as { type?: unknown; text?: unknown };
  if (block.type !== "text" || typeof block.text !== "string" || block.text.length > MAX_JSON_TEXT_BYTES) return undefined;
  const text = block.text.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    return { source: "jsonText", value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function inferShape(value: unknown, depth: number, budget: { nodes: number }): OutputShape {
  if (--budget.nodes < 0) return {};
  if (value === null) return { type: "null" };
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return { type: typeof value as "boolean" | "number" | "string" };
  if (typeof value !== "object" || depth >= MAX_DEPTH) return {};
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_SAMPLE).map(item => inferShape(item, depth + 1, budget));
    return items.length === 0 ? { type: "array" } : { type: "array", items: items.reduce(mergeShapes) };
  }
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  if (keys.length > MAX_OBJECT_KEYS) {
    const values = keys.slice(0, MAX_ARRAY_SAMPLE).map(key => inferShape(record[key], depth + 1, budget));
    return { type: "object", additionalProperties: values.reduce(mergeShapes) };
  }
  const properties: Record<string, OutputShape> = {};
  for (const key of keys) properties[key] = inferShape(record[key], depth + 1, budget);
  return { type: "object", properties, required: keys };
}

function isUnknown(shape: OutputShape): boolean {
  return shape.type === undefined && shape.anyOf === undefined;
}

function mergeShapes(left: OutputShape, right: OutputShape): OutputShape {
  if (isUnknown(left) || isUnknown(right)) return {};
  const variants = [...(left.anyOf ?? [left])];
  for (const variant of right.anyOf ?? [right]) {
    const index = variants.findIndex(existing => existing.type === variant.type);
    if (index === -1) variants.push(variant);
    else variants[index] = mergeSameType(variants[index]!, variant);
  }
  if (variants.length > MAX_UNION) return {};
  return variants.length === 1 ? variants[0]! : { anyOf: variants };
}

function mergeSameType(left: OutputShape, right: OutputShape): OutputShape {
  if (left.type === "array") {
    const items = left.items && right.items ? mergeShapes(left.items, right.items) : left.items ?? right.items;
    return items ? { type: "array", items } : { type: "array" };
  }
  if (left.type !== "object") return left;
  const keys = new Set([...Object.keys(left.properties ?? {}), ...Object.keys(right.properties ?? {})]);
  if (left.additionalProperties || right.additionalProperties || keys.size > MAX_OBJECT_KEYS) {
    const values = [
      left.additionalProperties,
      right.additionalProperties,
      ...Object.values(left.properties ?? {}),
      ...Object.values(right.properties ?? {}),
    ].filter((shape): shape is OutputShape => shape !== undefined);
    return { type: "object", additionalProperties: values.reduce(mergeShapes) };
  }
  const properties: Record<string, OutputShape> = {};
  for (const key of keys) {
    const leftProperty = left.properties?.[key];
    const rightProperty = right.properties?.[key];
    properties[key] = leftProperty && rightProperty ? mergeShapes(leftProperty, rightProperty) : (leftProperty ?? rightProperty)!;
  }
  const rightRequired = new Set(right.required);
  return { type: "object", properties, required: (left.required ?? []).filter(key => rightRequired.has(key)) };
}

/** Drops nesting from the deepest level up until the stored shape fits the size bound. */
function fitShape(shape: OutputShape): OutputShape {
  for (let depth = MAX_DEPTH; depth > 0; depth--) {
    const pruned = pruneShape(shape, depth);
    if (JSON.stringify(pruned).length <= MAX_SHAPE_BYTES) return pruned;
  }
  return {};
}

function pruneShape(shape: OutputShape, depth: number): OutputShape {
  if (shape.anyOf) {
    const variants = shape.anyOf.map(variant => pruneShape(variant, depth));
    return variants.some(isUnknown) ? {} : { anyOf: variants };
  }
  if (shape.type !== "object" && shape.type !== "array") return shape;
  if (depth === 0) return {};
  const prune = (child: OutputShape) => pruneShape(child, depth - 1);
  return {
    ...shape,
    ...(shape.properties
      ? { properties: Object.fromEntries(Object.entries(shape.properties).map(([key, child]) => [key, prune(child)])) }
      : {}),
    ...(shape.items ? { items: prune(shape.items) } : {}),
    ...(shape.additionalProperties ? { additionalProperties: prune(shape.additionalProperties) } : {}),
  };
}
