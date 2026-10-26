export declare const EXTRACTION_MODELS: readonly ["cloudflare-workers-ai/clairic", "cloudflare-ai-gateway/clairic"];
export type ExtractionModelId = typeof EXTRACTION_MODELS[number];
export type ResolvedExtractionSettings = {
    enabled: false;
} | {
    enabled: true;
    allowedServers: string[];
    model?: ExtractionModelId;
};
export declare function validateExtractionSettings(value: unknown): ResolvedExtractionSettings;
/** Settings loaded from a file were validated on load; an invalid programmatic config allows no server. */
export declare function extractionServers(settings: {
    extraction?: unknown;
} | undefined): string[];
export declare function isExtractionConfigured(settings: {
    extraction?: unknown;
} | undefined): boolean;
