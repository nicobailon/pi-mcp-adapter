import { z } from "zod";
export const UI_STREAM_HOST_CONTEXT_KEY = "pi-mcp-adapter/stream";
export const UI_STREAM_REQUEST_META_KEY = "pi-mcp-adapter/stream-token";
export const UI_STREAM_RESULT_PATCH_METHOD = "notifications/pi-mcp-adapter/ui-result-patch";
export const SERVER_STREAM_RESULT_PATCH_METHOD = "notifications/pi-mcp-adapter/result-patch";
export const UI_STREAM_STRUCTURED_CONTENT_KEY = "pi-mcp-adapter/stream";
export const uiStreamModeSchema = z.enum(["eager", "stream-first"]);
export const visualizationStreamPhaseSchema = z.enum(["shell", "narrative", "structure", "detail", "settled"]);
export const visualizationStreamFrameTypeSchema = z.enum(["patch", "checkpoint", "final"]);
export const visualizationStreamStatusSchema = z.enum(["ok", "error"]);
const looseRecordSchema = z.record(z.string(), z.unknown());
const looseArraySchema = z.array(z.unknown());
export const uiStreamHostContextSchema = z.object({
    mode: uiStreamModeSchema,
    streamId: z.string().min(1),
    intermediateResultPatches: z.boolean(),
    partialInput: z.boolean(),
});
export const visualizationStreamEnvelopeSchema = z.object({
    streamId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    frameType: visualizationStreamFrameTypeSchema,
    phase: visualizationStreamPhaseSchema,
    status: visualizationStreamStatusSchema,
    message: z.string().optional(),
    spec: looseRecordSchema.optional(),
    checkpoint: looseRecordSchema.optional(),
});
export const uiStreamCallToolResultSchema = z.object({
    content: looseArraySchema.optional(),
    structuredContent: looseRecordSchema.optional(),
    isError: z.boolean().optional(),
    _meta: looseRecordSchema.optional(),
}).passthrough();
export const uiStreamResultPatchNotificationSchema = z.object({
    method: z.literal(UI_STREAM_RESULT_PATCH_METHOD),
    params: uiStreamCallToolResultSchema,
});
export const serverStreamResultPatchNotificationSchema = z.object({
    method: z.literal(SERVER_STREAM_RESULT_PATCH_METHOD),
    params: z.object({
        streamToken: z.string().min(1),
        result: uiStreamCallToolResultSchema,
    }),
});
export function getUiStreamHostContext(hostContext) {
    const candidate = hostContext?.[UI_STREAM_HOST_CONTEXT_KEY];
    const parsed = uiStreamHostContextSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
}
export function getVisualizationStreamEnvelope(structuredContent) {
    if (!structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent)) {
        return undefined;
    }
    const candidate = structuredContent[UI_STREAM_STRUCTURED_CONTENT_KEY];
    const parsed = visualizationStreamEnvelopeSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
}
//# sourceMappingURL=ui-stream-types.js.map