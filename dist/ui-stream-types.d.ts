import { z } from "zod";
export declare const UI_STREAM_HOST_CONTEXT_KEY = "pi-mcp-adapter/stream";
export declare const UI_STREAM_REQUEST_META_KEY = "pi-mcp-adapter/stream-token";
export declare const UI_STREAM_RESULT_PATCH_METHOD = "notifications/pi-mcp-adapter/ui-result-patch";
export declare const SERVER_STREAM_RESULT_PATCH_METHOD = "notifications/pi-mcp-adapter/result-patch";
export declare const UI_STREAM_STRUCTURED_CONTENT_KEY = "pi-mcp-adapter/stream";
export declare const uiStreamModeSchema: z.ZodEnum<{
    eager: "eager";
    "stream-first": "stream-first";
}>;
export type UiStreamMode = z.infer<typeof uiStreamModeSchema>;
export declare const visualizationStreamPhaseSchema: z.ZodEnum<{
    shell: "shell";
    narrative: "narrative";
    structure: "structure";
    detail: "detail";
    settled: "settled";
}>;
export type VisualizationStreamPhase = z.infer<typeof visualizationStreamPhaseSchema>;
export declare const visualizationStreamFrameTypeSchema: z.ZodEnum<{
    patch: "patch";
    checkpoint: "checkpoint";
    final: "final";
}>;
export type VisualizationStreamFrameType = z.infer<typeof visualizationStreamFrameTypeSchema>;
export declare const visualizationStreamStatusSchema: z.ZodEnum<{
    ok: "ok";
    error: "error";
}>;
export type VisualizationStreamStatus = z.infer<typeof visualizationStreamStatusSchema>;
export declare const uiStreamHostContextSchema: z.ZodObject<{
    mode: z.ZodEnum<{
        eager: "eager";
        "stream-first": "stream-first";
    }>;
    streamId: z.ZodString;
    intermediateResultPatches: z.ZodBoolean;
    partialInput: z.ZodBoolean;
}, z.core.$strip>;
export type UiStreamHostContext = z.infer<typeof uiStreamHostContextSchema>;
export declare const visualizationStreamEnvelopeSchema: z.ZodObject<{
    streamId: z.ZodString;
    sequence: z.ZodNumber;
    frameType: z.ZodEnum<{
        patch: "patch";
        checkpoint: "checkpoint";
        final: "final";
    }>;
    phase: z.ZodEnum<{
        shell: "shell";
        narrative: "narrative";
        structure: "structure";
        detail: "detail";
        settled: "settled";
    }>;
    status: z.ZodEnum<{
        ok: "ok";
        error: "error";
    }>;
    message: z.ZodOptional<z.ZodString>;
    spec: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    checkpoint: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type VisualizationStreamEnvelope = z.infer<typeof visualizationStreamEnvelopeSchema>;
export declare const uiStreamCallToolResultSchema: z.ZodObject<{
    content: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    structuredContent: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    isError: z.ZodOptional<z.ZodBoolean>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$loose>;
export type UiStreamCallToolResult = z.infer<typeof uiStreamCallToolResultSchema>;
export declare const uiStreamResultPatchNotificationSchema: z.ZodObject<{
    method: z.ZodLiteral<"notifications/pi-mcp-adapter/ui-result-patch">;
    params: z.ZodObject<{
        content: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
        structuredContent: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$loose>;
}, z.core.$strip>;
export type UiStreamResultPatchNotification = z.infer<typeof uiStreamResultPatchNotificationSchema>;
export declare const serverStreamResultPatchNotificationSchema: z.ZodObject<{
    method: z.ZodLiteral<"notifications/pi-mcp-adapter/result-patch">;
    params: z.ZodObject<{
        streamToken: z.ZodString;
        result: z.ZodObject<{
            content: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
            structuredContent: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            isError: z.ZodOptional<z.ZodBoolean>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$loose>;
    }, z.core.$strip>;
}, z.core.$strip>;
export type ServerStreamResultPatchNotification = z.infer<typeof serverStreamResultPatchNotificationSchema>;
export interface UiStreamSummary {
    streamId: string;
    mode: UiStreamMode;
    frames: number;
    phases: VisualizationStreamPhase[];
    finalStatus?: VisualizationStreamStatus;
    lastMessage?: string;
}
export declare function getUiStreamHostContext(hostContext: Record<string, unknown> | undefined): UiStreamHostContext | undefined;
export declare function getVisualizationStreamEnvelope(structuredContent: unknown): VisualizationStreamEnvelope | undefined;
