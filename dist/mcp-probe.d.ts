import type { ServerDefinition } from "./types.ts";
export interface McpProbeResult {
    isMcp: boolean;
    classification: string;
}
export interface McpProbeOptions {
    /** Omitted/auto probes modern first, then supported legacy transports. */
    protocolVersion?: ServerDefinition["protocolVersion"];
    signal?: AbortSignal | undefined;
}
/** Unauthenticated, metadata-only diagnostics; never forwards configured credentials. */
export declare function probeMcpEndpoint(url: string | URL, options?: McpProbeOptions): Promise<McpProbeResult>;
