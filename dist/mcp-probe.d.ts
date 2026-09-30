export interface McpProbeResult {
    isMcp: boolean;
    classification: string;
}
/** Makes one unauthenticated metadata-only request to identify an HTTP endpoint's protocol shape. */
export declare function probeMcpEndpoint(url: string | URL): Promise<McpProbeResult>;
