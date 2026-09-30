import type { McpExtensionState } from "./state.ts";
import type { ServerCacheEntry, ToolMetadata } from "./types.ts";
/**
 * Output shapes for tools that declare no outputSchema.
 * Field names and broad JSON types only, never values; every dimension is
 * bounded because inference runs on arbitrary upstream payloads after each call.
 * Script sessions also save them in the metadata cache for later sessions.
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
    /** outputShapeKey of the tool definition the shape was learned against; other definitions do not see it. */
    toolKey: string;
    /**
     * True once any observation merged into the shape was made under a private tool listing, which is tied to one
     * authorization context. Such a shape is used in this session only and never saved.
     */
    private: boolean;
}
/**
 * Looks the tool up when the call starts, so its result is recorded against the definition it was
 * requested under even if a tools/list_changed refresh replaces that definition mid-call.
 */
export declare function observedOutputRecorder(state: McpExtensionState, serverName: string, toolName: string): (result: Record<string, unknown>) => void;
/** Adds shapes from a cache entry, tagged with the entry's own tool definitions, unless this session already has one for that definition. */
export declare function seedObservedOutputs(state: McpExtensionState, serverName: string, entry: Pick<ServerCacheEntry, "tools" | "outputShapes">): void;
export declare function getObservedOutput(state: McpExtensionState, serverName: string, tool: Pick<ToolMetadata, "originalName" | "outputSchema" | "description" | "inputSchema">): ObservedOutput | undefined;
export declare function renderOutputShape(shape: OutputShape): string;
