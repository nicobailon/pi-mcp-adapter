import type { McpExtensionState } from "./state.ts";
export interface ResolvedSemanticSearchSettings {
    enabled: boolean;
    allowedServers: string[];
    /** Pi classifier model as "provider/id". Unset: the first default model Pi has a credential for. */
    model?: string;
    candidateLimit: number;
    minProbability: number;
}
export declare function validateSemanticSearchSettings(value: unknown): ResolvedSemanticSearchSettings;
/** Without an explicit `allowedServers`, every enabled server may share its tool metadata. */
export declare function resolveSemanticSearchSettings(state: McpExtensionState): ResolvedSemanticSearchSettings;
